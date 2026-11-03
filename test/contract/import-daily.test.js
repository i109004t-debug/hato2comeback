import test from 'node:test';
import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';
import { managementFixture } from '../helpers/management.js';
import { ID, failure } from '../helpers/sending.js';
import { addressHash } from '../../src/common/log.js';
import { checkDns } from '../../src/worker/modes/daily.js';
import { createMetrics } from '../../src/common/metrics.js';

const runImport = async (f, csv) => {
  const response = await f.receive(csv);
  assert.equal(response.statusCode, 202, response.body);
  const import_id = response.json.import_id;
  return { id: import_id, result: await f.worker({ mode: 'import', import_id }, f.context) };
};

test('API-11 同じIdempotency-Keyは同一ID、S3保存・非同期起動は一回', async () => {
  const f = managementFixture();
  const first = await f.receive(f.importCsv());
  assert.equal(first.statusCode, 202, first.body);
  const second = await f.receive(f.importCsv());
  assert.equal(second.json.import_id, first.json.import_id); assert.equal(f.invocations.length, 1);
  assert.equal(f.invocations[0].InvocationType, 'Event');
  assert.equal(f.files.get(`imports/staging/${first.json.import_id}.csv`), f.importCsv());
  assert.deepEqual(JSON.parse(Buffer.from(f.invocations[0].Payload).toString()), { mode: 'import', import_id: first.json.import_id });
});

test('API-11 同時受付の冪等キー競合も記録と起動を一つにする', async () => {
  const f = managementFixture();
  const responses = await Promise.all([f.receive(f.importCsv()), f.receive(f.importCsv())]);
  assert.equal(responses[0].statusCode, 202); assert.equal(responses[1].statusCode, 202);
  assert.equal(responses[0].json.import_id, responses[1].json.import_id); assert.equal(f.invocations.length, 1);
});

test('5.4 workerの重複起動は処理を再取得せずSESジョブを増やさない', async () => {
  const f = managementFixture(); f.settings.nonprod_allowlist.push('new@example.com');
  const { id } = await runImport(f, f.importCsv());
  assert.equal((await f.worker({ mode: 'import', import_id: id })).status, 'IMPORTING');
  assert.equal(f.jobs.size, 1); assert.equal(f.changes.length, 0);
});

test('T-16 CSV内の停止済み既存宛先は除外し、既存の解除操作も妨げない', async () => {
  const f = managementFixture({ count: 2 });
  f.contacts[0].UnsubscribeAll = true; f.contacts[0].TopicPreferences[0].SubscriptionStatus = 'OPT_OUT';
  f.settings.nonprod_allowlist.push('new@example.com');
  const { id } = await runImport(f, f.importCsv(f.addresses[0], 'new@example.com,新規,2026-01-01T00:00:00Z,フォーム,news\n'));
  const report = JSON.parse(f.files.get(`imports/report/${id}.json`));
  assert.deepEqual(report.rows, [{ row: 2, code: 'EXISTING_SKIPPED' }]);
  assert.ok(!f.files.get(`imports/ready/${id}.csv`).includes(f.addresses[0]));
  assert.equal(f.contacts[0].UnsubscribeAll, true); assert.equal(f.changes.length, 0);
  assert.equal((await f.request('POST /contacts/unsubscribe', { email: f.addresses[1], scope: 'ALL' })).statusCode, 200);
  assert.equal(f.contacts[1].UnsubscribeAll, true); assert.equal(f.ddb.get('LOCK', 'CONTACT_CREATE').owner, id);
});

test('T-17 完全削除のHMACはBatchGetItemで照合しCSVから除外', async () => {
  const f = managementFixture();
  f.ddb.set({ PK: 'ERASED', SK: addressHash('new@example.com', Buffer.alloc(32, 7)) });
  const { id, result } = await runImport(f, f.importCsv());
  assert.equal(result.status, 'DONE'); assert.equal(f.jobs.size, 0);
  assert.deepEqual(JSON.parse(f.files.get(`imports/report/${id}.json`)).rows, [{ row: 2, code: 'ERASED_SKIPPED' }]);
  assert.equal(f.ddb.get('LOCK', 'CONTACT_CREATE').owner, undefined);
});

