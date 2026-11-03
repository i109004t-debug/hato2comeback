import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { managementFixture } from '../helpers/management.js';
import { ID, ID2, failure, eraseHash } from '../helpers/sending.js';
import { marshall } from '../../src/common/ddb.js';
import { addressHash } from '../../src/common/log.js';
import { auditArchiveKey } from '../../src/common/audit-archive.js';
import { createHandler as createEvents, eventRecord } from '../../src/events/handler.js';
import { createMetrics } from '../../src/common/metrics.js';
import { reviewInput } from '../../web/js/views/send.js';
import { ERROR_STATUS } from '../../src/common/http.js';
import { AWS_APIS, checkAwsSdk } from '../../src/common/aws.js';
import { API_ROUTES } from '../../src/common/router.js';

const restorePoint = '2026-11-03T09:00:00.000Z';
const table = 'ht2-stg-restore-202611031000';
const rid = (f, email = f.addresses[0]) => addressHash(email, '7'.repeat(64));
function restoreFixture() {
  const f = managementFixture({ count: 2 });
  f.settings.sending_enabled = false;
  f.deps.auditArchiveBucket = 'archive';
  f.source = [];
  f.scanCalls = [];
  f.deps.ddb.scan = async (input) => { f.scanCalls.push(input); assert.equal(input.TableName, table); return { Items: f.source.map(marshall) }; };
  f.resetWorker();
  f.check = () => f.worker({ mode: 'restore-check', restore_point: restorePoint }, f.context);
  f.apply = (types) => f.worker({ mode: 'restore-apply', source_table: table, restore_point: restorePoint, types }, f.context);
  f.archive = (action, target, details = {}, addr_id) => {
    const ts = '2026-11-03T09:30:00.000Z';
    const item = { PK: 'AUDIT#202611', SK: `${ts}#${f.files.size}`, ts, action, target, result: 'SUCCESS', details, ...(addr_id ? { addr_id } : {}) };
    f.files.set(auditArchiveKey(item), JSON.stringify({ eventName: 'INSERT', after: item, sha256: createHash('sha256').update(JSON.stringify({ after: item })).digest('hex') }));
    return item;
  };
  return f;
}

test('T-54 復元は停止スイッチを最初に検査し、入力不正・送信有効なら何も変えない', async () => {
  const f = restoreFixture();
  f.settings.sending_enabled = true;
  await assert.rejects(f.check(), { code: 'SENDING_DISABLED' });
  await assert.rejects(f.apply(['CAMPAIGN']), { code: 'SENDING_DISABLED' });
  assert.equal(f.ddb.calls.length, 0); assert.equal(f.scanCalls.length, 0);
  f.settings.sending_enabled = false;
  for (const input of [
    { source_table: 'ht2-prod-restore-202611031000' }, { source_table: 'ht2-stg' }, { types: ['LOCK'] }, { types: ['ADDR#x'] }, { types: ['ACCEPTANCE'] }, { restore_point: 'invalid' }, { restore_point: '2027-01-01T00:00:00Z' },
  ]) await assert.rejects(f.worker({ mode: 'restore-apply', source_table: table, restore_point: restorePoint, types: ['CAMPAIGN'], ...input }), { code: 'INVALID_REQUEST' });
  assert.equal(f.sends.length, 0);
});

test('T-54 SCHEDULED未発火だけAPPROVED、発火済み・送信中・停止中はRESTORED、終了は維持', async () => {
  const f = restoreFixture();
  const ids = Array.from({ length: 7 }, (_, i) => ID.slice(0, -1) + i);
  for (const [i, status] of ['SCHEDULED', 'SCHEDULED', 'QUEUED', 'SENDING', 'PAUSED', 'COMPLETED', 'CANCELLED'].entries()) f.ddb.set({ ...f.getCampaign(), SK: ids[i], campaign_id: ids[i], status, schedule_name: `ht2-${ids[i]}` });
  f.ddb.items.delete(`CAMPAIGN/${ID}`);
  f.schedules.set(`ht2-${ids[0]}`, {});
  const report = await f.check();
  assert.equal(f.getCampaign(ids[0]).status, 'APPROVED');
  assert.equal(f.schedules.size, 0);
  for (const id of ids.slice(1, 5)) { assert.equal(f.getCampaign(id).status, 'NEEDS_REVIEW'); assert.equal(f.getCampaign(id).review.reason, 'RESTORED'); }
  assert.equal(f.getCampaign(ids[5]).status, 'COMPLETED'); assert.equal(f.getCampaign(ids[6]).status, 'CANCELLED');
  assert.equal(report.campaigns.length, 5);
  assert.equal(f.sends.length, 0); assert.equal(f.executions.size, 0);
});

