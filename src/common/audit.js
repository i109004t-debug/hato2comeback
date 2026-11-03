import { ulid } from './ids.js';
import { now as defaultNow, unixSeconds } from './time.js';
import { addressHash, redactText } from './log.js';
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

export function assertRecoveryAudit({ action, addr_id, details }) {
  if (!['CONTACT_STOP', 'ERASE'].includes(action)) return;
  if (typeof addr_id !== 'string' || !/^[a-f0-9]{64}$/.test(addr_id) || typeof details?.operation !== 'string' || !details.operation.trim() || typeof details.scope !== 'string' || !/^(?:ALL|[a-z0-9_]{1,20})$/.test(details.scope)) throw new TypeError('Incomplete recovery audit');
  if (action === 'ERASE' && (details.scope !== 'ALL' || typeof details.erase_mac !== 'string' || !/^[a-f0-9]{64}$/.test(details.erase_mac))) throw new TypeError('Incomplete erase audit');
}

export function createAuditItem({ actor_sub, action, target, result, request_id, email, addr_id, details }, { now = defaultNow, id = ulid, hmacKey } = {}) {
  if ([actor_sub, action, target, result, request_id].some((value) => typeof value !== 'string' || !value)) throw new TypeError('Audit fields are required');
  if (addr_id !== undefined && !/^[a-f0-9]{64}$/.test(addr_id)) throw new TypeError('Invalid audit recipient identifier');
  const recipient = email ? addressHash(normalizeEmail(email).email, hmacKey) : addr_id;
  if (addr_id && recipient !== addr_id) throw new TypeError('Audit recipient mismatch');
  assertRecoveryAudit({ action, addr_id: recipient, details });
  const time = now();
  const ts = new Date(time).toISOString();
  return {
    ...redactAudit({ actor_sub, action, target, result, request_id, ...(details ? { details } : {}) }),
    PK: `AUDIT#${ts.slice(0, 7).replace('-', '')}`,
    SK: `${ts}#${id()}`,
    ts,
    ...(recipient ? { addr_id: recipient } : {}),
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
