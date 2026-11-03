import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { managementFixture } from '../helpers/management.js';
import { failure, ID } from '../helpers/sending.js';
import { createHandler as eventsHandler, eventRecord } from '../../src/events/handler.js';
import { sendingConfigHash, MESSAGE_CODE_FILES, DELIVERY_CASES } from '../../src/common/precheck.js';
import { currentConfigHash, notifyAcceptanceExpiry } from '../../src/common/acceptance.js';
import { addressHash } from '../../src/common/log.js';
import { evidenceBytes } from '../../src/api/routes/delivery-check.js';
import { validateImportCsv } from '../../src/common/csv.js';

const DAY = 86400000;
const code = (response, status, error) => { assert.equal(response.statusCode, status, response.body); assert.equal(response.json.error_code, error, response.body); };
const rid = (f, email = f.addresses[0]) => addressHash(email, '7'.repeat(64));
const thirdAdmin = (f) => f.staff.set('third-admin', { ...structuredClone(f.staff.get('other-admin')), Username: 'third-admin', Attributes: [{ Name: 'sub', Value: 'third-sub' }] });
const eventFor = (f, type = 'Send', changes = {}) => ({ source: 'aws.ses', id: 'abcd1234-1234-4567-8910-abcdefghijkl', time: new Date(f.deps.now()).toISOString(), detail: { eventType: type, mail: { timestamp: new Date(f.deps.now()).toISOString(), destination: ['private@example.com'], tags: { rid: [rid(f)], campaign: [ID] } }, [type === 'Rendering Failure' ? 'failure' : type[0].toLowerCase() + type.slice(1)]: { timestamp: new Date(f.deps.now()).toISOString() } }, ...changes });

test('T-63 8.5 配送記録の8種類はアドレスを持たず、同じイベントを重複保存しない', async () => {
  const f = managementFixture({ count: 1 });
  const handler = eventsHandler({ ...f.deps, store: f.store });
  for (const type of ['Send', 'Delivery', 'Bounce', 'Complaint', 'DeliveryDelay', 'Reject', 'Subscription', 'Rendering Failure']) {
    const event = eventFor(f, type);
    if (type === 'Bounce') event.detail.bounce = { bounceType: 'Permanent', bouncedRecipients: [{ emailAddress: 'private@example.com', diagnosticCode: `550 private@example.com ${'x'.repeat(350)}` }] };
    if (type === 'Subscription') event.detail.subscription.newTopicPreferences = { unsubscribeAll: true, topicSubscriptionStatus: [{ topicName: 'news', subscriptionStatus: 'OPT_OUT', email: 'private@example.com' }] };
    assert.equal((await handler(event)).status, 'RECORDED');
    assert.equal((await handler(event)).status, 'DUPLICATE');
  }
  const rows = [...f.ddb.items.values()].filter((item) => item.PK.startsWith('ADDR#'));
  assert.equal(rows.length, 8);
  assert.ok(!JSON.stringify(rows).includes('@'));
  assert.equal(rows.find((row) => row.type === 'Bounce').diagnostic_code.length, 300);
  assert.equal(rows[0].expires_at, Math.floor(f.deps.now() / 1000) + 180 * 86400);
  assert.deepEqual(rows.find((row) => row.type === 'Subscription').subscription, { unsubscribe_all: true, topics: [{ topic: 'news', status: 'OPT_OUT' }] });
  assert.ok(f.ddb.calls.every((call) => call.ConditionExpression === 'attribute_not_exists(PK)'));
});

test('T-63 rid欠落・不正値・種類不明・期限外は捨て、保存失敗は握りつぶさない', async () => {
  const f = managementFixture({ count: 1 });
  for (const modify of [
    (e) => { delete e.detail.mail.tags.rid; }, (e) => { e.detail.mail.tags.rid = ['private@example.com']; },
    (e) => { e.detail.mail.tags.rid.push('a'.repeat(64)); }, (e) => { e.detail.eventType = 'Open'; },
    (e) => { e.source = 'other'; }, (e) => { e.detail.send.timestamp = new Date(f.deps.now() - 181 * DAY).toISOString(); },
  ]) { const event = eventFor(f); modify(event); assert.equal(eventRecord(event, f.deps.now()), null); }
  const handler = eventsHandler({ env: 'stg', now: f.deps.now, store: { put: async () => { throw failure('AccessDeniedException'); } } });
  await assert.rejects(handler(eventFor(f)), { name: 'AccessDeniedException' });
});

