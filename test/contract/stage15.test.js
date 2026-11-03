import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { managementFixture } from '../helpers/management.js';
import { eraseHash } from '../helpers/sending.js';
import { addressHash } from '../../src/common/log.js';
import { batchContactMetadata, contactBlocked, contactSendability } from '../../src/common/contact-metadata.js';
import { progressLines } from '../../web/js/dom.js';
import { historyRow } from '../../web/js/views/history.js';
import { sendabilityReason, sendabilitySummary } from '../../web/js/views/contacts.js';

const hash = (email) => addressHash(email, '7'.repeat(64));
const runtime = (f) => ({ ...f.deps, store: f.store, secrets: f.deps.secretsProvider });
const recipients = (f) => [...f.files.entries()].filter(([key]) => key.startsWith('recipients/')).flatMap(([, body]) => body.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line).e));
const active = { registration_state: 'ACTIVE', blocked_all: false, blocked_topics: [] };

function setMetadata(f, fields) {
  const key = hash(f.addresses[0]);
  if (fields === null) f.ddb.items.delete(`CONTACT_META/${key}`);
  else f.ddb.set(Object.fromEntries(Object.entries({ PK: 'CONTACT_META', SK: key, version: 1, ...active, ...fields }).filter(([, value]) => value !== undefined)));
}

for (const [name, fields, reasons] of [
  ['記録なし', null, ['NO_CONSENT_RECORD']],
  ['PENDING', { registration_state: 'PENDING' }, ['REGISTRATION_PENDING']],
  ['CONFLICT', { registration_state: 'CONFLICT' }, ['REGISTRATION_CONFLICT']],
  ['状態なし', { registration_state: undefined }, ['NO_CONSENT_RECORD']],
  ['未知の状態', { registration_state: 'UNKNOWN' }, ['NO_CONSENT_RECORD']],
  ['完全削除', { erased: true }, ['ERASED']],
  ['全停止', { blocked_all: true }, ['BLOCKED_ALL']],
  ['同じトピック停止', { blocked_topics: ['news'] }, ['BLOCKED_TOPIC']],
  ['別トピック停止', { blocked_topics: ['event'] }, []],
  ['ACTIVE', {}, []],
]) {
  test(`第15段階 ${name} のAPI-05・準備・送信直前は同じ結論になる`, async () => {
    const f = managementFixture({ count: 1, registered: true });
    setMetadata(f, fields);
    const before = f.ddb.get('CONTACT_META', hash(f.addresses[0]));
    const detail = await f.request('POST /contacts/get', { email: f.addresses[0] });
    assert.equal(detail.statusCode, 200, detail.body);
    const sendable = reasons.length === 0;
    assert.deepEqual(detail.json.sendability.news, { sendable, reasons });
    const list = await f.request('GET /contacts');
    assert.equal(list.statusCode, 200, list.body);
    if (fields?.erased) assert.deepEqual(list.json.items, []);
    else assert.deepEqual(list.json.items[0].sendability, detail.json.sendability);
    assert.deepEqual(f.ddb.get('CONTACT_META', hash(f.addresses[0])), before, '閲覧で正本を作成・変更しない');
    assert.equal(await contactBlocked(runtime(f), f.addresses[0], 'news'), !sendable);
    const prepared = await f.prepare();
    assert.equal(prepared.action, sendable ? 'SEND' : 'DONE');
    assert.deepEqual(recipients(f), sendable ? f.addresses : []);
    if (reasons.some((reason) => ['NO_CONSENT_RECORD', 'REGISTRATION_PENDING', 'REGISTRATION_CONFLICT'].includes(reason))) assert.equal(f.getCampaign().counts.excluded_no_record, 1);
    const message = sendabilitySummary(detail.json, f.topics, { detail: true });
    if (!sendable) assert.match(message, /会報：送られません/);
    for (const reason of reasons) assert.ok(message.includes(sendabilityReason(reason)));
  });
}

