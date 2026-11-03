import { AppError, invalid } from '../../common/http.js';
import { maskEmail } from '../../common/email.js';
import { requiresEmailMask } from '../../common/authz.js';
import { decodeSesCursor, encodeSesCursor } from '../../common/ddb.js';
import { addressHash } from '../../common/log.js';
import { timestamp, updateRecord } from '../../common/records.js';
import { contactAttributes, getContactMetadata, ensureContactMetadata, applyContactMetadata, eraseContactMetadata, contactDeliveryStatus, batchContactMetadata } from '../../common/contact-metadata.js';
import { isErased, eraseMatch } from '../../common/erase.js';
import { deleteDeliveryIndex } from '../../common/storage.js';
import { deliveryEvents } from '../../common/delivery-events.js';
import { contactMetadataKey } from '../../common/contact-metadata.js';

export const attributes = contactAttributes;

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

async function list({ runtime, user, query, topics, topicDefinitions }) {
  if (query.topic && !topics.includes(query.topic)) throw invalid('topic', 'UNKNOWN_TOPIC');
  const token = decodeSesCursor(query.cursor);
  // ローカル停止はSESのOPT_OUT検索には現れないため、停止検索ではSES側の絞込みをしない。
  const filter = { ...(query.status === 'OPT_IN' ? { FilteredStatus: query.status } : {}), ...(query.topic ? { TopicFilter: { TopicName: query.topic, UseDefaultIfPreferenceUnavailable: true } } : {}) };
  const page = await runtime.ses.listContacts({ ContactListName: runtime.contactList, PageSize: query.limit, ...(Object.keys(filter).length ? { Filter: filter } : {}), ...(token ? { NextToken: token } : {}) });
  const items = [];
  const records = await batchContactMetadata(runtime, page.Contacts ?? []);
  for (const item of page.Contacts ?? []) {
    const metadata = records.get(await contactMetadataKey(runtime, item.EmailAddress));
    if (metadata?.erased) continue;
    const effective = applyContactMetadata(item, metadata);
    const status = effective.UnsubscribeAll ? 'OPT_OUT' : query.topic ? effective.TopicPreferences?.find((entry) => entry.TopicName === query.topic)?.SubscriptionStatus ?? topicDefinitions.find((topic) => topic.TopicName === query.topic)?.DefaultSubscriptionStatus ?? 'OPT_OUT' : 'OPT_IN';
    if (query.status && status && status !== query.status) continue;
    items.push({ ...visible(effective, user), ...contactDeliveryStatus(item, metadata, topicDefinitions) });
  }
  return { items, cursor: encodeSesCursor(page.NextToken) };
}

async function get({ runtime, user, body, topicDefinitions }) {
  const loaded = await load(runtime, body.email);
  const metadata = await getContactMetadata(runtime, body.email);
  const erased = await isErased(runtime, body.email);
  const contact = applyContactMetadata(loaded, erased ? { ...metadata, erased: true } : metadata ?? { attributes: {} });
  let suppression = null;
  try {
    const result = await runtime.ses.getSuppressedDestination({ EmailAddress: body.email });
    const item = result.SuppressedDestination;
    if (item) suppression = { reason: item.Reason, last_update_time: item.LastUpdateTime };
  } catch (error) { if (error.name !== 'NotFoundException') throw error; }
  return { ...visible(contact, user), ...contactDeliveryStatus(loaded, metadata, topicDefinitions, { erased }), suppression };
}

async function events(ctx) {
  const contact = await get(ctx);
  const rid = await contactMetadataKey(ctx.runtime, ctx.body.email);
  return { ...contact, events: await deliveryEvents(ctx.runtime, rid) };
}

