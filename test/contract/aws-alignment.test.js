import test from 'node:test';
import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';
import { AWS_APIS, checkAwsSdk } from '../../src/common/aws.js';
import { createHandler } from '../../src/worker/handler.js';
import { createPrecheck } from '../../src/common/precheck.js';
import { createMonitoring } from '../../src/common/monitoring.js';
import { createMetrics } from '../../src/common/metrics.js';
import { createSendLock } from '../../src/common/lock.js';
import { addressHash } from '../../src/common/log.js';
import { WORKFLOW_STEP_LIMIT } from '../../src/worker/state.js';
import { ERROR_MESSAGES } from '../../web/js/api.js';
import { PAUSE_LABELS } from '../../web/js/dom.js';
import { fixture, failure, ID, ARN, eraseHash } from '../helpers/sending.js';
import { managementFixture } from '../helpers/management.js';

const checker = (f) => createPrecheck({ ...f.deps, store: f.store });
const settingsBody = (f) => ({ version: f.ddb.get('SETTINGS', 'ORG').version, from_local: 'info', from_name: '新しい会報', reply_to: f.org.reply_to, legal: f.org.legal, approval_required: true, test_recipients: [], max_rate_per_sec: 10 });

test('第8段階3 無制限SES枠は消費後もInfinity、アプリの日次上限は維持', async () => {
  const f = fixture({ count: 3, cap: 2 });
  f.account.SendQuota.Max24HourSend = -1;
  f.account.SendQuota.SentLast24Hours = 1000000;
  const check = checker(f);
  assert.equal((await check.run()).quotaRemaining, Infinity);
  check.consume();
  assert.equal((await check.run()).quotaRemaining, Infinity);
  assert.equal((await f.prepare()).action, 'SEND');
  assert.equal((await f.send()).action, 'WAIT_DAY');
  assert.equal(f.sends.length, 2);
});

for (const maximum of [-2, NaN]) test(`第8段階3 無制限以外の不正枠${maximum}は拒否`, async () => {
  const f = fixture(); f.account.SendQuota.Max24HourSend = maximum;
  assert.equal((await checker(f).run()).code, 'QUOTA_INSUFFICIENT');
});

for (const options of [undefined, {}, { SuppressedReasons: ['BOUNCE', 'COMPLAINT'] }]) test(`第8段階10 抑止設定${JSON.stringify(options)}を許可`, async () => {
  const f = fixture(); f.configuration.SuppressionOptions = options;
  assert.equal((await checker(f).run()).ok, true);
});
for (const reasons of [[], ['BOUNCE'], ['COMPLAINT'], 'BOUNCE COMPLAINT', null]) test(`第8段階10 不完全な抑止理由${JSON.stringify(reasons)}を拒否`, async () => {
  const f = fixture(); f.configuration.SuppressionOptions = { SuppressedReasons: reasons };
  assert.equal((await checker(f).run()).code, 'CONFIGURATION_INVALID');
});

function metricPages(f, mode) {
  const calls = [];
  f.deps.cloudwatch.getMetricData = async (input) => {
    calls.push(input);
    const last = !!input.NextToken;
    return {
      ...(last && mode !== 'repeat' ? {} : { NextToken: 'next' }),
      MetricDataResults: input.MetricDataQueries.map(({ Id }) => ({ Id,
        StatusCode: last ? mode === 'partial-last' ? 'PartialData' : 'Complete' : mode === 'internal' ? 'InternalError' : 'PartialData',
        Values: ['rendering', 'reject'].includes(Id) ? [] : last ? [3] : [2],
      })),
    };
  };
  return calls;
}
test('第8段階4 監視はPartialDataの後を読み、次ページを合算して率を検査', async () => {
  const f = fixture(); await f.prepare();
  const calls = metricPages(f);
  const monitor = createMonitoring({ ...f.deps, store: f.store });
  await monitor.check({ campaign: f.getCampaign(), config: f.settings, checkRatios: true });
  assert.deepEqual(calls.map((input) => input.NextToken), [undefined, 'next']);
  await assert.rejects(monitor.check({ campaign: f.getCampaign(), config: { ...f.settings, campaign_min_sample: 10 }, checkRatios: true }), { code: 'CAMPAIGN_BOUNCE' });
});
test('第8段階4 API結果もPartialDataとCompleteを合算', async () => {
  const f = managementFixture(); f.setCampaign({ started_at: new Date(f.deps.now()).toISOString() });
  const calls = metricPages(f);
  const response = await f.request(`GET ${f.campaignPath}/stats`);
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json.metrics.Send, 5);
  assert.equal(calls.length, 2);
});
for (const mode of ['partial-last', 'repeat', 'internal']) test(`第8段階4 ${mode}を監視とAPIの双方で拒否`, async () => {
  const f = managementFixture(); f.setCampaign({ started_at: new Date(f.deps.now()).toISOString() });
  metricPages(f, mode);
  await assert.rejects(createMonitoring({ ...f.deps, store: f.store }).check({ campaign: f.getCampaign(), config: f.settings }), { code: 'MONITORING_UNAVAILABLE' });
  const response = await f.request(`GET ${f.campaignPath}/stats`);
  assert.equal(response.statusCode, 503, response.body);
  assert.equal(response.json.error_code, 'MONITORING_UNAVAILABLE');
});