for (const origin of ['executions', 'archive']) test(`T-54 復元後に開始したAPPROVEDもRESTOREDへ止める: ${origin}`, async () => {
  const f = restoreFixture(); f.setCampaign({ status: 'APPROVED' });
  if (origin === 'executions') f.executions.set(`${ID}-s2`, {}); else f.archive('CAMPAIGNS_REVIEW', ID);
  await f.check();
  assert.equal(f.getCampaign().status, 'NEEDS_REVIEW'); assert.equal(f.getCampaign().review.reason, 'RESTORED');
  assert.equal(f.sends.length, 0);
});

test('T-54 予約削除と競合して実行が現れた配信はAPPROVEDから要確認へ止める', async () => {
  const f = restoreFixture();
  f.setCampaign({ status: 'SCHEDULED', schedule_name: `ht2-${ID}-s2` });
  f.schedules.set(`ht2-${ID}-s2`, {});
  f.deps.scheduler.deleteSchedule = async () => { f.executions.set(`${ID}-s2`, {}); return {}; };
  await f.check(); assert.equal(f.getCampaign().status, 'NEEDS_REVIEW');
});

test('T-54 別配信・日次の予約名を拒否し、一覧の取得不能ではロックを解放しない', async () => {
  const f = restoreFixture();
  f.setCampaign({ status: 'SCHEDULED', schedule_name: 'ht2-stg-daily' });
  await assert.rejects(f.check(), { code: 'INTERNAL' });
  f.setCampaign({ status: 'APPROVED' });
  f.ddb.set({ PK: 'LOCK', SK: 'SEND', owner: ID, expires_at_ms: f.deps.now() - 1 });
  f.deps.sfn.listExecutions = async () => { throw failure('AccessDeniedException'); };
  await assert.rejects(f.check(), { code: 'INTERNAL' }); assert.equal(f.ddb.get('LOCK', 'SEND').owner, ID);
});

test('T-54 点検は冪等で報告を保存・SNS通知し、DAILYをSES以上にして認証を再確認する', async () => {
  const f = restoreFixture();
  f.account.SendQuota.SentLast24Hours = 123;
  f.ddb.set({ PK: 'LOCK', SK: 'SEND', owner: ID, expires_at_ms: f.deps.now() - 1 });
  const first = await f.check();
  const writes = f.ddb.calls.length;
  const second = await f.check();
  assert.deepEqual(second, first); assert.equal(f.ddb.calls.length, writes);
  assert.ok(f.files.has('restore-reports/202611030900.json'));
  assert.equal(f.notices.filter((n) => n.code === 'RESTORE_CHECK_COMPLETED').length, 1);
  assert.equal(f.ddb.get('DAILY', '2026-11-03').reserved_attempts, 123);
  assert.equal(f.ddb.get('LOCK', 'SEND').owner, undefined);
  assert.equal(f.ddb.get('SETTINGS', 'AUTH_STATUS').checked_at, '');
  assert.equal(JSON.parse(Buffer.from(f.invocations[0].Payload)).mode, 'auth-check');
  assert.equal(f.sends.length, 0);
});