test('API-31 管理者と配信担当だけに180日以内の記録を新しい順に最大200件返す', async () => {
  const f = managementFixture({ count: 1 });
  for (let i = 0; i < 205; i += 1) {
    const occurred_at = new Date(f.deps.now() - i * 1000).toISOString();
    f.ddb.set({ PK: `ADDR#${rid(f)}`, SK: occurred_at, occurred_at, type: 'Send', campaign_id: ID });
  }
  f.ddb.set({ PK: `ADDR#${rid(f)}`, SK: '2020', occurred_at: '2020-01-01T00:00:00Z', type: 'Send' });
  const response = await f.request('POST /contacts/events', { email: f.addresses[0] });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json.events.length, 200);
  assert.ok(response.json.events[0].occurred_at > response.json.events[199].occurred_at);
  assert.equal(response.json.suppression, null);
  for (const role of ['sender', 'viewer', 'approver']) {
    f.role = role; f.resetApi();
    assert.equal((await f.request('POST /contacts/events', { email: f.addresses[0] })).statusCode, role === 'sender' ? 200 : 403);
  }
});

test('8.6 結果不明のSend索引だけをSES受付確認に数え、自動再送しない', async () => {
  const f = managementFixture({ count: 2 });
  const key = `results/${ID}/00000-001.jsonl`;
  f.files.set(key, f.addresses.map((email, i) => JSON.stringify({ a: rid(f, email), r: i ? 'FAILED' : 'UNKNOWN', m: 'm***@example.com' })).join('\n'));
  f.setCampaign({ status: 'COMPLETED', counts: { unknown: 1 }, result_keys: [key], unknown_review: { status: 'OPEN', count: 1, decisions: [] } });
  const handler = eventsHandler({ ...f.deps, store: f.store });
  await handler(eventFor(f, 'Delivery'));
  const first = await f.request(`GET /campaigns/${ID}/failures`);
  assert.equal(first.json.ses_accepted_count, 0, first.body);
  await handler(eventFor(f));
  const second = await f.request(`GET /campaigns/${ID}/failures`);
  assert.equal(second.json.ses_accepted_count, 1, second.body);
  const decision = await f.request(`POST /campaigns/${ID}/unknowns`, { decision: 'HOLD', note: '受付を確認' });
  assert.equal(decision.json.unknown_review.decisions[0].ses_accepted_count, 1, decision.body);
  assert.equal(f.sends.length, 0);
});

test('16.5 送信設定ハッシュはメール生成の3モジュールだけを読み、監視・日次・画面変更で変わらない', () => {
  const f = managementFixture();
  const settings = { env: f.deps.env, region: f.deps.region, accountId: f.deps.accountId, senderDomain: f.deps.senderDomain, contactList: f.deps.contactList, configSet: f.deps.configSet, from_local: f.org.from_local, from_name: f.org.from_name, reply_to: f.org.reply_to, legal: f.org.legal };
  const source = Object.fromEntries(MESSAGE_CODE_FILES.map((name) => [name, readFileSync(new URL(`../../src/common/${name}`, import.meta.url), 'utf8')]));
  const read = (name) => { assert.ok(MESSAGE_CODE_FILES.includes(name)); return source[name]; };
  const initial = sendingConfigHash(settings, read);
  assert.equal(initial, currentConfigHash(f.deps, f.org));
  assert.equal(initial, sendingConfigHash({ ...settings, monitoringAlarms: ['new-alarm'], eventStreamArn: 'other-stream', daily_send_cap: 5, forecast: 'changed', web: 'changed' }, read));
  for (const name of ['monitoring.js', 'forecast.js', '../worker/modes/daily.js', '../api/routes/campaigns.js', '../../web/js/views/send.js']) {
    source[name] = 'changed'; assert.equal(initial, sendingConfigHash(settings, read));
  }
  for (const name of MESSAGE_CODE_FILES) {
    const original = source[name]; source[name] += '\n// changed mail generation\n';
    assert.notEqual(initial, sendingConfigHash(settings, read)); source[name] = original;
  }
  for (const [key, value] of [['from_name', '新しい差出人'], ['senderDomain', 'other.example.com'], ['configSet', 'other'], ['reply_to', 'other@example.com']]) assert.notEqual(initial, sendingConfigHash({ ...settings, [key]: value }, read));
});

