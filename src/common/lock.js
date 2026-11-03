import { createDdb, buildUpdate, createExpressions } from './ddb.js';
import { createTime } from './time.js';

const conflict = (error) => error.name === 'ConditionalCheckFailedException' || error.code === 'VERSION_CONFLICT';

export function createSendLock(deps) {
  const store = deps.store ?? createDdb(deps);
  const { now } = createTime(deps);
  const update = async (owner, set, release = false, live = false) => {
    const expressions = createExpressions();
    const ConditionExpression = expressions.equals('owner', owner) + (live ? ` AND ${expressions.name('expires_at_ms')} > ${expressions.value(now())}` : '');
    try {
      return await store.update('LOCK', 'SEND', {
        ConditionExpression,
        ...buildUpdate({ set, ...(release ? { remove: ['owner', 'expires_at_ms'] } : {}) }, expressions),
      });
    } catch (error) {
      if (conflict(error)) return undefined;
      throw error;
    }
  };
  return {
    get: () => store.get('LOCK', 'SEND'),
    async acquire(owner, ttlSeconds) {
      if (typeof owner !== 'string' || !owner || !Number.isFinite(ttlSeconds) || ttlSeconds <= 0) throw new TypeError('Invalid send lock');
      const expressions = createExpressions();
      const time = now();
      const ConditionExpression = `${expressions.notExists('owner')} OR ${expressions.equals('owner', owner)} OR ${expressions.name('expires_at_ms')} < ${expressions.value(time)}`;
      try {
        return await store.update('LOCK', 'SEND', {
          ConditionExpression,
          ...buildUpdate({ set: { owner, expires_at_ms: time + ttlSeconds * 1000 } }, expressions),
        });
      } catch (error) {
        if (conflict(error)) return undefined;
        throw error;
      }
    },
    async extend(owner, ttlSeconds) {
      const current = await store.get('LOCK', 'SEND');
      if (current?.owner !== owner || current.expires_at_ms <= now()) return undefined;
      return update(owner, { expires_at_ms: now() + ttlSeconds * 1000 }, false, true);
    },
    async save(owner, limiter) {
      return update(owner, {
        next_send_at_ms: limiter.next,
        ...(Number.isFinite(limiter.lastStart) ? { last_send_at_ms: limiter.lastStart } : {}),
      });
    },
    async release(owner, limiter) {
      // 項目は削除しない。次の所有者も直前の実送信間隔を引き継ぐ。
      return update(owner, limiter ? {
        next_send_at_ms: limiter.next,
        ...(Number.isFinite(limiter.lastStart) ? { last_send_at_ms: limiter.lastStart } : {}),
      } : {}, true);
    },
  };
}