test('T-55 audit/の停止・完全削除を再適用し、再同意・設定変更は報告にだけ残す', async () => {
  const f = restoreFixture();
  const id = rid(f); const deleted = rid(f, f.addresses[1]);
  f.ddb.set({ PK: 'CONTACT_META', SK: id, version: 0, attributes: { name: '会員' }, blocked_topics: ['news'] });
  f.ddb.set({ PK: `ADDR#${deleted}`, SK: 'event', type: 'Send' });
  f.archive('CONTACT_STOP', 'contact', { scope: 'event', operation: 'IMPORT' }, id);
  f.archive('CONTACT_STOP', 'contact', { scope: 'ALL', operation: 'UPDATE' }, id);
  f.archive('ERASE', 'contact', { scope: 'ALL', operation: 'ERASE', erase_mac: eraseHash(f.addresses[1]) }, deleted);
  f.archive('RECONSENT', 'contact', { scope: 'news' }, id);
  f.archive('SETTINGS_UPDATE', 'ORG');
  const report = await f.check();
  const meta = f.ddb.get('CONTACT_META', id);
  assert.equal(meta.blocked_all, true); assert.deepEqual(meta.blocked_topics, ['event', 'news']); assert.equal(meta.attributes.name, undefined);
  assert.ok(f.ddb.get('ERASED', eraseHash(f.addresses[1])));
  assert.equal(f.ddb.get('CONTACT_META', deleted).erased, true);
  assert.equal(f.ddb.get(`ADDR#${deleted}`, 'event'), undefined);
  assert.equal(f.contacts.some((item) => item.EmailAddress === f.addresses[1]), false);
  assert.deepEqual(report.reapplied, { stops: 2, erasures: 1 }); assert.equal(report.redo.length, 2);
  assert.ok(!JSON.stringify(report).includes('@')); assert.equal(f.sends.length, 0);
});

test('T-55 監査のハッシュ不一致・必要な値の欠落は復元を失敗させる', async () => {
  for (const tamper of [true, false]) {
    const f = restoreFixture();
    const item = f.archive('CONTACT_STOP', 'contact', tamper ? { operation: 'UPDATE', scope: 'news' } : {}, rid(f));
    if (tamper) { const key = auditArchiveKey(item); const value = JSON.parse(f.files.get(key)); value.after.details.scope = 'ALL'; f.files.set(key, JSON.stringify(value)); }
    await assert.rejects(f.check(), { code: 'INTERNAL' });
    assert.equal(f.files.has('restore-reports/202611030900.json'), false);
    assert.equal(f.sends.length, 0);
  }
});

test('13.7 applyは選択した種類だけを条件付き復元し、停止・削除は和集合、DAILYは大きい方', async () => {
  const f = restoreFixture(); const id = rid(f);
  f.ddb.set({ PK: 'CONTACT_META', SK: id, version: 2, attributes: { name: '現在' }, blocked_topics: ['event'] });
  f.ddb.set({ PK: 'DAILY', SK: '2026-11-03', reserved_attempts: 40 });
  f.source = [
    { PK: 'CONTACT_META', SK: id, version: 1, attributes: { name: '復元側' }, blocked_topics: ['news'] },
    { PK: 'DAILY', SK: '2026-11-03', reserved_attempts: 10 },
    { ...f.getCampaign(), status: 'SENDING' },
    { PK: 'SETTINGS', SK: 'ORG', from_name: '戻さない' },
    { PK: 'LOCK', SK: 'SEND', owner: '戻さない' },
    { PK: `ADDR#${id}`, SK: 'old' },
    { PK: 'SETTINGS', SK: 'AUTH_STATUS', status: 'PASS' },
  ];
  await f.apply(['CONTACT_META', 'DAILY', 'CAMPAIGN']);
  const meta = f.ddb.get('CONTACT_META', id);
  assert.equal(meta.attributes.name, '復元側'); assert.deepEqual(meta.blocked_topics, ['event', 'news']); assert.equal(meta.version, 3);
  assert.equal(f.ddb.get('DAILY', '2026-11-03').reserved_attempts, 40);
  assert.equal(f.getCampaign().review.reason, 'RESTORED');
  assert.notEqual(f.ddb.get('SETTINGS', 'ORG').from_name, '戻さない');
  assert.equal(f.ddb.get('LOCK', 'SEND'), undefined); assert.equal(f.ddb.get(`ADDR#${id}`, 'old'), undefined);
  const writes = f.ddb.calls.length; await f.apply(['CAMPAIGN', 'DAILY', 'CONTACT_META']); assert.equal(f.ddb.calls.length, writes);
  const report = await f.check(); assert.equal(report.restore_id, '202611031000');
});