test('API-32 スタッフ一覧は役割を重複なく統合し、有効な管理者数を返す', async () => {
  const f = managementFixture(); f.staff.get('other-admin').roles.push('sender');
  const response = await f.request('GET /staff');
  assert.equal(response.statusCode, 200);
  assert.equal(response.json.items.length, 2);
  assert.deepEqual(response.json.items.find((item) => item.username === 'other-admin').roles, ['admin', 'sender']);
  assert.equal(response.json.enabled_admins, 2);
});

test('API-32 追加はCognitoのメール案内とグループ追加だけを行い、監査とSNSを残す', async () => {
  const f = managementFixture();
  const response = await f.request('POST /staff', { email: 'new.staff@example.com', name: '運営スタッフ', roles: ['sender', 'approver'] });
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(f.staffCalls.map((item) => item.method), ['create', 'add', 'add']);
  assert.deepEqual(f.staffCalls[0].input.DesiredDeliveryMediums, ['EMAIL']);
  assert.equal(f.staffCalls[0].input.TemporaryPassword, undefined);
  assert.equal(f.ddb.get('LOCK', 'STAFF').owner, undefined);
  assert.ok(f.notices.some((item) => item.code === 'STAFF_CHANGED'));
  assert.ok([...f.ddb.items.values()].some((item) => item.action === 'STAFF_CREATE' && item.details.phase === 'COMPLETED'));
});

for (const action of ['roles', 'disable', 'enable', 'reset-mfa', 'reset-password']) {
  test(`T-64 自分自身の${action}は変更前に拒否する`, async () => {
    const f = managementFixture();
    code(await f.request(`POST /staff/user/${action}`, action === 'roles' ? { roles: ['viewer'] } : {}), 409, 'SELF_CHANGE_FORBIDDEN');
    assert.equal(f.staffCalls.length, 0);
    assert.equal(f.ddb.get('LOCK', 'STAFF').owner, undefined);
  });
}

test('T-64 最後の有効な管理者の無効化・降格を拒否し、未ログインの管理者は数えない', async () => {
  const f = managementFixture();
  f.staff.get('user').Enabled = false;
  f.staff.set('pending', { Username: 'pending', Enabled: true, UserStatus: 'FORCE_CHANGE_PASSWORD', roles: ['admin'], Attributes: [] });
  for (const [action, body] of [['disable', {}], ['roles', { roles: ['sender'] }]]) code(await f.request(`POST /staff/other-admin/${action}`, body), 409, 'LAST_ADMIN');
  assert.equal(f.staffCalls.length, 0);
});

for (const authTime of [undefined, -1, 901, 'bad', null]) {
  test(`T-64 auth_time=${authTime} の変更要求を401で止める`, async () => {
    const f = managementFixture();
    const claims = { sub: f.sub, token_use: 'access', client_id: 'web', ...(authTime === undefined ? {} : { auth_time: typeof authTime === 'number' ? Math.floor(f.deps.now() / 1000) - authTime : authTime }) };
    code(await f.request('POST /staff/other-admin/disable', {}, { requestContext: { http: { method: 'POST' }, authorizer: { jwt: { claims } } } }), 401, 'REAUTH_REQUIRED');
    assert.equal(f.staffCalls.length, 0);
  });
}

test('API-33 役割の置換・無効化とサインアウト・MFA・有効化・パスワード再設定', async () => {
  const f = managementFixture(); thirdAdmin(f);
  for (const [action, body] of [['roles', { roles: ['sender', 'viewer'] }], ['disable', {}], ['enable', {}], ['reset-mfa', {}], ['reset-password', {}]]) assert.equal((await f.request(`POST /staff/other-admin/${action}`, body)).statusCode, 200);
  assert.deepEqual(f.staff.get('other-admin').roles, ['sender', 'viewer']);
  assert.deepEqual(f.staffCalls.map((item) => item.method), ['add', 'add', 'remove', 'disable', 'signout', 'enable', 'mfa', 'signout', 'password']);
  assert.deepEqual(f.staffCalls.find((item) => item.method === 'mfa').input.SoftwareTokenMfaSettings, { Enabled: false, PreferredMfa: false });
  assert.equal(f.notices.filter((item) => item.code === 'STAFF_CHANGED').length, 5);
});