test('T-18 Gmail別表記のCSVは一件だけ、全トピックの列を出す', async () => {
  const f = managementFixture(); f.settings.nonprod_allowlist.push('ta@gmail.com');
  const { id } = await runImport(f, f.importCsv('T.a+fc@googlemail.com', 'ta@gmail.com,同一,2026-01-01T00:00:00Z,フォーム,event\n'));
  const csv = f.files.get(`imports/ready/${id}.csv`);
  assert.ok(csv.includes('topicPreferences.news,topicPreferences.event'));
  assert.ok(csv.includes('ta@gmail.com,false')); assert.ok(csv.endsWith('OPT_IN,OPT_OUT\n'));
  assert.equal(csv.match(/ta@gmail.com,false/g).length, 1);
  const report = JSON.parse(f.files.get(`imports/report/${id}.json`));
  assert.deepEqual(report.rows, [{ row: 3, code: 'DUPLICATE_IN_FILE' }]);
  assert.ok(!JSON.stringify(report).includes('@'));
  const job = [...f.jobs.values()][0];
  assert.equal(job.input.ImportDestination.ContactListDestination.ContactListImportAction, 'PUT');
  assert.equal(job.input.ImportDataSource.S3Url, `s3://data/imports/ready/${id}.csv`);
});

test('T-21 許可リスト外CSVはNOT_ALLOWED_IN_ENVで除外', async () => {
  const f = managementFixture();
  const { id, result } = await runImport(f, f.importCsv());
  assert.equal(result.status, 'DONE'); assert.equal(f.jobs.size, 0);
  assert.deepEqual(JSON.parse(f.files.get(`imports/report/${id}.json`)).rows, [{ row: 2, code: 'NOT_ALLOWED_IN_ENV' }]);
});

test('T-51 取込照合からSES完了まで個別登録と別取込を拒否、完了後だけ解放', async () => {
  const f = managementFixture(); f.settings.nonprod_allowlist.push('new@example.com');
  const { id } = await runImport(f, f.importCsv());
  const create = await f.request('POST /contacts', { email: f.addresses[0], topics: ['news'], consent: { at: '2026-01-01T00:00:00Z', source: 'フォーム' } });
  assert.equal(create.json.error_code, 'CONTACT_IMPORT_IN_PROGRESS');
  assert.equal((await f.receive(f.importCsv(), 'different')).json.error_code, 'CONTACT_IMPORT_IN_PROGRESS');
  assert.equal((await f.receive(f.importCsv())).json.import_id, id);
  f.jobs.get('job1').JobStatus = 'COMPLETED';
  const result = await f.request(`GET /imports/${id}`);
  assert.equal(result.json.status, 'DONE', result.body); assert.equal(result.json.processed, 1);
  assert.equal(f.ddb.get('LOCK', 'CONTACT_CREATE').owner, undefined);
  assert.ok([...f.ddb.items.values()].some((item) => item.action === 'IMPORT_COMPLETE'));
});

test('5.4 取込作成の応答不明は再試行も排他解放もしない', async () => {
  const f = managementFixture(); f.settings.nonprod_allowlist.push('new@example.com');
  let calls = 0;
  f.deps.ses.createImportJob = async () => { calls += 1; throw failure('TimeoutError'); };
  const received = await f.receive(f.importCsv()); const import_id = received.json.import_id;
  await assert.rejects(f.worker({ mode: 'import', import_id }), { code: 'INTERNAL' });
  assert.equal(f.ddb.get('IMPORT', import_id).status, 'NEEDS_REVIEW');
  assert.equal(f.ddb.get('LOCK', 'CONTACT_CREATE').owner, import_id);
  await f.worker({ mode: 'import', import_id }); assert.equal(calls, 1);
  assert.ok(f.notices.some((item) => item.code === 'IMPORT_NEEDS_REVIEW'));
});

test('5.4 未処理のHMACキーを一致なしとして登録しない', async () => {
  const f = managementFixture(); f.settings.nonprod_allowlist.push('new@example.com');
  f.deps.ddb.batchGetItem = async (input) => ({ Responses: {}, UnprocessedKeys: input.RequestItems });
  const received = await f.receive(f.importCsv());
  await assert.rejects(f.worker({ mode: 'import', import_id: received.json.import_id }), { code: 'INTERNAL' });
  assert.equal(f.jobs.size, 0);
});

