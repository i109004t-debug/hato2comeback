import { AppError } from './http.js';
import { addressHash } from './log.js';
import { normalizeEmail } from './email.js';
import { updateRecord, conflict } from './records.js';
import { isErased } from './erase.js';
import { validateConsent } from './validate.js';
import { marshall, unmarshall } from './ddb.js';

export function hasConsentRecord(metadata) {
  return metadata?.registration_state === 'ACTIVE';
}

// SESでトピック絞込済みの準備では、未指定の購読状態にOPT_INを渡す。
export function contactSendability(metadata, topic, { contact, defaultStatus = 'OPT_OUT', erased = false } = {}) {
  const reasons = [];
  if (erased || metadata?.erased === true) reasons.push('ERASED');
  if (!hasConsentRecord(metadata)) reasons.push(metadata?.registration_state === 'PENDING' ? 'REGISTRATION_PENDING' : metadata?.registration_state === 'CONFLICT' ? 'REGISTRATION_CONFLICT' : 'NO_CONSENT_RECORD');
  if (metadata?.blocked_all === true) reasons.push('BLOCKED_ALL');
  if (metadata?.blocked_topics?.includes(topic) === true) reasons.push('BLOCKED_TOPIC');
  if (contact) {
    if (contact.UnsubscribeAll === true) reasons.push('SES_UNSUBSCRIBED_ALL');
    const preferences = (contact.TopicPreferences ?? []).filter((entry) => entry.TopicName === topic);
    const subscribed = preferences.length ? preferences.every((entry) => entry.SubscriptionStatus === 'OPT_IN') : defaultStatus === 'OPT_IN';
    if (!subscribed) reasons.push('SES_UNSUBSCRIBED_TOPIC');
  }
  return { sendable: reasons.length === 0, reasons };
}

export function contactDeliveryStatus(contact, metadata, topics, options = {}) {
  const sendability = Object.fromEntries(topics.map((topic) => [topic.TopicName, contactSendability(metadata, topic.TopicName, { ...options, contact, defaultStatus: topic.DefaultSubscriptionStatus })]));
  return { sendable: Object.values(sendability).some((item) => item.sendable), sendability };
}

export async function batchContactMetadata(runtime, contacts) {
  const hashes = [...new Set(await Promise.all(contacts.map((contact) => contactMetadataKey(runtime, contact.EmailAddress))))];
  const metadata = new Map();
  for (let offset = 0; offset < hashes.length; offset += 100) {
    const response = await runtime.ddb.batchGetItem({ RequestItems: { [runtime.tableName]: { Keys: hashes.slice(offset, offset + 100).map((SK) => marshall({ PK: 'CONTACT_META', SK })), ConsistentRead: true } } });
    if (Object.values(response.UnprocessedKeys ?? {}).some((item) => item.Keys?.length)) throw new Error('Unprocessed contact metadata keys');
    for (const item of response.Responses?.[runtime.tableName] ?? []) {
      const value = unmarshall(item);
      metadata.set(value.SK, value);
    }
  }
  return metadata;
}

export function contactAttributes(contact) {
  const value = JSON.parse(contact.AttributesData || '{}');
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid contact attributes');
  if (Buffer.byteLength(JSON.stringify(value)) > 1024) throw new Error('Contact attributes exceed backup limit');
  delete value.orig;
  if (value.consent) validateConsent(value.consent);
  if (value.reconsent) validateConsent({ at: value.reconsent.at, source: value.reconsent.source });
  return value;
}

export async function contactIdentity(runtime, email) {
  const secret = runtime.addressSecret ?? await (runtime.secrets ?? runtime.secretsProvider).get('address-hmac');
  return { addr_id: addressHash(normalizeEmail(email).email, secret.key), kid: secret.kid };
}

export async function contactMetadataKey(runtime, email) {
  return (await contactIdentity(runtime, email)).addr_id;
}

export async function getContactMetadata(runtime, email) {
  return runtime.store.get('CONTACT_META', await contactMetadataKey(runtime, email));
}

export async function ensureContactMetadata(runtime, contact, { newConsent = false, pending = false } = {}) {
  const { addr_id: hash, kid } = await contactIdentity(runtime, contact.EmailAddress);
  if (await isErased(runtime, contact.EmailAddress)) throw new AppError('ERASED_ADDRESS', 409, '完全削除された宛先です。');
  const current = await runtime.store.get('CONTACT_META', hash);
  if (current?.erased) throw new AppError('ERASED_ADDRESS', 409, '完全削除された宛先です。');
  if (current) return current;
  if ((await runtime.store.get('LOCK', 'CONTACT_CREATE'))?.owner?.startsWith('rekey:')) throw new AppError('CONTACT_IMPORT_IN_PROGRESS', 409, '鍵の入れ替えを処理中です。');
  if (!newConsent && (await runtime.store.get('SETTINGS', 'REKEY'))?.source === 'BACKUP') throw new AppError('RECONSENT_REQUIRED', 409, '復旧後に記録のない宛先は、新しい同意を確認して再同意を登録してください。');
  const attributes = contactAttributes(contact);
  try {
    return await updateRecord(runtime, 'CONTACT_META', hash, undefined, { kid, attributes, registration_state: pending ? 'PENDING' : 'ACTIVE', blocked_all: pending, blocked_topics: [] });
  } catch (error) {
    if (!conflict(error)) throw error;
    const latest = await runtime.store.get('CONTACT_META', hash);
    if (!latest || latest.erased) throw new AppError('ERASED_ADDRESS', 409, '完全削除された宛先です。');
    return latest;
  }
}

export function applyContactMetadata(contact, metadata) {
  if (!metadata) return structuredClone(contact);
  const preferences = new Map((contact.TopicPreferences ?? []).map((entry) => [entry.TopicName, entry.SubscriptionStatus]));
  for (const topic of metadata.blocked_topics ?? []) preferences.set(topic, 'OPT_OUT');
  return {
    ...contact,
    UnsubscribeAll: contact.UnsubscribeAll === true || metadata.blocked_all === true || metadata.erased === true,
    TopicPreferences: [...preferences].map(([TopicName, SubscriptionStatus]) => ({ TopicName, SubscriptionStatus })),
    AttributesData: JSON.stringify(metadata.erased ? {} : metadata.attributes ?? {}),
  };
}

// 同意の正本、アプリ側の停止と完全削除を送信直前に確認する。
export async function contactBlocked(runtime, email, topic) {
  const hash = await contactMetadataKey(runtime, email);
  const erased = await isErased(runtime, email);
  const metadata = erased ? undefined : await runtime.store.get('CONTACT_META', hash);
  return !contactSendability(metadata, topic, { erased }).sendable;
}

export async function eraseContactMetadata(runtime, email) {
  const { addr_id: hash, kid } = await contactIdentity(runtime, email);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const current = await runtime.store.get('CONTACT_META', hash);
    if (current?.erased) return current;
    try {
      return await updateRecord(runtime, 'CONTACT_META', hash, current, { kid, erased: true, blocked_all: true, blocked_topics: [] }, current ? ['attributes', 'pending_attributes'] : []);
    } catch (error) { if (!conflict(error) || attempt === 4) throw error; }
  }
}