test('第8段階5 THROTTLEDの連続回数をLambda再初期化後も保持し30回目に停止', async () => {
  const f = fixture({ count: 1 }); await f.prepare();
  f.setCampaign({ throttled_run: 28 });
  f.onSend = () => { throw failure('ThrottlingException', 400, 'Maximum sending rate exceeded'); };
  assert.equal((await f.send()).action, 'THROTTLED');
  assert.equal(f.getCampaign().throttled_run, 29);
  f.handler = createHandler(f.deps);
  assert.equal((await f.send()).action, 'PAUSED');
  assert.equal(f.getCampaign().throttled_run, 30);
  assert.equal(f.getCampaign().pause_reason, 'SES_UNSTABLE');
  assert.equal(f.getCampaign().progress.index, 0);
  assert.equal(f.getCampaign().counts.accepted, 0);
  assert.equal(f.sends.length, 8);
  assert.equal(f.ddb.get('LOCK', 'SEND').owner, undefined);
});
for (const phase of ['prepare', 'send']) test(`第8段階5 ${phase}のロック待ちは288回目に停止し未送信位置を維持`, async () => {
  const f = fixture({ count: 1 });
  if (phase === 'send') await f.prepare();
  const lock = createSendLock({ ...f.deps, store: f.store });
  await lock.release(ID); await lock.acquire('other', 7200);
  f.setCampaign({ wait_lock_run: 286, workflow_execution_arn: ARN });
  assert.equal((await (phase === 'send' ? f.send() : f.prepare())).action, 'WAIT_LOCK');
  f.handler = createHandler(f.deps);
  assert.equal((await (phase === 'send' ? f.send() : f.prepare())).action, 'PAUSED');
  assert.equal(f.getCampaign().wait_lock_run, 288);
  assert.equal(f.getCampaign().pause_reason, 'LOCK_WAIT_TIMEOUT');
  assert.equal(f.getCampaign().pause_phase, phase);
  assert.equal(f.sends.length, 0);
  assert.equal(f.ddb.get('LOCK', 'SEND').owner, 'other');
});
test('第8段階5 ロック取得と宛先の進捗で各連続回数を戻す', async () => {
  const f = fixture({ count: 2 }); await f.prepare();
  f.setCampaign({ wait_lock_run: 287, throttled_run: 29 });
  f.onSend = (_, index) => { if (index > 1) throw failure('ThrottlingException', 400, 'Maximum sending rate exceeded'); return { MessageId: 'ok' }; };
  assert.equal((await f.send()).action, 'THROTTLED');
  assert.equal(f.getCampaign().wait_lock_run, 0);
  assert.equal(f.getCampaign().throttled_run, 1);
  assert.equal(f.getCampaign().progress.index, 1);
});
test('第8段階5 準備中の待機停止はAPI再開後も準備から続ける', async () => {
  const f = managementFixture({ count: 1 });
  f.setCampaign({ status: 'PAUSED', pause_phase: 'prepare', pause_reason: 'LOCK_WAIT_TIMEOUT', execution_arn: ARN, paused_at: new Date(f.deps.now()).toISOString(), wait_lock_run: 288 });
  f.files.set('delivery-checks/fix/evidence', '{}');
  const response = await f.request(`POST ${f.campaignPath}/resume`, { note: 'ロック確認済み', evidence_key: 'delivery-checks/fix/evidence' });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json.status, 'QUEUED');
  assert.equal((await f.worker(f.event('send'), f.context)).action, 'SEND');
  assert.equal(f.getCampaign().status, 'SENDING');
  assert.equal(f.getCampaign().recipients_total, 1);
});
for (const phase of ['prepare', 'send', 'paused', 'finish']) test(`第8段階5 ${phase}でも同じ実行の600回目は送信前に要確認へ`, async () => {
  const f = fixture({ count: 1 });
  if (phase !== 'prepare') await f.prepare();
  f.setCampaign({ execution_arn: ARN, workflow_execution_arn: ARN, workflow_steps: WORKFLOW_STEP_LIMIT - 1, ...(phase === 'paused' ? { status: 'PAUSED' } : {}) });
  const result = await (phase === 'prepare' ? f.prepare() : phase === 'finish' ? f.finish('DONE') : f.send());
  assert.deepEqual(result, { action: 'REVIEW', reason: 'WORKFLOW_HISTORY_LIMIT' });
  assert.equal(f.sends.length, 0);
  await f.finish('REVIEW', { result });
  assert.equal(f.getCampaign().status, 'NEEDS_REVIEW');
  assert.equal(f.getCampaign().review.reason, 'WORKFLOW_HISTORY_LIMIT');
});
test('第8段階5 別実行へ引継いだときだけ履歴予算を更新', async () => {
  const f = fixture({ count: 1 });
  f.setCampaign({ workflow_execution_arn: `${ARN}-old`, workflow_steps: WORKFLOW_STEP_LIMIT, wait_lock_run: 288, throttled_run: 30 });
  assert.equal((await f.prepare()).action, 'SEND');
  assert.equal(f.getCampaign().workflow_steps, 1);
  assert.equal(f.getCampaign().workflow_execution_arn, ARN);
  assert.equal(f.getCampaign().wait_lock_run, 0);
  assert.equal(f.getCampaign().throttled_run, 0);
});

