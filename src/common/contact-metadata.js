import { AppError } from './http.js';
import { addressHash } from './log.js';
import { normalizeEmail } from './email.js';
import { updateRecord, conflict } from './records.js';

export function contactAttributes(contact) {
  const value = JSON.parse(contact.AttributesData || '{}');
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid contact attributes');
  if (Buffer.byteLength(JSON.stringify(value)) > 1024) throw new Error('Contact attributes exceed backup limit');
  return value;
}

export async function contactMetadataKey(runtime, email) {
  const key = runtime.hmacKey ?? (await (runtime.secrets ?? runtime.secretsProvider).get('erase-hmac')).key;
  return addressHash(normalizeEmail(email).email, key);
}

export async function getContactMetadata(runtime, email) {
  return runtime.store.get('CONTACT_META', await contactMetadataKey(runtime, email));
}

export async function ensureContactMetadata(runtime, contact) {
  const hash = await contactMetadataKey(runtime, contact.EmailAddress);
  if (await runtime.store.get('ERASED', hash)) throw new AppError('ERASED_ADDRESS', 409, '完全削除された宛先です。');
  const current = await runtime.store.get('CONTACT_META', hash);
  if (current?.erased) throw new AppError('ERASED_ADDRESS', 409, '完全削除された宛先です。');
  if (current) return current;
  const attributes = contactAttributes(contact);
  try {
    return await updateRecord(runtime, 'CONTACT_META', hash, undefined, { attributes, blocked_all: false, blocked_topics: [] });
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

// SESの購読停止に加えて、アプリ側の停止と完全削除を送信直前に確認する。
export async function contactBlocked(runtime, email, topic) {
  const hash = await contactMetadataKey(runtime, email);
  if (await runtime.store.get('ERASED', hash)) return true;
  const metadata = await runtime.store.get('CONTACT_META', hash);
  return metadata?.erased === true || metadata?.blocked_all === true || metadata?.blocked_topics?.includes(topic) === true;
}

export async function eraseContactMetadata(runtime, email) {
  const hash = await contactMetadataKey(runtime, email);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const current = await runtime.store.get('CONTACT_META', hash);
    if (current?.erased) return current;
    try {
      return await updateRecord(runtime, 'CONTACT_META', hash, current, { erased: true, blocked_all: true, blocked_topics: [] }, current ? ['attributes', 'pending_attributes'] : []);
    } catch (error) { if (!conflict(error) || attempt === 4) throw error; }
  }
}