async function create({ runtime, user, body, audit, requestId }) {
  const config = await runtime.config.get();
  if (runtime.env !== 'prod' && !config.nonprod_allowlist.includes(body.email)) throw new AppError('RECIPIENT_NOT_ALLOWED_IN_ENV', 422, 'この環境で許可されていない宛先です。');
  const owner = `manual:${requestId}`;
  await runtime.contactLock.acquire(owner);
  let uncertain = false;
  try {
    const hash = addressHash(body.email, runtime.hmacKey);
    if (await isErased(runtime, body.email)) throw new AppError('ERASED_ADDRESS', 409, '完全削除された宛先です。');
    try {
      await runtime.ses.getContact({ ContactListName: runtime.contactList, EmailAddress: body.email });
      throw new AppError('CONTACT_EXISTS', 409, '連絡先は既に登録されています。');
    } catch (error) { if (error.name !== 'NotFoundException') throw error; }
    if (await getContactMetadata(runtime, body.email)) throw new AppError('CONTACT_EXISTS', 409, '連絡先の保存済み記録があります。管理者が状態を確認してください。');
    const attrs = { v: 1, ...(body.name ? { name: body.name } : {}), consent: body.consent, origin: `manual:${user.sub}` };
    const input = { ContactListName: runtime.contactList, EmailAddress: body.email, UnsubscribeAll: false, TopicPreferences: body.topics.map((TopicName) => ({ TopicName, SubscriptionStatus: 'OPT_IN' })), AttributesData: serialize({ ...attrs, ...(body.orig ? { orig: body.orig } : {}) }) };
    const pending = await updateRecord(runtime, 'CONTACT_META', hash, undefined, { kid: runtime.addressSecret.kid, attributes: {}, pending_attributes: attrs, registration_state: 'PENDING', blocked_all: true, blocked_topics: [] });
    uncertain = true;
    try { await runtime.ses.createContact(input); } catch (error) {
      if (error.name === 'AlreadyExistsException') {
        uncertain = false;
        // 新規作成に失敗した入力を、既存会員の同意正本として採用しない。
        const existing = await load(runtime, body.email);
        await updateRecord(runtime, 'CONTACT_META', hash, pending, { attributes: attributes(existing), registration_state: 'CONFLICT', blocked_all: true }, ['pending_attributes']);
        throw new AppError('CONTACT_EXISTS', 409, '連絡先は既に登録されています。管理者が登録競合を確認してください。');
      }
      throw error;
    }
    uncertain = false;
    await updateRecord(runtime, 'CONTACT_META', hash, pending, { attributes: attrs, registration_state: 'ACTIVE', blocked_all: false }, ['pending_attributes']);
    await audit('CONTACT_CREATE', 'contact', { attributes: attrs }, body.email);
    return { statusCode: 201, data: { email_masked: maskEmail(body.email), topics: Object.fromEntries(input.TopicPreferences.map((entry) => [entry.TopicName, entry.SubscriptionStatus])) } };
  } finally {
    if (!uncertain) await runtime.contactLock.change(owner, {}, true);
  }
}

