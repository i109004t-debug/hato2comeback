import { ulid } from '../../common/ids.js';
import { AppError, invalid } from '../../common/http.js';
import { DELIVERY_CASES } from '../../common/precheck.js';
import { acceptanceHashes, openCheck, deliveryStatus } from '../../common/acceptance.js';
import { allRecords, updateRecord, timestamp } from '../../common/records.js';
import { marshall } from '../../common/ddb.js';
import { redactText } from '../../common/log.js';

const names = ['送信の開始前検査', '1日の送信上限', '拒否された送信の停止', '遅延と記録の欠測', '主要事業者での受信と認証', 'ワンクリック解除', 'フッターからの解除', '想定規模での送信', '試験用アドレスの配送記録', 'バックアップからの復元', '宛先別の配送記録', '抑止リストの配送停止', '評判の警報で停止', '日本語と長い本文の表示', 'DNSと認証の異常', '送信枠と排他', '送信速度と再開', '配送イベントの分類', '購読変更の重複と順序', '配送記録の欠測', '配送記録の保管の異常', 'TLSと解除ヘッダーの署名', '受入記録の失効と取込の競合'];
export const CASE_GUIDE = DELIVERY_CASES.map((id, i) => ({ id, title: names[i], automatic: false }));
const caseId = (id) => { if (!/^T-\d{2}$/.test(id)) throw invalid('case_id'); return id; };
const orgRecord = async (runtime) => {
  const org = await runtime.store.get('SETTINGS', 'ORG');
  if (!org) throw new AppError('SETTINGS_INCOMPLETE', 422, '組織設定を保存してください。');
  return org;
};

async function get({ runtime }) {
  const org = await runtime.store.get('SETTINGS', 'ORG') ?? {};
  const checks = [];
  for await (const record of allRecords(runtime, 'ACCEPTANCE')) if (record.status === 'OPEN' && record.expires_at > runtime.now() / 1000) checks.push(record);
  const config = await runtime.config.get();
  return { delivery_check: deliveryStatus(runtime, org.delivery_check, config.delivery_check_max_age_days), checks, required_cases: CASE_GUIDE };
}

async function start({ runtime, user }) {
  const org = await orgRecord(runtime);
  const id = (runtime.id ?? ulid)();
  const record = { PK: 'ACCEPTANCE', SK: id, check_id: id, schema_version: 1, status: 'OPEN', started_by: user.sub, started_at: timestamp(runtime), ...await acceptanceHashes(runtime, org), cases: {}, test_sends: [], expires_at: Math.floor(runtime.now() / 1000) + 30 * 86400, version: 0 };
  await runtime.store.put(record);
  return { statusCode: 201, data: record };
}

async function saveCase({ runtime, params, body }) {
  const check = await openCheck(runtime, params.checkId);
  const id = caseId(params.caseId);
  return updateRecord(runtime, 'ACCEPTANCE', check.check_id, check, { cases: { ...check.cases, [id]: { ...check.cases[id], ...body, note: redactText(body.note), evidence: check.cases[id]?.evidence ?? [] } } });
}

export function evidenceBytes(value) {
  if (typeof value !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw invalid('content_base64');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length > 1024 * 1024) throw new AppError('EVIDENCE_TOO_LARGE', 413, '証跡のファイルは1MiB以下にしてください。');
  if (!bytes.length || bytes.toString('base64') !== value) throw invalid('content_base64');
  return bytes;
}

async function evidence({ runtime, params, body }) {
  const check = await openCheck(runtime, params.checkId);
  const id = caseId(body.case_id);
  const bytes = evidenceBytes(body.content_base64);
  const name = body.file_name.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '').slice(0, 100) || 'evidence';
  const key = `delivery-checks/${check.check_id}/${id}/${(runtime.id ?? ulid)()}-${name}`;
  await runtime.s3.putObject({ Bucket: runtime.dataBucket, Key: key, ContentType: 'application/octet-stream', Body: bytes });
  return updateRecord(runtime, 'ACCEPTANCE', check.check_id, check, { cases: { ...check.cases, [id]: { result: 'NA', note: '', ...check.cases[id], evidence: [...(check.cases[id]?.evidence ?? []), key] } } });
}

async function submit({ runtime, params, body, user }) {
  const check = await openCheck(runtime, params.checkId);
  const org = await orgRecord(runtime);
  const hashes = await acceptanceHashes(runtime, org);
  if (hashes.config_hash !== check.config_hash || hashes.dns_config_hash !== check.dns_config_hash) throw new AppError('CHECK_HASH_CHANGED', 409, '送信設定が変わりました。新しい検査を始めてください。');
  const failed = DELIVERY_CASES.some((id) => check.cases[id]?.result === 'FAIL');
  const keys = [];
  if (!failed) {
    for (const id of DELIVERY_CASES) {
      const item = check.cases[id];
      if (item?.result !== 'PASS' || !item.evidence?.length) throw new AppError('DELIVERY_CHECK_REQUIRED', 422, '必須試験と証跡をそろえてください。');
      for (const key of item.evidence) {
        if (!key.startsWith(`delivery-checks/${check.check_id}/${id}/`) || key.split('/').includes('..')) throw new AppError('DELIVERY_CHECK_REQUIRED', 422, '検査の証跡を確認してください。');
        try { await runtime.s3.headObject({ Bucket: runtime.dataBucket, Key: key }); } catch { throw new AppError('DELIVERY_CHECK_REQUIRED', 422, '証跡がありません。'); }
        keys.push(key);
      }
    }
  }
  const record = { check_id: check.check_id, status: failed ? 'FAIL' : 'PASS', ...hashes, cases: Object.fromEntries(Object.entries(check.cases).map(([id, item]) => [id, item.result])), evidence_keys: [...new Set(keys)], note: redactText(body.note), passed_at: timestamp(runtime), by: user.sub, expiry_notified: [] };
  const { expires_at, ...submitted } = check;
  try { await runtime.ddb.transactWriteItems({ TransactItems: [
    { Put: { TableName: runtime.tableName, Item: marshall({ ...org, delivery_check: record, version: org.version + 1, updated_at: timestamp(runtime) }), ConditionExpression: '#v = :v', ExpressionAttributeNames: { '#v': 'version' }, ExpressionAttributeValues: marshall({ ':v': org.version }) } },
    { Put: { TableName: runtime.tableName, Item: marshall({ ...submitted, status: 'SUBMITTED', version: check.version + 1, submitted_by: user.sub, submitted_at: timestamp(runtime) }), ConditionExpression: '#v = :v AND #s = :s', ExpressionAttributeNames: { '#v': 'version', '#s': 'status' }, ExpressionAttributeValues: marshall({ ':v': check.version, ':s': 'OPEN' }) } },
  ] }); } catch (error) {
    if (error.name === 'TransactionCanceledException' || error.name === 'ConditionalCheckFailedException') throw new AppError('STATE_CONFLICT', 409, '検査か設定が変更されています。読み込み直してください。');
    throw error;
  }
  runtime.precheck.invalidate();
  return { delivery_check: deliveryStatus(runtime, record, (await runtime.config.get()).delivery_check_max_age_days) };
}

export default { 'delivery-check.get': get, 'delivery-check.start': start, 'delivery-check.case': saveCase, 'delivery-check.evidence': evidence, 'delivery-check.submit': submit };