test('13.7 ERASEDがどちらかにあれば属性を戻さず、終了済み配信を上書きしない', async () => {
  for (const side of ['source', 'current']) {
    const f = restoreFixture(); const id = rid(f);
    const marker = { PK: 'ERASED', SK: eraseHash(f.addresses[0]), addr_id: id };
    if (side === 'source') f.source.push(marker); else f.ddb.set(marker);
    f.source.push({ PK: 'CONTACT_META', SK: id, attributes: { name: '戻さない' } }, { ...f.getCampaign(), status: 'SENDING' });
    f.setCampaign({ status: 'COMPLETED' });
    await f.apply(['CONTACT_META', 'ERASED', 'CAMPAIGN']);
    assert.equal(f.ddb.get('CONTACT_META', id).attributes, undefined); assert.equal(f.ddb.get('CONTACT_META', id).erased, true);
    assert.equal(f.getCampaign().status, 'COMPLETED');
  }
});

test('13.7 宛先との対応が不明なERASEDは属性を戻さず全停止し、報告に警告を残す', async () => {
  const f = restoreFixture();
  f.source = [{ PK: 'ERASED', SK: eraseHash(f.addresses[0]) }, { PK: 'CONTACT_META', SK: rid(f), attributes: { name: '戻さない' } }];
  await f.apply(['ERASED', 'CONTACT_META']);
  assert.equal(f.ddb.get('CONTACT_META', rid(f)).attributes, undefined);
  assert.equal(f.ddb.get('CONTACT_META', rid(f)).blocked_all, true);
  assert.equal(f.ddb.get('CONTACT_META', rid(f)).erased, false);
  const report = await f.check(); assert.ok(report.warnings.includes('UNIDENTIFIED_ERASED_ATTRIBUTES_BLOCKED'));
});

test('13.7 復元元と現在の宛先HMAC鍵のkidが異なれば属性を書き戻さない', async () => {
  const f = restoreFixture();
  f.source = [{ PK: 'CONTACT_META', SK: rid(f), kid: 'old-key', attributes: { name: '戻さない' } }];
  await assert.rejects(f.apply(['CONTACT_META']), { code: 'STATE_CONFLICT' });
  assert.equal(f.ddb.get('CONTACT_META', rid(f)), undefined); assert.equal(f.sends.length, 0);
});

test('13.7 ORGは明示選択時だけ復元しauth-checkを起動、他のSETTINGSは除外', async () => {
  const f = restoreFixture();
  f.source = [{ PK: 'SETTINGS', SK: 'ORG', from_name: '復元設定' }, { PK: 'SETTINGS', SK: 'CONTACT_BACKUP', complete: true }];
  await f.apply(['SETTINGS/ORG']);
  assert.equal(f.ddb.get('SETTINGS', 'ORG').from_name, '復元設定'); assert.equal(f.ddb.get('SETTINGS', 'CONTACT_BACKUP'), undefined);
  assert.equal(f.invocations.length, 1);
});

test('13.7 Scan・監査のS3・Step Functionsを最後のページまで読み、繰返しカーソルは拒否', async () => {
  const f = restoreFixture();
  const marker = marshall({ PK: 'CONTACT_META', SK: 'last' });
  f.deps.ddb.scan = async (input) => input.ExclusiveStartKey ? { Items: [marshall({ PK: 'CONTACT_META', SK: rid(f), attributes: { name: '最後' } })] } : { Items: [], LastEvaluatedKey: marker };
  const audit = f.archive('CONTACT_STOP', 'contact', { scope: 'news', operation: 'UPDATE' }, rid(f));
  f.deps.s3.listObjectsV2 = async ({ Prefix, ContinuationToken }) => Prefix.startsWith('audit/') ? ContinuationToken ? { Contents: [{ Key: auditArchiveKey(audit) }] } : { Contents: [], IsTruncated: true, NextContinuationToken: 'next' } : { Contents: [] };
  await f.apply(['CONTACT_META']);
  assert.deepEqual(f.ddb.get('CONTACT_META', rid(f)).blocked_topics, ['news']);
  f.setCampaign({ status: 'APPROVED' });
  f.deps.sfn.listExecutions = async ({ nextToken }) => nextToken ? { executions: [{ name: `${ID}-r2`, startDate: new Date(f.deps.now()), status: 'SUCCEEDED' }] } : { executions: [], nextToken: 'next' };
  await f.check(); assert.equal(f.getCampaign().status, 'NEEDS_REVIEW');
  const g = restoreFixture();
  g.deps.ddb.scan = async () => ({ Items: [], LastEvaluatedKey: marker });
  await assert.rejects(g.apply(['CONTACT_META']), { code: 'INTERNAL' });
  const h = restoreFixture();
  h.deps.sfn.listExecutions = async () => ({ executions: [], nextToken: 'repeat' });
  await assert.rejects(h.check(), { code: 'INTERNAL' });
});

