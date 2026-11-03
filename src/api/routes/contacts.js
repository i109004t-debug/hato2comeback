import { AppError, invalid } from '../../common/http.js';
import { normalizeEmail, maskEmail } from '../../common/email.js';
import { requiresEmailMask } from '../../common/authz.js';
import { decodeSesCursor, encodeSesCursor } from '../../common/ddb.js';
import { addressHash } from '../../common/log.js';
import { timestamp } from '../../common/records.js';

export function attributes(contact) {
  const result = JSON.parse(contact.AttributesData || '{}');
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('Invalid contact attributes');
  return result;
}

function serialize(value) {
  const result = JSON.stringify(value);
  if (Buffer.byteLength(result) > 1024) throw invalid('attributes', 'MAX_BYTES');
  return result;
}

function visible(contact, user) {
  const copy = structuredClone(contact);
  if (requiresEmailMask(user)) {
    copy.EmailAddress = maskEmail(copy.EmailAddress);
    // origや自由記述の同意情報に元アドレスが残るため、閲覧者には返さない。
    delete copy.AttributesData;
  }
  return copy;
}

async function load(runtime, email) {
  try { return await runtime.ses.getContact({ ContactListName: runtime.contactList, EmailAddress: email }); } catch (error) {
    if (error.name !== 'NotFoundException') throw error;
    throw new AppError('NOT_FOUND', 404, '連絡先がありません。');
  }
}

async function list({ runtime, user, query, topics }) {
  if (query.topic && !topics.includes(query.topic)) throw invalid('topic', 'UNKNOWN_TOPIC');
  const token = decodeSesCursor(query.cursor);
  const filter = { ...(query.status ? { FilteredStatus: query.status } : {}), ...(query.topic ? { TopicFilter: { TopicName: query.topic, UseDefaultIfPreferenceUnavailable: true } } : {}) };
  const page = await runtime.ses.listContacts({ ContactListName: runtime.contactList, PageSize: query.limit, ...(Object.keys(filter).length ? { Filter: filter } : {}), ...(token ? { NextToken: token } : {}) });
  return { items: (page.Contacts ?? []).map((item) => visible(item, user)), cursor: encodeSesCursor(page.NextToken) };
}

async function get({ runtime, user, body }) {
  const contact = await load(runtime, body.email);
  let suppression = null;
  try {
    const result = await runtime.ses.getSuppressedDestination({ EmailAddress: body.email });
    const item = result.SuppressedDestination;
    if (item) suppression = { reason: item.Reason, last_update_time: item.LastUpdateTime };
  } catch (error) { if (error.name !== 'NotFoundException') throw error; }
  return { ...visible(contact, user), suppression };
}

async function create({ runtime, user, body, audit, requestId }) {
  const config = await runtime.config.get();
  if (runtime.env !== 'prod' && !config.nonprod_allowlist.includes(body.email)) throw new AppError('RECIPIENT_NOT_ALLOWED_IN_ENV', 422, 'この環境で許可されていない宛先です。');
  const owner = `manual:${requestId}`;
  await runtime.contactLock.acquire(owner);
  let uncertain = false;
  try {
    const hash = addressHash(body.email, runtime.hmacKey);
    if (await runtime.store.get('ERASED', hash)) throw new AppError('ERASED_ADDRESS', 409, '完全削除された宛先です。');
    try {
      await runtime.ses.getContact({ ContactListName: runtime.contactList, EmailAddress: body.email });
      throw new AppError('CONTACT_EXISTS', 409, '連絡先は既に登録されています。');
    } catch (error) { if (error.name !== 'NotFoundException') throw error; }
    const attrs = { v: 1, ...(body.name ? { name: body.name } : {}), consent: body.consent, origin: `manual:${user.sub}`, ...(body.orig ? { orig: body.orig } : {}) };
    const input = { ContactListName: runtime.contactList, EmailAddress: body.email, UnsubscribeAll: false, TopicPreferences: body.topics.map((TopicName) => ({ TopicName, SubscriptionStatus: 'OPT_IN' })), AttributesData: serialize(attrs) };
    uncertain = true;
    try { await runtime.ses.createContact(input); } catch (error) {
      if (error.name === 'AlreadyExistsException') { uncertain = false; throw new AppError('CONTACT_EXISTS', 409, '連絡先は既に登録されています。'); }
      throw error;
    }
    uncertain = false;
    await audit('CONTACT_CREATE', 'contact', { attributes: attrs }, body.email);
    return { statusCode: 201, data: { email_masked: maskEmail(body.email), topics: Object.fromEntries(input.TopicPreferences.map((entry) => [entry.TopicName, entry.SubscriptionStatus])) } };
  } finally {
    if (!uncertain) await runtime.contactLock.change(owner, {}, true);
  }
}