test('5.4 HMAC照合は100件ずつ、既存宛先は最後のページまで除外', async () => {
  const f = managementFixture({ env: 'prod', count: 0 });
  const lines = Array.from({ length: 205 }, (_, i) => `u${i}@example.com,会員,2026-01-01T00:00:00Z,フォーム,news`).join('\n');
  let batchCalls = 0;
  const original = f.ddb.batchGetItem;
  f.ddb.batchGetItem = async (input) => { batchCalls += 1; return original(input); };
  f.contactPages = [{ Contacts: [{ EmailAddress: 'u0@example.com' }], NextToken: '1' }, { Contacts: [{ EmailAddress: 'u204@example.com', UnsubscribeAll: true }] }];
  const { id } = await runImport(f, 'email,name,consent_at,consent_source,topics\n' + lines + '\n');
  assert.equal(batchCalls, 3); assert.equal(f.listInputs.length, 2);
  const report = JSON.parse(f.files.get(`imports/report/${id}.json`));
  assert.equal(report.ready, 203); assert.equal(report.rows.length, 2);
  assert.ok(report.rows.every((row) => row.code === 'EXISTING_SKIPPED'));
});

test('T-51 完全削除とCSVのHMAC照合は同じ排他により競合しない', async () => {
  const f = managementFixture({ env: 'prod' });
  const received = await f.receive(f.importCsv());
  const original = f.ddb.batchGetItem;
  let eraseResponse;
  f.ddb.batchGetItem = async (input) => {
    eraseResponse = await f.request('POST /contacts/erase', { email: 'new@example.com', note: '同時削除' });
    return original(input);
  };
  await f.worker({ mode: 'import', import_id: received.json.import_id });
  assert.equal(eraseResponse.json.error_code, 'CONTACT_IMPORT_IN_PROGRESS');
  assert.equal(f.ddb.get('ERASED', addressHash('new@example.com', Buffer.alloc(32, 7))), undefined);
});

test('5.4 完了記録の後に解放が失敗しても次の日次点検で解放できる', async () => {
  const f = managementFixture(); f.settings.nonprod_allowlist.push('new@example.com');
  const { id } = await runImport(f, f.importCsv()); f.jobs.get('job1').JobStatus = 'COMPLETED';
  let failed = false;
  f.ddb.beforeUpdate = (input) => {
    if (!failed && input.Key.PK.S === 'LOCK' && input.Key.SK.S === 'CONTACT_CREATE' && input.UpdateExpression.includes('REMOVE')) { failed = true; throw failure('TimeoutError'); }
  };
  const response = await f.request(`GET /imports/${id}`);
  assert.equal(response.statusCode, 500); assert.equal(f.ddb.get('IMPORT', id).status, 'DONE'); assert.equal(f.ddb.get('LOCK', 'CONTACT_CREATE').owner, id);
  await f.worker({ mode: 'daily' });
  assert.equal(f.ddb.get('LOCK', 'CONTACT_CREATE').owner, undefined);
});

test('13.5 バックアップの保存失敗は購読者数を更新せず、他の日次点検を続ける', async () => {
  const f = managementFixture(); f.onPut = (input) => { if (input.Key.startsWith('backups/')) throw failure('TimeoutError'); };
  const response = await f.worker({ mode: 'daily' });
  assert.equal(response.results.backup, 'FAIL'); assert.equal(response.results.authentication, 'PASS');
  assert.equal(f.ddb.get('SETTINGS', 'TOPIC_COUNTS'), undefined);
  assert.ok(f.notices.some((item) => item.code === 'DAILY_FAILED'));
});