const sdk = (name) => {
  const definition = Object.values(AWS_APIS).find((value) => value.package === name);
  return Object.fromEntries([definition.client, ...definition.operations.map((operation) => `${operation}Command`)].map((key) => [key, class {}]));
};
test('第8段階6 sdk-checkは12パッケージと使用するexportを検査し取れる版を返す', async () => {
  const loads = [];
  const worker = createHandler({ sdkLoad: async (name) => { loads.push(name); return sdk(name); }, sdkVersionLoad: async () => ({ default: { version: '3.1000.0' } }) });
  const result = await worker({ mode: 'sdk-check' });
  assert.equal(result.ok, true);
  assert.equal(result.packages.length, 12);
  assert.deepEqual(new Set(loads), new Set(Object.values(AWS_APIS).map((entry) => entry.package)));
  assert.ok(result.packages.every((entry) => entry.ok && entry.version === '3.1000.0' && entry.package.startsWith('@aws-sdk/client-')));
});
for (const missing of Object.values(AWS_APIS).map((entry) => entry.package)) test(`第8段階6 ${missing}が読めないと検査全体が失敗し自由文を返さない`, async () => {
  const result = await checkAwsSdk({ load: async (name) => { if (name === missing) throw new Error('private@example.com'); return sdk(name); }, loadVersion: async () => { throw new Error('version unavailable'); } });
  assert.equal(result.ok, false);
  assert.equal(result.packages.filter((entry) => entry.ok === false).length, 1);
  assert.ok(!JSON.stringify(result).includes('private@example.com'));
  assert.ok(result.packages.every((entry) => entry.version === ''));
});
test('第8段階6 import成功でも必要なCommandがなければ失敗', async () => {
  const result = await checkAwsSdk({ load: async (name) => name === 'sesv2' ? {} : sdk(name), loadVersion: async () => ({}) });
  assert.equal(result.ok, false);
});