test('11.5 スタッフ変更の結果不明は自動再試行せず排他を保持して通知する', async () => {
  const f = managementFixture(); thirdAdmin(f); let attempts = 0;
  f.deps.cognito.adminDisableUser = async () => { attempts += 1; throw failure('TimeoutError'); };
  assert.equal((await f.request('POST /staff/other-admin/disable', {})).statusCode, 500);
  code(await f.request('POST /staff/other-admin/disable', {}), 409, 'STATE_CONFLICT');
  assert.equal(attempts, 1);
  assert.ok(f.ddb.get('LOCK', 'STAFF').owner);
  assert.ok(f.notices.some((item) => item.code === 'STAFF_CHANGED'));
});

test('T-65 API-34 は15項目・担当を返し、詳細だけを管理者に見せ、60秒キャッシュする', async () => {
  const f = managementFixture({ env: 'prod' });
  let calls = 0; const original = f.deps.ses.getAccount;
  f.deps.ses.getAccount = async (...args) => { calls += 1; return original(...args); };
  const first = await f.request('GET /readiness');
  assert.equal(first.statusCode, 200, first.body);
  assert.equal(first.json.items.length, 15);
  assert.ok(first.json.items.every((item) => item.status === 'OK'), JSON.stringify(first.json.items));
  assert.ok(first.json.items.every((item) => item.owner && item.action && Object.hasOwn(item, 'detail')));
  await f.request('GET /readiness'); assert.equal(calls, 1);
  f.advance(60000); await f.request('GET /readiness'); assert.equal(calls, 2);
  f.role = 'viewer'; f.resetApi();
  const viewer = await f.request('GET /readiness');
  assert.ok(viewer.json.items.every((item) => !Object.hasOwn(item, 'detail')));
});

test('T-65 準備状況は停止・警告・取得不能を正常扱いしない', async () => {
  const f = managementFixture({ env: 'prod' });
  f.settings.sending_enabled = false; f.staff.delete('other-admin');
  f.account.SendQuota.SentLast24Hours = f.account.SendQuota.Max24HourSend;
  f.identity.VerifiedForSendingStatus = false;
  f.alarms[0].StateValue = 'INSUFFICIENT_DATA';
  f.destinations.EventDestinations.pop();
  f.deps.kms.generateMac = async () => { throw failure('AccessDeniedException'); };
  f.ddb.set({ ...f.auth, status: 'FAIL' });
  f.org.delivery_check.passed_at = new Date(f.deps.now() - 91 * DAY).toISOString(); f.ddb.set(f.org);
  f.setCampaign({ status: 'PAUSED', pause_reason: 'SES_PAUSED', unknown_review: { status: 'OPEN' } });
  const items = (await f.request('GET /readiness')).json.items;
  const status = (id) => items.find((item) => item.id === id)?.status;
  for (const id of ['sending_enabled', 'authentication', 'event_destinations', 'delivery_check', 'quota']) assert.equal(status(id), 'BLOCKED', id);
  for (const id of ['administrators', 'system_paused', 'unknown_review', 'reputation']) assert.equal(status(id), 'WARN', id);
  assert.equal(status('erase_key'), 'BLOCKED');
  f.deps.ses.getAccount = async () => { throw failure('TimeoutError'); }; f.resetApi();
  assert.equal((await f.request('GET /readiness')).json.items.find((item) => item.id === 'ses').status, 'UNKNOWN');
});

async function startCheck(f) {
  const response = await f.request('POST /settings/delivery-check', {});
  assert.equal(response.statusCode, 201, response.body);
  return response.json;
}