test('13.5 バックアップと購読者数は同じ全件取得から作り、全停止を数えない', async () => {
  const f = managementFixture({ count: 3 });
  f.contacts[0].UnsubscribeAll = true;
  f.contacts[1].TopicPreferences.push({ TopicName: 'event', SubscriptionStatus: 'OPT_IN' });
  f.contacts[2].TopicPreferences = [{ TopicName: 'news', SubscriptionStatus: 'OPT_OUT' }];
  const result = await f.worker({ mode: 'daily' });
  assert.ok(Object.values(result.results).every((value) => value === 'PASS'), JSON.stringify(result));
  const backup = gunzipSync(f.files.get('backups/contacts/2026-11-03.jsonl.gz')).toString('utf8').trim().split('\n').map(JSON.parse);
  assert.equal(backup.length, 3); assert.equal(backup[0].UnsubscribeAll, true);
  assert.deepEqual(f.ddb.get('SETTINGS', 'TOPIC_COUNTS').counts, { news: 1, event: 1 });
  assert.equal(f.listInputs.length, 1); assert.equal(f.listInputs[0].Filter, undefined); assert.equal(f.listInputs[0].PageSize, 1000);
  assert.equal(f.ddb.get('SETTINGS', 'AUTH_STATUS').status, 'PASS');
  assert.ok(f.metrics.some((item) => item.name === 'SesMax24HourSend'));
});

test('13.4 DNSハッシュはTXT分割・回答順・CNAME末尾ドットで変わらない', async () => {
  const f = managementFixture();
  const first = await checkDns(f.deps, f.identity);
  const resolveTxt = f.deps.dns.resolveTxt;
  f.deps.dns.resolveTxt = async (name) => (await resolveTxt(name)).map((parts) => [parts[0].slice(0, 5), parts[0].slice(5)]);
  f.deps.dns.resolveCname = async (name) => [`${name.split('.')[0]}.DKIM.AMAZONSES.COM`];
  f.identity.DkimAttributes.Tokens.reverse();
  const second = await checkDns(f.deps, f.identity);
  assert.equal(first.status, 'PASS'); assert.equal(second.status, 'PASS'); assert.equal(first.dns_config_hash, second.dns_config_hash);
});

for (const fault of ['spf-duplicate', 'dmarc-missing', 'mx-wrong', 'dkim-missing', 'identity-disabled']) {
  test(`13.4 DNS・送信元の構造不備はFAILに保存して通知: ${fault}`, async () => {
    const f = managementFixture();
    const original = f.deps.dns.resolveTxt;
    if (fault === 'spf-duplicate') f.deps.dns.resolveTxt = async (name) => name === 'example.com' ? [['v=spf1 include:amazonses.com ~all'], ['v=spf1 -all']] : original(name);
    if (fault === 'dmarc-missing') f.deps.dns.resolveTxt = async (name) => name.startsWith('_dmarc.') ? [] : original(name);
    if (fault === 'mx-wrong') f.deps.dns.resolveMx = async () => [{ priority: 5, exchange: 'wrong.example.com' }];
    if (fault === 'dkim-missing') f.deps.dns.resolveCname = async () => [];
    if (fault === 'identity-disabled') f.identity.DkimAttributes.SigningEnabled = false;
    await f.worker({ mode: 'daily' });
    assert.equal(f.ddb.get('SETTINGS', 'AUTH_STATUS').status, 'FAIL');
    assert.ok(f.notices.some((item) => item.code === 'AUTH_CHECK_FAILED'));
    f.setCampaign({ status: 'APPROVED' });
    assert.equal((await f.request(`POST ${f.campaignPath}/start`, { mode: 'NOW' })).json.error_code, 'AUTH_CHECK_FAILED');
  });
}

test('13.4 DNS取得不能はUNKNOWN、前のPASS時刻を更新せず開始を拒否', async () => {
  const f = managementFixture(); const previousTime = f.auth.checked_at;
  f.deps.dns.resolveTxt = async () => { throw Object.assign(new Error('DNS failed'), { code: 'ESERVFAIL' }); };
  await f.worker({ mode: 'daily' });
  const auth = f.ddb.get('SETTINGS', 'AUTH_STATUS');
  assert.equal(auth.status, 'UNKNOWN'); assert.equal(auth.checked_at, previousTime); assert.ok(auth.attempted_at);
  assert.ok(f.notices.some((item) => item.code === 'AUTH_CHECK_UNKNOWN'));
});

