import { AppError } from './http.js';
import { addressHash } from './log.js';
import { normalizeEmail } from './email.js';
import { updateRecord, conflict } from './records.js';
import { isErased } from './erase.js';
import { validateConsent } from './validate.js';

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
  if (await isErased(runtime, email)) return true;
  const metadata = await runtime.store.get('CONTACT_META', hash);
  return metadata?.registration_state !== 'ACTIVE' || metadata.erased === true || metadata.blocked_all === true || metadata.blocked_topics?.includes(topic) === true;
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