test('T-66 API-26〜29 必須試験と証跡を登録し、サーバーハッシュで原子的に確定する', async () => {
  const f = managementFixture({ env: 'prod' });
  const check = await startCheck(f);
  assert.equal(check.expires_at, Math.floor(f.deps.now() / 1000) + 30 * 86400);
  const path = `/settings/delivery-check/${check.check_id}`;
  code(await f.request(`${'POST'} ${path}/submit`, { note: '確認済み' }), 422, 'DELIVERY_CHECK_REQUIRED');
  for (const id of DELIVERY_CASES) {
    assert.equal((await f.request(`PUT ${path}/cases/${id}`, { result: 'PASS', note: '実機で確認済み' })).statusCode, 200);
    const uploaded = await f.request(`POST ${path}/evidence`, { case_id: id, file_name: '../日本語 mail.eml', content_base64: Buffer.from('private@example.com header').toString('base64') });
    assert.equal(uploaded.statusCode, 200, uploaded.body);
    const key = uploaded.json.cases[id].evidence[0];
    assert.match(key, new RegExp(`^delivery-checks/${check.check_id}/${id}/[0-9A-HJKMNP-TV-Z]{26}-[A-Za-z0-9._-]+$`));
    assert.ok(!key.split('/').includes('..'));
  }
  const response = await f.request(`POST ${path}/submit`, { note: '観測不足を確認し日次上限を承認' });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json.delivery_check.status, 'PASS');
  assert.equal(response.json.delivery_check.by, f.sub);
  assert.equal(response.json.delivery_check.evidence_keys.length, DELIVERY_CASES.length);
  assert.equal(f.ddb.get('ACCEPTANCE', check.check_id).status, 'SUBMITTED');
  assert.equal(f.ddb.get('ACCEPTANCE', check.check_id).expires_at, undefined);
  assert.equal(f.ddb.get('SETTINGS', 'ORG').delivery_check.config_hash, check.config_hash);
  const list = await f.request('GET /settings/delivery-check');
  assert.equal(list.json.checks.length, 0);
  assert.equal(list.json.delivery_check.remaining_days, 90);
  assert.ok(!list.body.includes('private@example.com'));
  code(await f.request(`PUT ${path}/cases/T-25`, { result: 'FAIL', note: '変更' }), 409, 'STATE_CONFLICT');
});

test('T-66 設定変更・DNS変更後は確定不可で、FAILは一般配信を止める', async () => {
  for (const dns of [false, true]) {
    const f = managementFixture({ env: 'prod' });
    const check = await startCheck(f);
    const path = `/settings/delivery-check/${check.check_id}`;
    await f.request(`PUT ${path}/cases/T-25`, { result: 'FAIL', note: '不合格' });
    if (dns) f.deps.dns.resolve4 = async () => ['192.0.2.11'];
    else { f.org.from_name = '変更'; f.ddb.set(f.org); }
    code(await f.request(`POST ${path}/submit`, { note: '確定' }), 409, 'CHECK_HASH_CHANGED');
    assert.equal(f.ddb.get('ACCEPTANCE', check.check_id).status, 'OPEN');
  }
  const f = managementFixture({ env: 'prod' }); const check = await startCheck(f);
  const path = `/settings/delivery-check/${check.check_id}`;
  await f.request(`PUT ${path}/cases/T-25`, { result: 'FAIL', note: '不合格' });
  assert.equal((await f.request(`POST ${path}/submit`, { note: '送信を止める' })).json.delivery_check.status, 'FAIL');
});

test('API-28 証跡は復号後1MiBまで、壊れたBase64・空・期限切れ・他検査を拒否する', async () => {
  assert.equal(evidenceBytes(Buffer.alloc(1024 * 1024).toString('base64')).length, 1024 * 1024);
  assert.throws(() => evidenceBytes(Buffer.alloc(1024 * 1024 + 1).toString('base64')), { code: 'EVIDENCE_TOO_LARGE', status: 413, message: '証跡のファイルは1MiB以下にしてください。' });
  for (const text of ['', '@@@@', 'YQ', 'YR==']) assert.throws(() => evidenceBytes(text), { code: 'INVALID_REQUEST' });
  const f = managementFixture(); const check = await startCheck(f);
  f.advance(30 * DAY);
  code(await f.request(`POST /settings/delivery-check/${check.check_id}/evidence`, { case_id: 'T-25', file_name: 'proof.eml', content_base64: 'YQ==' }), 409, 'STATE_CONFLICT');
});

test('6.6 受入復旧のテスト送信は検査ID必須で、伏せ字の結果を検査に保存する', async () => {
  const f = managementFixture({ env: 'prod', count: 1 }); f.draft();
  code(await f.request(`POST ${f.campaignPath}/test-send`, { purpose: 'ACCEPTANCE_RECOVERY', note: '確認' }), 400, 'INVALID_REQUEST');
  const check = await startCheck(f);
  const response = await f.request(`POST ${f.campaignPath}/test-send`, { purpose: 'ACCEPTANCE_RECOVERY', note: '受信を確認', check_id: check.check_id });
  assert.equal(response.statusCode, 200, response.body);
  const sends = f.ddb.get('ACCEPTANCE', check.check_id).test_sends;
  assert.equal(sends.length, 1);
  assert.equal(sends[0].status, 'ACCEPTED');
  assert.ok(!JSON.stringify(sends).includes(f.addresses[0]));
  assert.equal(f.sends[0].input.EmailTags.find((tag) => tag.Name === 'rid').Value, rid(f));
});