test('13.7 書戻しの条件競合・未知のschema・別の選択での再実行は拒否する', async () => {
  const f = restoreFixture();
  f.source = [{ ...f.getCampaign(), schema_version: 2 }];
  await assert.rejects(f.apply(['CAMPAIGN']), { code: 'UNSUPPORTED_SCHEMA' });
  assert.equal(f.sends.length, 0);
  const g = restoreFixture();
  await g.apply(['DAILY']);
  await assert.rejects(g.apply(['IMPORT']), { code: 'STATE_CONFLICT' });
  const h = restoreFixture();
  h.source = [{ PK: 'CONTACT_META', SK: rid(h), attributes: { name: '復元側' } }];
  const put = h.deps.ddb.putItem;
  h.deps.ddb.putItem = async (input) => { if (input.Item.PK.S === 'CONTACT_META') throw failure('ConditionalCheckFailedException'); return put(input); };
  await assert.rejects(h.apply(['CONTACT_META']), { code: 'INTERNAL' });
  assert.equal(h.ddb.get('CONTACT_META', rid(h)), undefined);
});

test('13.7 報告保存の失敗後は途中から点検でき、実行中のロックは保持する', async () => {
  const f = restoreFixture();
  f.executions.set(`${ID}-r2`, {});
  f.ddb.set({ PK: 'LOCK', SK: 'SEND', owner: ID });
  const put = f.deps.s3.putObject;
  f.deps.s3.putObject = async (input) => { if (input.Key.startsWith('restore-reports/')) throw failure('AccessDeniedException'); return put(input); };
  await assert.rejects(f.check(), { code: 'INTERNAL' });
  assert.equal(f.getCampaign().review.reason, 'RESTORED');
  f.deps.s3.putObject = put;
  const report = await f.check();
  assert.equal(report.campaigns.length, 1); assert.ok(report.warnings.includes('RUNNING_EXECUTIONS'));
  assert.equal(f.ddb.get('LOCK', 'SEND').owner, ID); assert.equal(f.sends.length, 0);
});

test('13.7 復元前の監査を再適用せず、終了済み配信は復元後開始の監査でも維持', async () => {
  const f = restoreFixture(); f.setCampaign({ status: 'CANCELLED' });
  const item = f.archive('CONTACT_STOP', 'contact', { scope: 'ALL', operation: 'UPDATE' }, rid(f));
  f.files.delete(auditArchiveKey(item));
  item.ts = '2026-11-03T08:59:59.000Z'; item.SK = `${item.ts}#old`;
  f.files.set(auditArchiveKey(item), JSON.stringify({ eventName: 'INSERT', after: item, sha256: createHash('sha256').update(JSON.stringify({ after: item })).digest('hex') }));
  f.archive('CAMPAIGNS_START', ID);
  const report = await f.check();
  assert.equal(f.ddb.get('CONTACT_META', rid(f)), undefined); assert.equal(f.getCampaign().status, 'CANCELLED');
  assert.deepEqual(report.reapplied, { stops: 0, erasures: 0 });
});

test('13.7 IMPORTは明示選択時だけ、未対応schemaは処理しない', async () => {
  const f = restoreFixture();
  f.source = [{ PK: 'IMPORT', SK: ID2, schema_version: 1, import_id: ID2, status: 'PREVIEW' }];
  await f.apply(['IMPORT']); assert.equal(f.ddb.get('IMPORT', ID2).status, 'PREVIEW');
  assert.equal(f.invocations.length, 0);
  const g = restoreFixture(); g.source = [{ ...f.source[0], schema_version: 2 }];
  await assert.rejects(g.apply(['IMPORT']), { code: 'UNSUPPORTED_SCHEMA' });
});