for (const [name, change, reasons] of [
  ['SES全停止', (f) => { f.contacts[0].UnsubscribeAll = true; }, ['SES_UNSUBSCRIBED_ALL']],
  ['SESトピック停止', (f) => { f.contacts[0].TopicPreferences[0].SubscriptionStatus = 'OPT_OUT'; }, ['SES_UNSUBSCRIBED_TOPIC']],
  ['重複購読の矛盾', (f) => { f.contacts[0].TopicPreferences.push({ TopicName: 'news', SubscriptionStatus: 'OPT_OUT' }); }, ['SES_UNSUBSCRIBED_TOPIC']],
  ['既定購読', (f) => { f.contacts[0].TopicPreferences = []; f.topics[0].DefaultSubscriptionStatus = 'OPT_IN'; }, []],
]) {
  test(`第15段階 ${name} のAPI-04・API-05・準備は同じ結論になる`, async () => {
    const f = managementFixture({ registered: true, count: 1 });
    change(f);
    const one = await f.request('POST /contacts/get', { email: f.addresses[0] });
    const list = await f.request('GET /contacts');
    assert.equal(one.statusCode, 200, one.body);
    assert.equal(list.statusCode, 200, list.body);
    assert.deepEqual(one.json.sendability.news, { sendable: reasons.length === 0, reasons });
    assert.deepEqual(list.json.items[0].sendability, one.json.sendability);
    assert.equal((await f.prepare()).action, reasons.length ? 'DONE' : 'SEND');
  });
}

test('第15段階 API-05は独立したERASED記録も送信直前と同じく停止とし、属性を表示しない', async () => {
  const f = managementFixture({ registered: true, count: 1 });
  f.ddb.set({ PK: 'ERASED', SK: eraseHash(f.addresses[0]) });
  const one = await f.request('POST /contacts/get', { email: f.addresses[0] });
  assert.equal(one.statusCode, 200, one.body);
  assert.equal(one.json.sendable, false);
  assert.deepEqual(one.json.sendability.news.reasons, ['ERASED']);
  assert.equal(one.json.AttributesData, '{}');
  assert.equal(await contactBlocked(runtime(f), f.addresses[0], 'news'), true);
});

for (const role of ['admin', 'sender', 'approver', 'viewer']) {
  test(`第15段階 ${role} にAPI-04・05の理由を返し、閲覧者のアドレス・属性は伏せる`, async () => {
    const f = managementFixture({ role, count: 1 });
    f.contacts[0].AttributesData = JSON.stringify({ name: '旧名', orig: f.addresses[0], consent: { source: '旧申込' } });
    const detail = await f.request('POST /contacts/get', { email: f.addresses[0] });
    const list = await f.request('GET /contacts');
    assert.equal(detail.statusCode, 200, detail.body);
    assert.equal(list.statusCode, 200, list.body);
    for (const item of [detail.json, list.json.items[0]]) {
      assert.equal(item.sendable, false);
      assert.deepEqual(item.sendability.news.reasons, ['NO_CONSENT_RECORD']);
      if (role === 'viewer') {
        assert.ok(item.EmailAddress.includes('*'));
        assert.equal(item.AttributesData, undefined);
      }
    }
    assert.equal(f.ddb.get('CONTACT_META', hash(f.addresses[0])), undefined);
    if (role !== 'viewer') assert.equal(detail.json.AttributesData, '{}', 'SESの旧同意を正本として表示しない');
  });
}

test('第15段階 API-31の配送記録にもAPI-05と同じトピック別判定を返す', async () => {
  const f = managementFixture({ registered: true, count: 1 });
  setMetadata(f, { blocked_topics: ['event'] });
  f.contacts[0].TopicPreferences.push({ TopicName: 'event', SubscriptionStatus: 'OPT_IN' });
  const one = await f.request('POST /contacts/get', { email: f.addresses[0] });
  const events = await f.request('POST /contacts/events', { email: f.addresses[0] });
  assert.equal(events.statusCode, 200, events.body);
  assert.equal(events.json.sendable, true, '購読可能なトピックが1つ以上ある');
  assert.deepEqual(events.json.sendability, one.json.sendability);
  assert.deepEqual(events.json.sendability.event.reasons, ['BLOCKED_TOPIC']);
  assert.match(sendabilitySummary(events.json, f.topics), /一部.*送られません/);
});