test('T-51 DNS値変更は受入記録を失効、記録の期限切れも開始不可', async () => {
  const f = managementFixture({ env: 'prod' });
  await f.worker({ mode: 'daily' });
  const auth = f.ddb.get('SETTINGS', 'AUTH_STATUS');
  assert.notEqual(auth.dns_config_hash, f.auth.dns_config_hash);
  assert.equal(f.ddb.get('SETTINGS', 'ORG').delivery_check.status, 'FAIL');
  assert.ok(f.notices.some((item) => item.code === 'DELIVERY_CHECK_REQUIRED'));
  const g = managementFixture({ env: 'prod' });
  g.ddb.set({ ...g.org, delivery_check: { ...g.delivery, passed_at: new Date(g.deps.now() - 91 * 86400000).toISOString() } });
  g.setCampaign({ status: 'APPROVED' });
  assert.equal((await g.request(`POST ${g.campaignPath}/start`, { mode: 'NOW' })).json.error_code, 'DELIVERY_CHECK_REQUIRED');
});

test('13.4 DKIM無効を検出した受入記録はDNS値が同じでも失効し、自動復活しない', async () => {
  const f = managementFixture({ env: 'prod' });
  const observation = await checkDns(f.deps, f.identity);
  f.ddb.set({ ...f.org, delivery_check: { ...f.delivery, dns_config_hash: observation.dns_config_hash } });
  f.identity.DkimAttributes.SigningEnabled = false;
  await f.worker({ mode: 'daily' });
  assert.equal(f.ddb.get('SETTINGS', 'ORG').delivery_check.status, 'FAIL');
  f.identity.DkimAttributes.SigningEnabled = true;
  await f.worker({ mode: 'daily' });
  assert.equal(f.ddb.get('SETTINGS', 'AUTH_STATUS').status, 'PASS');
  assert.equal(f.ddb.get('SETTINGS', 'ORG').delivery_check.status, 'FAIL');
});

test('13.4 完了ジョブは画面を開かなくても日次で照合・排他解放', async () => {
  const f = managementFixture(); f.settings.nonprod_allowlist.push('new@example.com');
  const { id } = await runImport(f, f.importCsv());
  f.jobs.get('job1').JobStatus = 'COMPLETED';
  await f.worker({ mode: 'daily' });
  assert.equal(f.ddb.get('IMPORT', id).status, 'DONE'); assert.equal(f.ddb.get('LOCK', 'CONTACT_CREATE').owner, undefined);
});

test('5.4 失敗したSESジョブの排他は管理者による終端確認まで保持', async () => {
  const f = managementFixture(); f.settings.nonprod_allowlist.push('new@example.com');
  const { id } = await runImport(f, f.importCsv()); f.jobs.get('job1').JobStatus = 'FAILED';
  await f.worker({ mode: 'daily' });
  assert.equal(f.ddb.get('IMPORT', id).status, 'FAILED'); assert.equal(f.ddb.get('LOCK', 'CONTACT_CREATE').owner, id);
  f.role = 'sender'; f.resetApi(); await f.request(`GET /imports/${id}`); assert.equal(f.ddb.get('LOCK', 'CONTACT_CREATE').owner, id);
  f.role = 'admin'; f.resetApi(); await f.request(`GET /imports/${id}`); assert.equal(f.ddb.get('LOCK', 'CONTACT_CREATE').owner, undefined);
});

test('13.4 保存済みジョブIDがあれば日次で記録を補い、別ジョブを作らない', async () => {
  const f = managementFixture(); f.settings.nonprod_allowlist.push('new@example.com');
  const { id } = await runImport(f, f.importCsv());
  f.ddb.set({ ...f.ddb.get('IMPORT', id), status: 'SUBMITTING', job_id: '' });
  f.jobs.get('job1').JobStatus = 'COMPLETED';
  await f.worker({ mode: 'daily' });
  assert.equal(f.ddb.get('IMPORT', id).status, 'DONE'); assert.equal(f.jobs.size, 1);
});