test('API-22と画面はRESTOREDのCANCELだけを受け付ける', async () => {
  const f = managementFixture();
  f.setCampaign({ status: 'NEEDS_REVIEW', chunks_total: 1, progress: { chunk: 0, index: 0 }, review: { reason: 'RESTORED' } });
  const details = await f.request(`GET /campaigns/${ID}`);
  assert.equal(details.statusCode, 200, details.body);
  assert.equal(details.json.review.reason, 'RESTORED');
  assert.equal(details.json.review_recipients, undefined);
  for (const decision of ['SKIP', 'RESEND']) {
    assert.equal((await f.request(`POST /campaigns/${ID}/review`, { decision, resume: false, note: '確認' })).statusCode, 409);
    assert.throws(() => reviewInput(f.getCampaign(), decision, '確認'));
  }
  assert.throws(() => reviewInput(f.getCampaign(), 'RESTART', '確認'));
  assert.deepEqual(reviewInput(f.getCampaign(), 'CANCEL', '確認'), { decision: 'CANCEL', note: '確認' });
  assert.equal((await f.request(`POST /campaigns/${ID}/review`, { decision: 'CANCEL', note: '確認' })).json.status, 'CANCELLED');
  assert.equal(f.executions.size, 0); assert.equal(f.sends.length, 0);
});

test('T-62 API-10は索引の全ページ・属性を消し、照合値を残して抑止削除を非同期依頼', async () => {
  const f = managementFixture({ count: 1 }); const id = rid(f);
  for (let i = 0; i < 5; i += 1) f.ddb.set({ PK: `ADDR#${id}`, SK: String(i) });
  const query = f.deps.ddb.query;
  f.deps.ddb.query = (input) => query({ ...input, Limit: 2 });
  const response = await f.request('POST /contacts/erase', { email: f.addresses[0], note: '本人請求' });
  assert.equal(response.statusCode, 200, response.body); assert.equal(response.json.retention.max_days, 90);
  assert.equal([...f.ddb.items.values()].filter((i) => i.PK === `ADDR#${id}`).length, 0);
  assert.equal(f.ddb.get('CONTACT_META', id).attributes, undefined);
  const input = JSON.parse(Buffer.from(f.invocations[0].Payload));
  assert.equal(input.mode, 'erase-suppression'); assert.equal(input.erase_mac, eraseHash(f.addresses[0]));
  assert.equal(f.invocations[0].InvocationType, 'Event');
  const audit = [...f.ddb.items.values()].find((i) => i.action === 'ERASE');
  assert.equal(audit.addr_id, id); assert.deepEqual([audit.details.scope, audit.details.operation, audit.details.erase_mac], ['ALL', 'ERASE', input.erase_mac]);
  assert.ok(!JSON.stringify([...f.ddb.items.values()].filter((item) => item.PK.startsWith('AUDIT#') || ['ERASED', 'CONTACT_META'].includes(item.PK))).includes(f.addresses[0]));
});

for (const result of ['success', 'absent', 'mismatch', 'no-record', 'failure']) test(`T-62 抑止削除はERASEDを照合してから実行し、失敗は通知: ${result}`, async () => {
  const f = managementFixture({ count: 1 });
  const mac = eraseHash(f.addresses[0]);
  if (result !== 'no-record') f.ddb.set({ PK: 'ERASED', SK: mac });
  let calls = 0;
  f.deps.ses.deleteSuppressedDestination = async () => { calls += 1; if (result === 'absent') throw failure('NotFoundException'); if (result === 'failure') throw failure('AccessDeniedException'); };
  const response = await f.worker({ mode: 'erase-suppression', email: f.addresses[0], erase_mac: result === 'mismatch' ? 'f'.repeat(64) : mac });
  assert.equal(calls, ['mismatch', 'no-record'].includes(result) ? 0 : 1);
  assert.equal(response.status, ['success', 'absent'].includes(result) ? 'DONE' : 'FAILED');
  assert.equal(f.notices.length, ['success', 'absent'].includes(result) ? 0 : 1);
  assert.ok(!JSON.stringify(f.notices).includes('@'));
});