async function change(ctx) {
  const { runtime, body, user, route, audit } = ctx;
  const contact = await load(runtime, body.email);
  const attrs = attributes(contact);
  const preferences = new Map((contact.TopicPreferences ?? []).map((entry) => [entry.TopicName, entry.SubscriptionStatus]));
  let all = contact.UnsubscribeAll === true;
  let action = 'CONTACT_UPDATE';
  const before = { topics: Object.fromEntries(preferences), all };
  if (route.operation === 'contacts.unsubscribe') {
    if (body.scope === 'ALL') { all = true; delete attrs.name; }
    else preferences.set(body.scope, 'OPT_OUT');
  } else if (route.operation === 'contacts.reconsent') {
    if (await runtime.store.get('ERASED', addressHash(body.email, runtime.hmacKey))) throw new AppError('ERASED_ADDRESS', 409, '完全削除された宛先です。');
    const prior = Math.max(Date.parse(attrs.consent?.at) || 0, Date.parse(attrs.reconsent?.at) || 0);
    if (Date.parse(body.reconsent.at) <= prior) throw invalid('reconsent.at', 'NEW_CONSENT_REQUIRED');
    if (all) for (const topic of preferences.keys()) if (!body.topics.includes(topic)) preferences.set(topic, 'OPT_OUT');
    all = false;
    for (const topic of body.topics) preferences.set(topic, 'OPT_IN');
    attrs.reconsent = { ...body.reconsent, by: user.sub };
    action = 'RECONSENT';
  } else {
    for (const [topic, status] of Object.entries(body.topics ?? {})) {
      if (status === 'OPT_IN' && (all || preferences.get(topic) === 'OPT_OUT')) throw new AppError('RECONSENT_REQUIRED', 409, '管理者による再同意の記録が必要です。');
      if (status === 'OPT_IN' && !preferences.has(topic)) {
        if (!body.consent) throw invalid('consent', 'REQUIRED');
        attrs.consent = body.consent;
      }
      preferences.set(topic, status);
    }
    if (Object.hasOwn(body, 'name')) attrs.name = body.name;
  }
  const input = { ContactListName: runtime.contactList, EmailAddress: body.email, UnsubscribeAll: all, TopicPreferences: [...preferences].map(([TopicName, SubscriptionStatus]) => ({ TopicName, SubscriptionStatus })), AttributesData: serialize(attrs) };
  await runtime.ses.updateContact(input);
  await audit(action, 'contact', { before, topics: Object.fromEntries(preferences), all, attributes: attrs, reason: body.note ?? '利用者の購読変更操作' }, body.email);
  return { email_masked: maskEmail(body.email), topics: Object.fromEntries(preferences), unsubscribe_all: all };
}

async function erase({ runtime, body, audit, requestId }) {
  const owner = `erase:${requestId}`;
  await runtime.contactLock.acquire(owner);
  try {
    // 先にHMACを記録する。SES削除の結果が不明でも再登録を許可しない。
    const hash = addressHash(normalizeEmail(body.email).email, runtime.hmacKey);
    const existing = await runtime.store.get('ERASED', hash);
    if (!existing) {
      try { await runtime.store.put({ PK: 'ERASED', SK: hash, erased_at: timestamp(runtime) }); } catch (error) { if (error.name !== 'ConditionalCheckFailedException') throw error; }
    }
    try { await runtime.ses.deleteContact({ ContactListName: runtime.contactList, EmailAddress: body.email }); } catch (error) { if (error.name !== 'NotFoundException') throw error; }
    await audit('ERASE', 'contact', { note: body.note }, body.email);
    return { erased: true };
  } finally { await runtime.contactLock.change(owner, {}, true); }
}

export default { 'contacts.list': list, 'contacts.get': get, 'contacts.create': create, 'contacts.update': change, 'contacts.unsubscribe': change, 'contacts.reconsent': change, 'contacts.erase': erase };