test('13.4 一年以上の終了配信は本文・旧版テンプレートを消し、件数を保持', async () => {
  const f = managementFixture();
  f.setCampaign({ status: 'COMPLETED', rev: 2, completed_at: new Date(f.deps.now() - 366 * 86400000).toISOString(), subject: '古い件名', body_text: '古い本文', footer_text: '古い法定表示', counts: { accepted: 10 }, template_name: `pl-c-${ID}-2` });
  f.templates.set(`pl-c-${ID}-1`, {}); f.templates.set(`pl-c-${ID}-2`, {});
  await f.worker({ mode: 'daily' });
  const campaign = f.getCampaign(); assert.equal(campaign.subject, undefined); assert.equal(campaign.body_text, undefined);
  assert.equal(campaign.content_erased, true); assert.equal(campaign.counts.accepted, 10); assert.equal(f.templates.size, 0);
  assert.ok([...f.ddb.items.values()].some((item) => item.action === 'CONTENT_ERASE'));
});

test('13.4 7日停止は中止し、期限切れロックは解放せず通知', async () => {
  const f = managementFixture(); f.setCampaign({ status: 'PAUSED', paused_at: new Date(f.deps.now() - 8 * 86400000).toISOString() });
  f.ddb.set({ PK: 'LOCK', SK: 'SEND', owner: 'stuck', expires_at_ms: f.deps.now() - 1 });
  await f.worker({ mode: 'daily' });
  assert.equal(f.getCampaign().status, 'CANCELLED'); assert.equal(f.getCampaign().cancel_reason, 'PAUSE_TIMEOUT');
  assert.equal(f.ddb.get('LOCK', 'SEND').owner, 'stuck'); assert.ok(f.notices.some((item) => item.code === 'SEND_LOCK_EXPIRED'));
});

test('7.8 日次で終了配信のSend欠測を通知し、次の一般配信を拒否', async () => {
  const f = managementFixture();
  f.setCampaign({ status: 'COMPLETED', counts: { accepted: 200 }, started_at: new Date(f.deps.now() - 3600000).toISOString(), completed_at: new Date(f.deps.now() - 1800000).toISOString(), last_send_at: new Date(f.deps.now() - 1800000).toISOString() });
  await f.worker({ mode: 'daily' });
  assert.ok(f.notices.some((item) => item.code === 'EVENTS_MISSING'));
  const id2 = '01K9542S00BBBBBBBBBBBBBBBB';
  f.ddb.set({ ...f.getCampaign(), campaign_id: id2, SK: id2, status: 'APPROVED', started_at: '', counts: {} });
  assert.equal((await f.request(`POST /campaigns/${id2}/start`, { mode: 'NOW' })).json.error_code, 'MONITORING_UNAVAILABLE');
});

test('T-49 日次でもFirehose配送失敗とイベント先の異常を通知', async () => {
  const f = managementFixture(); f.alarms.find((item) => item.AlarmName.endsWith('firehose-freshness')).StateValue = 'ALARM';
  const result = await f.worker({ mode: 'daily' });
  assert.equal(result.results.evidence, 'FAIL'); assert.ok(f.notices.some((item) => item.code === 'EVENT_LOG_STALE'));
  const g = managementFixture(); g.setCampaign({ status: 'APPROVED' }); g.destinations.EventDestinations[1].Enabled = false;
  assert.equal((await g.request(`POST ${g.campaignPath}/start`, { mode: 'NOW' })).json.error_code, 'EVENT_DESTINATION_DISABLED');
});

test('13.2 実際のEMF検証器でも日次・取込・APIのメトリクスが有効', async () => {
  const f = managementFixture(); const entries = [];
  f.deps.metrics = createMetrics({ env: f.deps.env, now: f.deps.now, write: (line) => entries.push(JSON.parse(line)) });
  f.resetApi(); f.resetWorker();
  const response = await f.worker({ mode: 'daily' });
  assert.equal(response.results.account, 'PASS');
  await runImport(f, f.importCsv());
  await f.request('GET /missing');
  for (const name of ['SesSendingEnabled', 'SesMax24HourSend', 'SesSentLast24Hours', 'SesMaxSendRate', 'ImportRows', 'ImportSkipped', 'ImportRejected', 'ApiLatencyMs', 'ApiError4xx']) assert.ok(entries.some((item) => Object.hasOwn(item, name)), name);
  assert.ok(entries.every((item) => !JSON.stringify(item).includes('@')));
});