test('T-62 抑止削除の依頼自体が失敗しても完全削除の印・監査は残し、管理者に通知する', async () => {
  const f = managementFixture({ count: 1 });
  f.deps.lambda.invoke = async () => { throw failure('TimeoutError'); };
  assert.equal((await f.request('POST /contacts/erase', { email: f.addresses[0], note: '本人請求' })).statusCode, 500);
  assert.equal(f.ddb.get('CONTACT_META', rid(f)).erased, true);
  assert.ok(f.ddb.get('ERASED', eraseHash(f.addresses[0])));
  assert.ok(f.notices.some((n) => n.code === 'ERASE_SUPPRESSION_FAILED'));
});

test('T-55 API-07/08の停止監査にはaddr_id・範囲・操作種類が残る', async () => {
  const f = managementFixture({ count: 1 });
  assert.equal((await f.request('POST /contacts/update', { email: f.addresses[0], topics: { news: 'OPT_OUT' } })).statusCode, 200);
  assert.equal((await f.request('POST /contacts/unsubscribe', { email: f.addresses[0], scope: 'ALL' })).statusCode, 200);
  const records = [...f.ddb.items.values()].filter((i) => i.action === 'CONTACT_STOP');
  assert.equal(records.length, 2);
  assert.deepEqual(records.map((i) => [i.addr_id, i.details.scope, i.details.operation]), [[rid(f), 'news', 'UPDATE'], [rid(f), 'ALL', 'UNSUBSCRIBE']]);
});

test('T-62 終了時は未確定のスナップショットもprefix全体を消し、他配信を残す', async () => {
  const f = managementFixture();
  f.files.set(`recipients/${ID}/partial.jsonl`, 'sensitive'); f.files.set(`recipients/${ID2}/00000.jsonl`, 'other');
  f.setCampaign({ status: 'NEEDS_REVIEW', review: { reason: 'RESTORED' } });
  assert.equal((await f.request(`POST /campaigns/${ID}/review`, { decision: 'CANCEL', note: '中止' })).statusCode, 200);
  assert.equal(f.files.has(`recipients/${ID}/partial.jsonl`), false); assert.equal(f.files.has(`recipients/${ID2}/00000.jsonl`), true);
});

for (const action of ['disable', 'roles']) test(`T-64 管理者2人→1人は確認必須、0人は確認があっても拒否: ${action}`, async () => {
  const f = managementFixture(); const body = action === 'roles' ? { roles: ['sender'] } : {};
  assert.equal((await f.request(`POST /staff/other-admin/${action}`, body)).json.error_code, 'LAST_ADMIN');
  assert.equal((await f.request(`POST /staff/other-admin/${action}`, { ...body, confirm_single_admin: true })).statusCode, 200);
  const g = managementFixture(); g.staff.get('user').Enabled = false;
  assert.equal((await g.request(`POST /staff/other-admin/${action}`, { ...body, confirm_single_admin: true })).json.error_code, 'LAST_ADMIN');
});

test('11.5 STAFFの失敗監査・5分失効と、失効直後の同時変更の排他', async () => {
  const f = managementFixture();
  f.deps.cognito.adminResetUserPassword = async () => { throw failure('TimeoutError'); };
  assert.equal((await f.request('POST /staff/other-admin/reset-password', {})).statusCode, 500);
  const lock = f.ddb.get('LOCK', 'STAFF'); assert.equal(lock.expires_at_ms, f.deps.now() + 300000);
  assert.ok([...f.ddb.items.values()].some((i) => i.action === 'STAFF_RESET_PASSWORD' && i.details.phase === 'UNKNOWN'));
  f.advance(299999); assert.equal((await f.request('POST /staff/other-admin/enable', {})).statusCode, 409);
  f.advance(1);
  const results = await Promise.all([f.request('POST /staff/other-admin/enable', {}), f.request('POST /staff/other-admin/enable', {})]);
  assert.deepEqual(results.map((i) => i.statusCode).sort(), [200, 409]);
});

