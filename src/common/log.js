import { createHmac } from 'node:crypto';
import { now as defaultNow } from './time.js';

const sensitiveKey = /email|address|^to$|^from$|^cc$|^bcc$|subject|body|token|authorization|cookie|secret|password|csv|attributes|consent|unsubscribe|^orig$|^reply.?to$|origin.?verify/i;

export function redactText(value) {
  return String(value)
    .replace(/https?:\/\/[^\s<>"']+/gi, '[REDACTED_URL]')
    .replace(/[A-Z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Z0-9.-]+/gi, '[REDACTED_EMAIL]')
    .replace(/\bBearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+){1,2}\b/g, '[REDACTED_TOKEN]')
    .replace(/\b([\w.-]*(?:token|authorization|secret|password)[\w.-]*)["']?\s*[:=]\s*["']?[^\s,;}"']+/gi, '$1=[REDACTED]');
}

export function redact(value, seen = new WeakSet()) {
  if (typeof value === 'string') return redactText(value);
  if (value === null || typeof value !== 'object') return typeof value === 'bigint' ? String(value) : value;
  if (seen.has(value)) return '[CIRCULAR]';
  seen.add(value);
  if (value instanceof Error) {
    return { name: redactText(value.name), message: redactText(value.message), stack: redactText(value.stack ?? '') };
  }
  if (Array.isArray(value)) return value.map((item) => redact(item, seen));
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [redactText(key), sensitiveKey.test(key) ? '[REDACTED]' : redact(item, seen)]));
}

export function addressHash(email, key) {
  if (!key || !email) throw new TypeError('HMAC key and normalized address are required');
  return createHmac('sha256', key).update(email).digest('hex');
}

export const addr8 = (email, key) => addressHash(email, key).slice(0, 8);

export function createLogger({ fn, req_id, now = defaultNow, write = console.log } = {}) {
  const emit = (level, msg, fields = {}) => {
    const entry = { ...redact(fields), ts: new Date(now()).toISOString(), level, fn: redactText(fn ?? ''), req_id: redactText(req_id ?? ''), msg: redactText(msg) };
    write(JSON.stringify(entry));
    return entry;
  };
  return Object.fromEntries(['debug', 'info', 'warn', 'error'].map((level) => [level, (msg, fields) => emit(level, msg, fields)]));
}