test('第15段階 API-04は50件を一括で読み、ページごとの追加SES呼出しと単件metadata読取をしない', async () => {
  const f = managementFixture({ count: 101, registered: true, role: 'viewer' });
  f.contactPages = [{ Contacts: f.contacts.slice(0, 50), NextToken: '1' }, { Contacts: f.contacts.slice(50, 100), NextToken: '2' }, { Contacts: f.contacts.slice(100) }];
  const batches = [];
  const batch = f.ddb.batchGetItem;
  f.ddb.batchGetItem = async (input) => { batches.push(input); return batch(input); };
  const get = f.ddb.getItem;
  f.ddb.getItem = async (input) => {
    assert.notEqual(input.Key.PK.S, 'CONTACT_META');
    return get(input);
  };
  f.deps.ses.getContact = async () => { throw new Error('一覧でGetContactしない'); };
  f.deps.ses.getSuppressedDestination = async () => { throw new Error('一覧で抑止を取得しない'); };
  f.ddb.items.delete(`CONTACT_META/${hash(f.addresses[0])}`);
  f.ddb.set({ PK: 'CONTACT_META', SK: hash(f.addresses[1]), registration_state: 'PENDING', version: 1 });
  f.ddb.set({ PK: 'CONTACT_META', SK: hash(f.addresses[2]), registration_state: 'ACTIVE', erased: true, version: 1 });
  let cursor;
  const rows = [];
  do {
    const page = await f.request(`GET /contacts${cursor ? `?cursor=${cursor}` : ''}`);
    assert.equal(page.statusCode, 200, page.body);
    rows.push(...page.json.items);
    cursor = page.json.cursor;
  } while (cursor);
  assert.deepEqual(batches.map((input) => input.RequestItems[f.deps.tableName].Keys.length), [50, 50, 1]);
  assert.equal(f.listInputs.length, 3);
  assert.equal(rows.length, 100, 'erasedは従来どおり一覧へ出さない');
  assert.deepEqual(rows[0].sendability.news.reasons, ['NO_CONSENT_RECORD']);
  assert.deepEqual(rows[1].sendability.news.reasons, ['REGISTRATION_PENDING']);
  assert.equal(rows[2].sendability.news.sendable, true);
});

test('第15段階 一括読取は100件で分割し、重複キー・返却順・欠損を扱う', async () => {
  const f = managementFixture({ registered: true, count: 205 });
  f.ddb.items.delete(`CONTACT_META/${hash(f.addresses[2])}`);
  const batch = f.ddb.batchGetItem;
  const sizes = [];
  f.ddb.batchGetItem = async (input) => {
    sizes.push(input.RequestItems[f.deps.tableName].Keys.length);
    const result = await batch(input);
    result.Responses[f.deps.tableName].reverse();
    return result;
  };
  const result = await batchContactMetadata(runtime(f), [...f.contacts, f.contacts[0]]);
  assert.deepEqual(sizes, [100, 100, 5]);
  assert.equal(result.size, 204);
  assert.equal(result.get(hash(f.addresses[204])).registration_state, 'ACTIVE');
  assert.equal(result.has(hash(f.addresses[2])), false);
  assert.equal((await batchContactMetadata(runtime(f), [])).size, 0);
  assert.equal(sizes.length, 3);
});

test('第15段階 API-04はUnprocessedKeysを欠損扱いせず取得失敗にし、自動再試行しない', async () => {
  const f = managementFixture({ count: 1 });
  let calls = 0;
  f.ddb.batchGetItem = async (input) => {
    calls += 1;
    return { Responses: { [f.deps.tableName]: [] }, UnprocessedKeys: input.RequestItems };
  };
  const result = await f.request('GET /contacts');
  assert.equal(result.statusCode, 500);
  assert.equal(result.json.error_code, 'INTERNAL');
  assert.equal(result.json.items, undefined);
  assert.equal(calls, 1);
  assert.ok(!result.body.includes(f.addresses[0]));
});

test('第15段階 一括応答で省略された記録はNO_CONSENT_RECORDとして返す', async () => {
  const f = managementFixture({ count: 1 });
  f.ddb.batchGetItem = async () => ({ Responses: {}, UnprocessedKeys: {} });
  const result = await f.request('GET /contacts');
  assert.equal(result.statusCode, 200, result.body);
  assert.deepEqual(result.json.items[0].sendability.news.reasons, ['NO_CONSENT_RECORD']);
});