test('8.5 SESの公式表記Rendering Failureとfailure.errorMessageを保存し、旧表記を捨てる', async () => {
  const f = managementFixture({ count: 1 });
  const event = { source: 'aws.ses', id: 'abcdef12-1234-4567-8910-abcdefghijkl', time: new Date(f.deps.now()).toISOString(), detail: { eventType: 'Rendering Failure', mail: { timestamp: new Date(f.deps.now()).toISOString(), tags: { rid: [rid(f)] } }, failure: { errorMessage: 'Missing member@example.com' } } };
  const record = eventRecord(event, f.deps.now()); assert.equal(record.type, 'Rendering Failure'); assert.equal(record.diagnostic_code, 'Missing [address]');
  event.detail.eventType = 'RenderingFailure'; assert.equal(eventRecord(event, f.deps.now()), null);
  const lines = [];
  const metrics = createMetrics({ env: 'stg', now: f.deps.now, write: (line) => lines.push(JSON.parse(line)) });
  assert.equal((await createEvents({ ...f.deps, metrics })(event)).status, 'IGNORED');
  assert.equal(lines[0].EventsIgnored, 1);
});

test('13.2 本番と同じEvents入口がcreateMetricsを作り、rid欠落の2つのメトリクスを出す', async () => {
  const f = managementFixture(); const lines = [];
  const handler = createEvents({ ...f.deps, metrics: undefined, write: (line) => lines.push(JSON.parse(line)) });
  assert.equal((await handler({ source: 'aws.ses', detail: { mail: { tags: {} } } })).status, 'IGNORED');
  assert.deepEqual(lines.map((line) => line._aws.CloudWatchMetrics[0].Metrics[0].Name), ['EventsIgnored', 'EventIndexSkipped']);
});

test('15.5 sdk-checkは利用する全クライアントと新しい管理APIのCommandを点検する', async () => {
  const result = await checkAwsSdk({ load: async (name) => {
    const def = Object.values(AWS_APIS).find((d) => d.package === name);
    return { [def.client]: class {}, ...Object.fromEntries(def.operations.map((operation) => [`${operation}Command`, class {}])) };
  }, loadVersion: async () => ({ default: { version: '3.999.0' } }) });
  assert.equal(result.ok, true); assert.equal(result.packages.length, Object.keys(AWS_APIS).length);
  for (const [service, operations] of Object.entries({ ddb: ['Scan'], s3: ['ListObjectsV2'], ses: ['DeleteSuppressedDestination'], sfn: ['ListExecutions'], scheduler: ['DeleteSchedule'], kms: ['GenerateMac', 'DescribeKey'], cognito: ['AdminDisableUser', 'AdminSetUserMFAPreference'] })) for (const operation of operations) assert.ok(AWS_APIS[service].operations.includes(operation));
});

test('9.5 help.htmlにはAPIの利用者向けエラーコードがすべて載る', () => {
  const help = readFileSync(new URL('../../web/help.html', import.meta.url), 'utf8');
  for (const code of Object.keys(ERROR_STATUS)) assert.ok(help.includes(code), code);
  for (const text of ['RESTORED', 'ERASE_SUPPRESSION_FAILED', '最長90日', '5分', '一覧で結果を確かめてください']) assert.ok(help.includes(text), text);
});

test('仕上げ API一覧API-01〜35・エラー表・アラーム一覧を設計書と照合する', () => {
  const design = readFileSync(new URL('../../docs/詳細設計書.md', import.meta.url), 'utf8');
  const apiSection = design.split('### 10.2 ')[1].split('### 10.3 ')[0];
  const ids = [...new Set([...apiSection.matchAll(/\| (API-\d{2}) \|/g)].map((m) => m[1]))].sort();
  assert.deepEqual([...new Set(API_ROUTES.map((r) => r.id))].sort(), ids);
  const errorSection = design.split('### 10.4 ')[1].split('### 10.5 ')[0];
  const memo = readFileSync(new URL('../../docs/実装メモ.md', import.meta.url), 'utf8');
  for (const code of Object.keys(ERROR_STATUS)) assert.ok(errorSection.includes(code) || code === 'EVIDENCE_TOO_LARGE' && memo.includes('第13段階') && memo.includes(code), code);
  const alarms = design.split('### 13.3 ')[1].split('### 13.4 ')[0];
  const template = readFileSync(new URL('../../infra/template.yaml', import.meta.url), 'utf8');
  for (const match of alarms.matchAll(/`(ht2-\{env\}-[a-z0-9-]+)`/g)) assert.ok(template.includes(match[1].replace('{env}', '${Env}')), match[1]);
});