test('T-66 期限30・14・7・1日前と期限切れは各段階一度だけ通知する', async () => {
  const f = managementFixture({ env: 'prod' });
  const runtime = { ...f.deps, store: f.store };
  for (const days of [60, 76, 83, 89, 90]) {
    f.setTime(Date.parse(f.delivery.passed_at) + days * DAY);
    await notifyAcceptanceExpiry(runtime); await notifyAcceptanceExpiry(runtime);
  }
  assert.equal(f.notices.filter((item) => item.code === 'DELIVERY_CHECK_EXPIRING').length, 4);
  assert.equal(f.notices.filter((item) => item.code === 'DELIVERY_CHECK_EXPIRED').length, 1);
  assert.deepEqual(f.ddb.get('SETTINGS', 'ORG').delivery_check.expiry_notified, ['30', '14', '7', '1', 'EXPIRED']);
});

test('16.6 日次の失効理由はDNS変更とコード設定変更を分け、項目名を残す', async () => {
  const f = managementFixture({ env: 'prod' });
  await f.worker({ mode: 'auth-check' });
  const auth = f.ddb.get('SETTINGS', 'AUTH_STATUS');
  const org = f.ddb.get('SETTINGS', 'ORG');
  org.delivery_check = { ...f.delivery, status: 'PASS', dns_config_hash: auth.dns_config_hash, dns_item_hashes: auth.dns_item_hashes };
  f.ddb.set(org); f.deps.dns.resolve4 = async () => ['192.0.2.11'];
  await f.worker({ mode: 'auth-check' });
  const record = f.ddb.get('SETTINGS', 'ORG').delivery_check;
  assert.equal(record.invalidation_reason, 'DNS_CHANGED');
  assert.deepEqual(record.invalidation_details, ['FROM_A']);
});

async function previewImport(f, csv, mode = 'NEW_ONLY') {
  const received = await f.receive(csv, `key${f.files.size}`, mode);
  assert.equal(received.statusCode, 202, received.body);
  const id = received.json.import_id;
  assert.equal((await f.worker({ mode: 'import', import_id: id })).status, 'PREVIEW');
  return id;
}

test('T-67 新規取込は確認まで何も登録せず、二重確認・二重workerでジョブを増やさない', async () => {
  const f = managementFixture({ env: 'prod', count: 0 });
  const id = await previewImport(f, f.importCsv());
  assert.equal(f.jobs.size, 0); assert.equal(f.ddb.get('CONTACT_META', rid(f, 'new@example.com')), undefined);
  assert.equal(f.ddb.get('LOCK', 'CONTACT_CREATE')?.owner, undefined);
  const record = f.ddb.get('IMPORT', id);
  assert.equal(record.mode, 'NEW_ONLY');
  assert.equal(Date.parse(record.preview_expires_at), f.deps.now() + DAY);
  const responses = await Promise.all([f.request(`POST /imports/${id}/confirm`, { version: record.version }), f.request(`POST /imports/${id}/confirm`, { version: record.version })]);
  assert.equal(responses.filter((item) => item.statusCode === 202).length, 1);
  await f.worker({ mode: 'import', import_id: id }); await f.worker({ mode: 'import', import_id: id });
  assert.equal(f.jobs.size, 1);
});

test('T-67 確認後に登録・停止・削除された行を新規取込で上書きしない', async () => {
  const f = managementFixture({ env: 'prod', count: 0 });
  const id = await previewImport(f, f.importCsv());
  f.contacts.push({ EmailAddress: 'new@example.com', UnsubscribeAll: true });
  assert.equal((await f.confirmImport(id)).status, 'DONE');
  assert.equal(f.jobs.size, 0); assert.equal(f.contacts[0].UnsubscribeAll, true);
});

test('API-35 取りやめ・24時間経過は登録せずファイルを削除し、期限切れの確認を拒否する', async () => {
  const f = managementFixture({ env: 'prod', count: 0 });
  const first = await previewImport(f, f.importCsv());
  const discarded = await f.request(`POST /imports/${first}/discard`, { version: f.ddb.get('IMPORT', first).version });
  assert.equal(discarded.json.status, 'DISCARDED'); assert.ok(!f.files.has(`imports/staging/${first}.csv`));
  const second = await previewImport(f, f.importCsv()); f.advance(DAY);
  code(await f.request(`POST /imports/${second}/confirm`, { version: f.ddb.get('IMPORT', second).version }), 409, 'STATE_CONFLICT');
  await f.worker({ mode: 'daily' });
  assert.equal(f.ddb.get('IMPORT', second).status, 'EXPIRED');
  assert.ok(!f.files.has(`imports/staging/${second}.csv`)); assert.equal(f.jobs.size, 0);
});

