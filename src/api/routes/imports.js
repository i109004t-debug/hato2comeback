import { AppError } from '../../common/http.js';
import { marshall } from '../../common/ddb.js';
import { ulid } from '../../common/ids.js';
import { listRecords, objectText, timestamp } from '../../common/records.js';
import { reconcileImport } from '../../common/import-job.js';

async function create({ runtime, body, user }) {
  const SK = `${user.sub}#${body.idempotencyKey}`;
  const existing = await runtime.store.get('IDEMP', SK);
  if (existing && existing.expires_at > runtime.now() / 1000) return { statusCode: 202, data: { import_id: existing.import_id, status: (await runtime.store.get('IMPORT', existing.import_id))?.status ?? 'RECEIVED' } };
  if ((await runtime.ses.getAccount({})).ProductionAccessEnabled !== true) throw new AppError('IMPORT_REQUIRES_PRODUCTION', 422, 'SESのサンドボックスではCSV取込を使えません。1件ずつ登録してください。');
  if ((await runtime.contactLock.get())?.owner) throw new AppError('CONTACT_IMPORT_IN_PROGRESS', 409, '宛先の登録・取込を処理中です。');
  const id = (runtime.id ?? ulid)();
  const record = { PK: 'IMPORT', SK: id, import_id: id, status: 'RECEIVED', version: 0, created_at: timestamp(runtime), created_by: user.sub, expires_at: Math.floor(runtime.now() / 1000) + 365 * 86400 };
  const idem = { PK: 'IDEMP', SK, import_id: id, expires_at: Math.floor(runtime.now() / 1000) + 86400 };
  try {
    await runtime.ddb.transactWriteItems({ TransactItems: [
      { Put: { TableName: runtime.tableName, Item: marshall(record), ConditionExpression: 'attribute_not_exists(PK)' } },
      { Put: { TableName: runtime.tableName, Item: marshall(idem), ConditionExpression: existing ? 'expires_at = :old' : 'attribute_not_exists(PK)', ...(existing ? { ExpressionAttributeValues: marshall({ ':old': existing.expires_at }) } : {}) } },
    ] });
  } catch (error) {
    if (error.name !== 'TransactionCanceledException' && error.name !== 'ConditionalCheckFailedException') throw error;
    const winner = await runtime.store.get('IDEMP', SK);
    if (!winner || winner.expires_at <= runtime.now() / 1000) throw error;
    return { statusCode: 202, data: { import_id: winner.import_id, status: (await runtime.store.get('IMPORT', winner.import_id))?.status ?? 'RECEIVED' } };
  }
  await runtime.s3.putObject({ Bucket: runtime.dataBucket, Key: `imports/staging/${id}.csv`, ContentType: 'text/csv; charset=utf-8', Body: body.text });
  const response = await runtime.lambda.invoke({ FunctionName: runtime.workerFunctionArn, InvocationType: 'Event', Payload: Buffer.from(JSON.stringify({ mode: 'import', import_id: id })) });
  if (response.StatusCode !== 202) throw new Error('Import invocation was not accepted');
  return { statusCode: 202, data: { import_id: id, status: 'RECEIVED' } };
}

async function get({ runtime, params, user, requestId }) {
  let record = await runtime.store.get('IMPORT', params.importId);
  if (!record) throw new AppError('NOT_FOUND', 404, '取込記録がありません。');
  record = await reconcileImport(runtime, record, { admin: user.roles.includes('admin'), actor: user.sub, requestId });
  let report = null;
  try { report = JSON.parse(await objectText(await runtime.s3.getObject({ Bucket: runtime.dataBucket, Key: `imports/report/${record.import_id}.json` }))); } catch (error) { if (!['NoSuchKey', 'NotFound'].includes(error.name)) throw error; }
  return { ...record, report };
}

export default { 'imports.create': create, 'imports.get': get, 'imports.list': ({ runtime, query }) => listRecords(runtime, 'IMPORT', query) };