test('第15段階 API-14・23・履歴は同意による除外と停止を分け、キャッシュ中も最新件数を返す', async () => {
  const f = managementFixture({ registered: true, count: 4 });
  f.ddb.items.delete(`CONTACT_META/${hash(f.addresses[1])}`);
  f.ddb.items.delete(`CONTACT_META/${hash(f.addresses[2])}`);
  await f.prepare();
  setMetadata(f, { blocked_all: true });
  await f.send();
  const campaign = f.getCampaign();
  assert.equal(campaign.recipients_total, 2);
  assert.equal(campaign.counts.excluded_no_record, 2);
  assert.equal(campaign.counts.skipped_blocked, 1);
  assert.equal(campaign.counts.accepted, 1);
  for (const path of [f.campaignPath, `${f.campaignPath}/stats`]) {
    const result = await f.request(`GET ${path}`);
    assert.equal(result.statusCode, 200, result.body);
    assert.deepEqual(result.json.counts, campaign.counts);
    const lines = Object.fromEntries(progressLines(campaign, result.json));
    assert.equal(lines['同意の記録がないため送らなかった'], '2');
    assert.equal(lines['停止済みのため送らなかった'], '1');
  }
  const list = await f.request('GET /campaigns');
  assert.equal(historyRow(list.json.items[0]).excludedNoRecord, '2');
  const before = f.getCampaign().counts;
  f.setCampaign({ counts: { ...before, excluded_no_record: 3 } });
  assert.equal((await f.request(`GET ${f.campaignPath}/stats`)).json.counts.excluded_no_record, 3);
});

test('第15段階 0件と旧記録の未取得を区別し、準備前のAPI-23でも除外数を返す', async () => {
  const f = managementFixture({ count: 1 });
  f.draft({ counts: { excluded_no_record: 0, skipped_blocked: 0 } });
  const result = await f.request(`GET ${f.campaignPath}/stats`);
  assert.equal(result.json.counts.excluded_no_record, 0);
  assert.equal(historyRow(result.json).excludedNoRecord, '0');
  assert.equal(Object.fromEntries(progressLines({}, result.json))['同意の記録がないため送らなかった'], '0');
  assert.equal(historyRow({ counts: {} }).excludedNoRecord, '—');
  assert.equal(Object.fromEntries(progressLines({ counts: {} }))['同意の記録がないため送らなかった'], '—');
});

test('第15段階 複数の停止理由を隠さず、判定不明は送信対象と表示しない', () => {
  const state = contactSendability({ ...active, registration_state: 'PENDING', blocked_all: true, blocked_topics: ['news'] }, 'news', { contact: { UnsubscribeAll: true, TopicPreferences: [] }, erased: true });
  assert.deepEqual(state.reasons, ['ERASED', 'REGISTRATION_PENDING', 'BLOCKED_ALL', 'BLOCKED_TOPIC', 'SES_UNSUBSCRIBED_ALL', 'SES_UNSUBSCRIBED_TOPIC']);
  assert.equal(state.sendable, false);
  const topics = [{ TopicName: 'news', DisplayName: '会報' }];
  assert.match(sendabilitySummary({}, topics), /確認できません/);
  assert.match(sendabilityReason('member@example.com'), /確認できません/);
  assert.ok(!sendabilityReason('member@example.com').includes('@'));
});

test('第15段階 運営画面・ヘルプ・API権限に表示と一括読取を接続する', () => {
  const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
  const html = read('web/index.html');
  const help = read('web/help.html');
  assert.match(html, /data-detail-sendability/);
  assert.ok(html.includes('<th>送信の対象・送られない理由</th>'));
  assert.ok(html.includes('<th>同意の記録がないため送らなかった</th>'));
  assert.equal((html.match(/「総数」は準備時に確定した宛先数/g) ?? []).length, 2);
  for (const text of ['同意の記録がないため送らなかった', '状態のない古い記録', '画面を開くだけでは送信対象に戻りません', '総数には含めません', '完全削除済み']) assert.ok(help.includes(text), text);
  const apiPolicy = read('infra/template.yaml').split('  ApiPolicy:')[1].split('  WorkerPolicy:')[0];
  assert.ok(apiPolicy.includes('dynamodb:BatchGetItem'));
});