test('T-67 一括更新はCONTACT_METAだけを更新し、停止を戻さず未登録を作らず行ごとに停止を監査する', async () => {
  const f = managementFixture({ env: 'prod', count: 3 });
  for (const email of f.addresses) await f.request('POST /contacts/get', { email });
  const hash = rid(f);
  f.ddb.set({ ...f.ddb.get('CONTACT_META', hash), blocked_all: true });
  const csv = `email,name,stop\n${f.addresses[0]},変更,\n${f.addresses[1]},,ALL\n${f.addresses[2]},,news|event\nmissing@example.com,未登録,ALL\n`;
  const id = await previewImport(f, csv, 'UPDATE_EXISTING');
  const preview = await f.request(`GET /imports/${id}`);
  assert.deepEqual(preview.json.summary, { UPDATED: 3, INVALID: 1 });
  assert.equal(preview.json.changes.name, 1); assert.equal(preview.json.changes.stop, 2);
  assert.ok(!JSON.stringify(preview.json.report).includes('@'));
  assert.equal((await f.confirmImport(id)).status, 'DONE');
  assert.equal(f.ddb.get('CONTACT_META', hash).blocked_all, true);
  assert.equal(f.ddb.get('CONTACT_META', hash).attributes.name, '変更');
  assert.equal(f.ddb.get('CONTACT_META', rid(f, f.addresses[1])).attributes.name, undefined);
  assert.equal(f.ddb.get('CONTACT_META', rid(f, 'missing@example.com')), undefined);
  assert.equal(f.changes.length, 0); assert.equal(f.jobs.size, 0);
  const audits = [...f.ddb.items.values()].filter((item) => item.action === 'CONTACT_STOP');
  assert.equal(audits.length, 3);
  assert.ok(audits.every((item) => /^[a-f0-9]{64}$/.test(item.addr_id) && item.details.operation === 'IMPORT'));
  const complete = [...f.ddb.items.values()].find((item) => item.action === 'IMPORT_COMPLETE');
  assert.equal(complete.details.name_changed_count, 1);
});

test('T-67 一括更新は未登録・変更なし・完全削除・不正行を区別し、確認後の同時停止を上書きしない', async () => {
  const f = managementFixture({ env: 'prod', count: 2 });
  for (const email of f.addresses) await f.request('POST /contacts/get', { email });
  const csv = `email,name,stop\n${f.addresses[0]},更新,news\n${f.addresses[1]},,\nmissing@example.com,,\nwrong,,ALL\n`;
  const id = await previewImport(f, csv, 'UPDATE_EXISTING');
  assert.deepEqual(f.ddb.get('IMPORT', id).summary, { UPDATED: 1, UNCHANGED: 1, NOT_FOUND: 1, INVALID: 1 });
  await f.request('POST /contacts/unsubscribe', { email: f.addresses[0], scope: 'ALL' });
  await f.confirmImport(id);
  assert.equal(f.ddb.get('CONTACT_META', rid(f)).blocked_all, true);
  assert.equal(f.ddb.get('CONTACT_META', rid(f)).attributes.name, undefined);
  const report = JSON.parse(f.files.get(`imports/report/${id}.json`));
  assert.equal(report.rows[0].code, 'INVALID'); assert.equal(report.rows[0].reason, 'STATE_CHANGED');
});

test('5.8 UPDATE_EXISTINGは未知の列・購読の追加・ALLと名前の同時指定を拒否する', () => {
  const options = { topics: ['news'], importId: ID, mode: 'UPDATE_EXISTING' };
  assert.throws(() => validateImportCsv('email,topics\na@example.com,news\n', options));
  const result = validateImportCsv('email,name,stop\na@example.com,name,ALL\nb@example.com,,unknown\n', options);
  assert.equal(result.rows.length, 0); assert.equal(result.rejected.length, 2);
  assert.ok(result.rejected.every((row) => row.code === 'INVALID'));
});