for (const access of [false, undefined]) test(`第8段階9 サンドボックス${access}では記録・S3・worker起動前に取込拒否`, async () => {
  const f = managementFixture(); f.account.ProductionAccessEnabled = access;
  const response = await f.receive(f.importCsv());
  assert.equal(response.statusCode, 422, response.body);
  assert.equal(response.json.error_code, 'IMPORT_REQUIRES_PRODUCTION');
  assert.equal(f.invocations.length, 0);
  assert.equal([...f.ddb.items.values()].filter((item) => item.PK === 'IMPORT').length, 0);
  assert.equal([...f.files.keys()].filter((key) => key.startsWith('imports/')).length, 0);
});
test('第8段階9 受付後にサンドボックスへ変わってもworkerがジョブ作成を拒否', async () => {
  const f = managementFixture(); const response = await f.receive(f.importCsv());
  f.account.ProductionAccessEnabled = false;
  await assert.rejects(f.worker({ mode: 'import', import_id: response.json.import_id }), { code: 'IMPORT_REQUIRES_PRODUCTION' });
  assert.equal(f.jobs.size, 0);
  assert.equal(f.ddb.get('IMPORT', response.json.import_id).status, 'FAILED');
});
test('第8段階11 プレビューだけに解除URLのダミーを渡す', async () => {
  const f = managementFixture(); f.draft();
  await f.request(`POST ${f.campaignPath}/submit`, {});
  f.deps.ses.testRenderEmailTemplate = async (input) => {
    assert.deepEqual(JSON.parse(input.TemplateData), { amazonSESUnsubscribeUrl: '（配信停止のURLがここに入ります）' });
    return { RenderedTemplate: 'Content-Type: text/plain; charset=UTF-8\r\n\r\npreview' };
  };
  assert.equal((await f.request(`POST ${f.campaignPath}/preview`, {})).statusCode, 200);
  assert.ok(f.templates.get(f.getCampaign().template_name).Text.includes('{{amazonSESUnsubscribeUrl}}'));
});
for (const marker of ['ERASED', 'CONTACT_META']) test(`第8段階12 ${marker}に一致するSESの自動再作成連絡先は日次で消す`, async () => {
  const f = managementFixture({ count: 2 });
  const hash = marker === 'ERASED' ? eraseHash(f.addresses[0]) : addressHash(f.addresses[0], '7'.repeat(64));
  f.ddb.set({ PK: marker, SK: hash, ...(marker === 'CONTACT_META' ? { erased: true } : {}) });
  f.ddb.set({ PK: 'CONTACT_META', SK: addressHash(f.addresses[1], '7'.repeat(64)), attributes: { name: '在籍会員' } });
  f.deps.ses.getContact = async () => { throw failure('NotFoundException', 404); };
  const result = await f.worker({ mode: 'daily' }, f.context);
  assert.equal(result.results.backup, 'PASS');
  assert.deepEqual(f.changes.map((input) => input.EmailAddress), [f.addresses[0]]);
  assert.equal(f.contacts.length, 1);
  const backup = gunzipSync(f.files.get('backups/contacts/2026-11-03.jsonl.gz')).toString();
  assert.ok(!backup.includes(f.addresses[0]));
  const diagnostics = JSON.stringify({ notices: f.notices, logs: f.logs, audits: [...f.ddb.items.values()].filter((item) => item.PK.startsWith('AUDIT#')) });
  assert.ok(!diagnostics.includes(f.addresses[0]));
  assert.ok(f.ddb.get(marker, hash));
});
for (const error of ['NotFoundException', 'AccessDeniedException']) test(`第8段階12 消去中の${error}を適切に扱う`, async () => {
  const f = managementFixture({ count: 1 });
  f.ddb.set({ PK: 'ERASED', SK: eraseHash(f.addresses[0]) });
  f.deps.ses.deleteContact = async () => { throw failure(error, error === 'NotFoundException' ? 404 : 403); };
  const result = await f.worker({ mode: 'daily' }, f.context);
  assert.equal(result.results.backup, error === 'NotFoundException' ? 'PASS' : 'FAIL');
});

