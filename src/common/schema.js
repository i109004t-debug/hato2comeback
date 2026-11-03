import { AppError } from './http.js';
import { buildUpdate, createExpressions } from './ddb.js';

export function assertSupportedSchema(item) {
  if (item && item.schema_version !== 1) throw new AppError('UNSUPPORTED_SCHEMA', 409, '対応していない版の記録です。');
  return item;
}

export function apiSchemaStore(store) {
  const check = (PK, item) => ['CAMPAIGN', 'IMPORT'].includes(PK) ? assertSupportedSchema(item) : item;
  return {
    ...store,
    async get(PK, SK) { return check(PK, await store.get(PK, SK)); },
    async *queryPages(input) {
      for await (const page of store.queryPages(input)) {
        for (const item of page.items) check(item.PK, item);
        yield page;
      }
    },
  };
}

// 未知の内容には触れず、版と楽観ロックを条件に安全側の状態だけを保存する。
export async function reviewUnsupportedSchema(runtime, item) {
  if (!item || item.schema_version === 1) return false;
  if (item.status === 'NEEDS_REVIEW' && (item.review?.reason === 'UNSUPPORTED_SCHEMA' || item.error_code === 'UNSUPPORTED_SCHEMA')) return true;
  const expressions = createExpressions();
  const version = item.version === undefined ? expressions.notExists('version') : expressions.equals('version', item.version);
  const schema = item.schema_version === undefined ? expressions.notExists('schema_version') : expressions.equals('schema_version', item.schema_version);
  await runtime.store.update(item.PK, item.SK, {
    ConditionExpression: `${version} AND ${schema}`,
    ...buildUpdate({ set: { status: 'NEEDS_REVIEW', ...(item.PK === 'CAMPAIGN' ? { review: { reason: 'UNSUPPORTED_SCHEMA' } } : { error_code: 'UNSUPPORTED_SCHEMA' }), version: (item.version ?? 0) + 1, updated_at: new Date(runtime.now()).toISOString() } }, expressions),
  });
  await runtime.record(item.campaign_id ?? item.import_id, 'NEEDS_REVIEW', 'UNSUPPORTED_SCHEMA');
  await runtime.notify('UNSUPPORTED_SCHEMA', item.campaign_id ?? item.import_id);
  return true;
}
