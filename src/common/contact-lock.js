import { buildUpdate, createExpressions } from './ddb.js';
import { conflict, timestamp } from './records.js';
import { AppError } from './http.js';

export function createContactLock(runtime) {
  return {
    get: () => runtime.store.get('LOCK', 'CONTACT_CREATE'),
    async acquire(owner) {
      const expressions = createExpressions();
      const ConditionExpression = expressions.notExists('owner');
      try {
        return await runtime.store.update('LOCK', 'CONTACT_CREATE', {
          ConditionExpression,
          ...buildUpdate({ set: { owner, state: 'CHECKING', acquired_at: timestamp(runtime) } }, expressions),
        });
      } catch (error) {
        if (conflict(error)) throw new AppError('CONTACT_IMPORT_IN_PROGRESS', 409, '宛先の登録・取込を処理中です。');
        throw error;
      }
    },
    async change(owner, set = {}, release = false) {
      const expressions = createExpressions();
      return runtime.store.update('LOCK', 'CONTACT_CREATE', {
        ConditionExpression: expressions.equals('owner', owner),
        ...buildUpdate({ set: { ...set, checked_at: timestamp(runtime) }, ...(release ? { remove: ['owner', 'job_id', 'state', 'acquired_at'] } : {}) }, expressions),
      });
    },
  };
}