for (const env of ['dev', 'stg', 'prod']) test(`第8段階15 ${env}の一般配信で評判欠測を環境別に判断しALARMは拒否`, async () => {
  const f = fixture({ env });
  f.alarms[0].StateValue = 'INSUFFICIENT_DATA';
  const monitor = createMonitoring({ ...f.deps, store: f.store });
  const run = (deliveryValid = false) => monitor.check({ config: f.settings, deliveryValid });
  if (env === 'prod') await assert.rejects(run(), { code: 'MONITORING_UNAVAILABLE' });
  else await run();
  await run(true);
  f.alarms[0].StateValue = 'ALARM';
  await assert.rejects(run(true), { code: 'REPUTATION_ALARM' });
  f.alarms.pop(); await assert.rejects(run(true), { code: 'REPUTATION_ALARM' });
});

test('第8段階16 API-02成功後にauth-checkだけを非同期起動し、再確認後に送信可能', async () => {
  const f = managementFixture();
  const response = await f.request('PUT /settings', settingsBody(f));
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(f.invocations.length, 1);
  assert.equal(f.invocations[0].InvocationType, 'Event');
  assert.deepEqual(JSON.parse(Buffer.from(f.invocations[0].Payload)), { mode: 'auth-check' });
  assert.equal((await checker(f).run()).code, 'AUTH_CHECK_STALE');
  f.deps.ses.listContacts = async () => { throw new Error('auth-check must not back up'); };
  assert.deepEqual(await f.worker({ mode: 'auth-check' }, f.context), { status: 'PASS' });
  assert.equal((await checker(f).run()).ok, true);
  assert.equal([...f.files.keys()].some((key) => key.startsWith('backups/')), false);
});
test('第8段階16 設定の保存失敗では再確認を起動せず、起動失敗時も保存済み版を維持', async () => {
  const f = managementFixture();
  assert.equal((await f.request('PUT /settings', { ...settingsBody(f), version: 999 })).statusCode, 409);
  assert.equal(f.invocations.length, 0);
  let attempts = 0;
  f.deps.lambda.invoke = async () => { attempts += 1; throw new Error('private@example.com'); };
  const response = await f.request('PUT /settings', settingsBody(f));
  assert.equal(response.statusCode, 503, response.body);
  assert.equal(response.json.error_code, 'AUTH_CHECK_STALE');
  assert.equal(f.ddb.get('SETTINGS', 'ORG').version, 1);
  assert.equal(attempts, 1);
  assert.ok(!response.body.includes('private@example.com'));
});
test('第8段階16 再確認でDNS異常ならSTALEと区別して送信を止める', async () => {
  const f = managementFixture();
  await f.request('PUT /settings', settingsBody(f));
  f.deps.dns.resolveTxt = async () => [];
  assert.deepEqual(await f.worker({ mode: 'auth-check' }, f.context), { status: 'FAIL' });
  assert.equal((await checker(f).run()).code, 'AUTH_CHECK_FAILED');
});
test('第8段階3 日次処理も無制限枠を負のメトリクスとして出さない', async () => {
  const f = managementFixture({ count: 0 }); f.account.SendQuota.Max24HourSend = -1;
  const metrics = [];
  f.deps.metrics = createMetrics({ env: 'stg', write: (line) => metrics.push(JSON.parse(line)) }); f.resetWorker();
  assert.equal((await f.worker({ mode: 'daily' }, f.context)).results.account, 'PASS');
  assert.equal(metrics.some((entry) => entry.SesMax24HourSend !== undefined), false);
});
test('第8段階5・9・16 新しい理由は画面で日本語表示しメトリクスも出せる', () => {
  for (const code of ['AUTH_CHECK_STALE', 'IMPORT_REQUIRES_PRODUCTION']) assert.match(ERROR_MESSAGES[code], /[ぁ-んァ-ン一-龥]/);
  for (const code of ['AUTH_CHECK_STALE', 'LOCK_WAIT_TIMEOUT']) {
    assert.match(PAUSE_LABELS[code], /[ぁ-んァ-ン一-龥]/);
    assert.equal(createMetrics({ env: 'stg', write: () => {} }).emit('Paused', 1, { Reason: code }).Reason, code);
  }
});