test('API-11 modeを必須にし、冪等キーは形式を変更しても同じ取込IDを返す', async () => {
  const f = managementFixture({ env: 'prod' });
  code(await f.request('POST /imports', undefined, { headers: { 'x-origin-verify': 'origin', 'content-type': 'text/csv; charset=utf-8', 'idempotency-key': 'same' }, body: f.importCsv() }), 400, 'INVALID_REQUEST');
  const first = await f.receive(f.importCsv(), 'same', 'NEW_ONLY');
  const second = await f.receive('email,name,stop\nmember@example.com,,ALL\n', 'same', 'UPDATE_EXISTING');
  assert.equal(second.json.import_id, first.json.import_id); assert.equal(f.invocations.length, 1);
});

test('11.5 管理者の同時変更は一方だけがCognitoに進む', async () => {
  const f = managementFixture(); thirdAdmin(f);
  const results = await Promise.all([f.request('POST /staff/other-admin/roles', { roles: ['sender'] }), f.request('POST /staff/other-admin/disable', {})]);
  assert.equal(results.filter((response) => response.statusCode === 200).length, 1);
  assert.equal(results.filter((response) => response.statusCode === 409).length, 1);
  assert.equal(f.notices.filter((item) => item.code === 'STAFF_CHANGED').length, 1);
});

test('11.5 正本の規則に従い有効な管理者が2人から1人になる変更も拒否する', async () => {
  const f = managementFixture();
  for (const [action, body] of [['disable', {}], ['roles', { roles: ['sender'] }]]) code(await f.request(`POST /staff/other-admin/${action}`, body), 409, 'LAST_ADMIN');
  assert.equal(f.staffCalls.length, 0);
});

test('11.5 変更後の排他解放が失敗してもSTAFF_CHANGEDの通知を試みる', async () => {
  const f = managementFixture();
  f.ddb.beforeUpdate = (input) => {
    if (input.Key.PK.S === 'LOCK' && input.Key.SK.S === 'STAFF' && input.UpdateExpression.includes('REMOVE')) throw failure('TimeoutError');
  };
  assert.equal((await f.request('POST /staff/other-admin/reset-password', {})).statusCode, 500);
  assert.equal(f.staffCalls.filter((item) => item.method === 'password').length, 1);
  assert.equal(f.notices.filter((item) => item.code === 'STAFF_CHANGED').length, 1);
  assert.ok(f.ddb.get('LOCK', 'STAFF').owner);
});

test('16.6 検査の同時確定は一方だけが成功し、設定更新と検査確定を分離しない', async () => {
  const f = managementFixture({ env: 'prod' });
  const check = await startCheck(f); const path = `/settings/delivery-check/${check.check_id}`;
  await f.request(`PUT ${path}/cases/T-25`, { result: 'FAIL', note: '送信停止' });
  const results = await Promise.all([f.request(`POST ${path}/submit`, { note: '確認1' }), f.request(`POST ${path}/submit`, { note: '確認2' })]);
  assert.equal(results.filter((response) => response.statusCode === 200).length, 1);
  assert.equal(results.filter((response) => response.statusCode === 409).length, 1);
  assert.equal(f.ddb.get('ACCEPTANCE', check.check_id).status, 'SUBMITTED');
  assert.equal(f.ddb.get('SETTINGS', 'ORG').delivery_check.status, 'FAIL');
});

test('9.6 認証の再確認中は新しい観測がある間だけ警告とし、26時間を過ぎたら停止する', async () => {
  const f = managementFixture({ env: 'prod' });
  f.ddb.set({ ...f.auth, status: 'UNKNOWN' });
  let response = await f.request('GET /readiness');
  assert.equal(response.json.items.find((item) => item.id === 'authentication').status, 'WARN');
  f.advance(27 * 3600000);
  response = await f.request('GET /readiness');
  assert.equal(response.json.items.find((item) => item.id === 'authentication').status, 'BLOCKED');
});

test('16.6 受入期限を短縮した環境は表示・準備状況・日次通知も同じ期限を使う', async () => {
  const f = managementFixture({ env: 'prod' }); f.settings.delivery_check_max_age_days = 30;
  f.advance(31 * DAY);
  const state = await f.request('GET /settings/delivery-check');
  assert.equal(state.json.delivery_check.remaining_days, 0);
  assert.equal(state.json.delivery_check.invalidation_reason, 'EXPIRED');
  assert.equal((await f.request('GET /readiness')).json.items.find((item) => item.id === 'delivery_check').status, 'BLOCKED');
  await notifyAcceptanceExpiry({ ...f.deps, store: f.store });
  assert.equal(f.notices.at(-1).code, 'DELIVERY_CHECK_EXPIRED');
});