async function change(ctx) {
  const { runtime, body, user, route, audit, topics } = ctx;
  const loaded = await load(runtime, body.email);
  const reconsenting = route.operation === 'contacts.reconsent';
  let metadata = await ensureContactMetadata(runtime, { ...loaded, EmailAddress: body.email }, { newConsent: reconsenting, pending: reconsenting });
  const contact = applyContactMetadata(loaded, metadata);
  // 結果不明の登録を再同意で復旧する場合は、SES実在データと今回の新しい同意だけを採用する。
  const attrs = metadata.registration_state === 'PENDING' && route.operation === 'contacts.reconsent' ? attributes(loaded) : structuredClone(metadata.attributes);
  const preferences = new Map((contact.TopicPreferences ?? []).map((entry) => [entry.TopicName, entry.SubscriptionStatus]));
  let all = contact.UnsubscribeAll === true;
  let action = 'CONTACT_UPDATE';
  const before = { topics: Object.fromEntries(preferences), all, ...(metadata.registration_state ? { registration_state: metadata.registration_state } : {}) };
  const blocked = new Set(metadata.blocked_topics ?? []);
  let blockedAll = metadata.blocked_all === true;
  if (route.operation === 'contacts.unsubscribe') {
    action = 'CONTACT_STOP';
    if (body.scope === 'ALL') { all = true; blockedAll = true; delete attrs.name; }
    else { preferences.set(body.scope, 'OPT_OUT'); blocked.add(body.scope); }
  } else if (route.operation === 'contacts.reconsent') {
    if (await isErased(runtime, body.email)) throw new AppError('ERASED_ADDRESS', 409, '完全削除された宛先です。');
    const prior = Math.max(Date.parse(attrs.consent?.at) || 0, Date.parse(attrs.reconsent?.at) || 0);
    if (Date.parse(body.reconsent.at) <= prior) throw invalid('reconsent.at', 'NEW_CONSENT_REQUIRED');
    // SESには条件付き更新がない。明示的に再同意されたトピック以外は必ず停止する。
    for (const topic of new Set([...topics, ...preferences.keys()])) preferences.set(topic, 'OPT_OUT');
    all = false;
    for (const topic of body.topics) preferences.set(topic, 'OPT_IN');
    attrs.reconsent = { ...body.reconsent, by: user.sub };
    serialize(attrs);
    // 結果不明・同時停止の場合は、送信を止めた状態を保持する。
    metadata = await updateRecord(runtime, 'CONTACT_META', metadata.SK, metadata, { blocked_all: true });
    await runtime.ses.updateContact({ ContactListName: runtime.contactList, EmailAddress: body.email, UnsubscribeAll: false, TopicPreferences: [...preferences].map(([TopicName, SubscriptionStatus]) => ({ TopicName, SubscriptionStatus })), AttributesData: serialize(attrs) });
    blockedAll = false;
    blocked.clear();
    for (const topic of preferences.keys()) if (!body.topics.includes(topic)) blocked.add(topic);
    action = 'RECONSENT';
  } else {
    for (const [topic, status] of Object.entries(body.topics ?? {})) {
      if (status === 'OPT_IN' && (all || preferences.get(topic) !== 'OPT_IN')) throw new AppError('RECONSENT_REQUIRED', 409, '管理者による再同意の記録が必要です。');
      if (status === 'OPT_OUT') blocked.add(topic);
      preferences.set(topic, status);
    }
    if (Object.hasOwn(body, 'name')) attrs.name = body.name;
  }
  serialize(attrs);
  const stops = route.operation === 'contacts.unsubscribe' ? [body.scope] : Object.entries(body.topics ?? {}).filter(([, status]) => status === 'OPT_OUT').map(([topic]) => topic);
  for (const scope of stops) await audit('CONTACT_STOP', 'contact', { scope, operation: route.operation === 'contacts.unsubscribe' ? 'UNSUBSCRIBE' : 'UPDATE' }, body.email);
  await updateRecord(runtime, 'CONTACT_META', metadata.SK, metadata, { attributes: attrs, blocked_all: blockedAll, blocked_topics: [...blocked].sort(), ...(action === 'RECONSENT' ? { registration_state: 'ACTIVE' } : {}) }, action === 'RECONSENT' ? ['pending_attributes'] : []);
  if (action !== 'CONTACT_STOP') await audit(action, 'contact', { before, topics: Object.fromEntries(preferences), all, attributes: attrs, reason: body.note ?? '利用者の購読変更操作' }, body.email);
  return { email_masked: maskEmail(body.email), topics: Object.fromEntries(preferences), unsubscribe_all: all };
}

async function erase({ runtime, body, audit, requestId }) {
  const owner = `erase:${requestId}`;
  await runtime.contactLock.acquire(owner);
  try {
    // 先にHMACを記録する。SES削除の結果が不明でも再登録を許可しない。
    const hash = await eraseMatch(runtime, body.email);
    // 途中で失敗しても、復元で削除の指示を失わないよう先に保管経路へ渡す。
    await audit('ERASE', 'contact', { note: body.note, erase_mac: hash, scope: 'ALL', operation: 'ERASE' }, body.email);
    const existing = await runtime.store.get('ERASED', hash);
    if (!existing) {
      try { await runtime.store.put({ PK: 'ERASED', SK: hash, addr_id: addressHash(body.email, runtime.hmacKey), erased_at: timestamp(runtime) }); } catch (error) { if (error.name !== 'ConditionalCheckFailedException') throw error; }
    }
    await eraseContactMetadata(runtime, body.email);
    try { await runtime.ses.deleteContact({ ContactListName: runtime.contactList, EmailAddress: body.email }); } catch (error) { if (error.name !== 'NotFoundException') throw error; }
    await deleteDeliveryIndex(runtime, addressHash(body.email, runtime.hmacKey));
    try {
      const response = await runtime.lambda.invoke({ FunctionName: runtime.workerFunctionArn, InvocationType: 'Event', Payload: Buffer.from(JSON.stringify({ mode: 'erase-suppression', email: body.email, erase_mac: hash })) });
      if (response.StatusCode !== 202) throw new Error('Suppression deletion was not accepted');
    } catch (error) { await runtime.notify('ERASE_SUPPRESSION_FAILED', 'contact'); throw error; }
    return { erased: true, suppression: 'REQUESTED', retention: { imports_days: 7, snapshots_days: 30, backups_days: 90, event_logs_days: 90, max_days: 90 } };
  } finally { await runtime.contactLock.change(owner, {}, true); }
}

export default { 'contacts.list': list, 'contacts.get': get, 'contacts.events': events, 'contacts.create': create, 'contacts.update': change, 'contacts.unsubscribe': change, 'contacts.reconsent': change, 'contacts.erase': erase };
