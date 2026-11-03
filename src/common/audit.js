import { ulid } from './ids.js';
import { now as defaultNow, unixSeconds } from './time.js';
import { addr8, redactText } from './log.js';
import { normalizeEmail } from './email.js';
import { marshall } from './ddb.js';

function redactAudit(value) {
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) return value.map(redactAudit);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [redactText(key), /email|^orig$|token|authorization|subject|body|csv|unsubscribe/i.test(key) ? '[REDACTED]' : redactAudit(item)]));
  }
  return value;
}

export function createAuditItem({ actor_sub, action, target, result, request_id, email, details }, { now = defaultNow, id = ulid, hmacKey } = {}) {
  if ([actor_sub, action, target, result, request_id].some((value) => typeof value !== 'string' || !value)) throw new TypeError('Audit fields are required');
  const time = now();
  const ts = new Date(time).toISOString();
  return {
    ...redactAudit({ actor_sub, action, target, result, request_id, ...(details ? { details } : {}) }),
    PK: `AUDIT#${ts.slice(0, 7).replace('-', '')}`,
    SK: `${ts}#${id()}`,
    ts,
    ...(email ? { addr8: addr8(normalizeEmail(email).email, hmacKey) } : {}),
    expires_at: unixSeconds(time) + 365 * 86400,
  };
}

export function createAudit(deps) {
  return {
    build: (entry) => createAuditItem(entry, deps),
    async write(entry) {
      const item = createAuditItem(entry, deps);
      await deps.ddb.putItem({ TableName: deps.tableName, Item: marshall(item), ConditionExpression: 'attribute_not_exists(PK)' });
      return item;
    },
  };
}
