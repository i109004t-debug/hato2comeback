import test from 'node:test';
import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';
import { managementFixture } from '../helpers/management.js';
import { failure } from '../helpers/sending.js';
import { addressHash } from '../../src/common/log.js';
import { contactBlocked } from '../../src/common/contact-metadata.js';

const consent = { at: '2026-01-01T00:00:00Z', source: '入会フォーム' };
const hash = (email) => addressHash(email, '7'.repeat(64));
const metadata = (f, email = f.addresses[0]) => f.ddb.get('CONTACT_META', hash(email));
const runtime = (f) => ({ ...f.deps, store: f.store, secrets: f.deps.secretsProvider });
const reconsent = (f) => ({ email: f.addresses[0], topics: ['news'], reconsent: { at: '2026-11-01T00:00:00Z', source: '本人の再申込' }, note: '本人の依頼を照合' });

for (const [route, body] of [
  ['update', { name: '新しい名前' }],
  ['update', { topics: { news: 'OPT_IN' } }],
  ['update', { topics: { event: 'OPT_OUT' } }],
  ['unsubscribe', { scope: 'event' }],
  ['unsubscribe', { scope: 'ALL' }],
]) {
  test(`購読競合: ${route}/${JSON.stringify(body)} はSESの同時解除を書き戻さない`, async () => {
    const f = managementFixture({ count: 1 });
    f.contacts[0].AttributesData = JSON.stringify({ v: 1, name: '元の名前', consent });
    const get = f.deps.ses.getContact;
    f.deps.ses.getContact = async (input) => {
      const old = await get(input);
      f.contacts[0].UnsubscribeAll = true;
      f.contacts[0].TopicPreferences[0].SubscriptionStatus = 'OPT_OUT';
      return old;
    };
    const result = await f.request(`POST /contacts/${route}`, { email: f.addresses[0], ...body });
    assert.equal(result.statusCode, 200, result.body);
    assert.equal(f.changes.length, 0);
    assert.equal(f.contacts[0].UnsubscribeAll, true);
    assert.equal(f.contacts[0].TopicPreferences[0].SubscriptionStatus, 'OPT_OUT');
  });
}

test('名前編集の正本はTTLなしのDDBに保存し、画面とバックアップへ反映する', async () => {
  const f = managementFixture({ count: 1 });
  f.contacts[0].AttributesData = JSON.stringify({ v: 1, name: '登録時', consent });
  assert.equal((await f.request('POST /contacts/update', { email: f.addresses[0], name: '変更後' })).statusCode, 200);
  assert.equal(metadata(f).attributes.name, '変更後');
  assert.equal(metadata(f).expires_at, undefined);
  f.advance(366 * 86400000);
  const one = await f.request('POST /contacts/get', { email: f.addresses[0] });
  assert.equal(JSON.parse(one.json.AttributesData).name, '変更後');
  f.deps.ses.getContact = async () => { throw new Error('Daily must use durable metadata'); };
  const daily = await f.worker({ mode: 'daily' }, f.context);
  assert.equal(daily.results.backup, 'PASS');
  const file = [...f.files.entries()].find(([key]) => key.endsWith('.jsonl.gz'));
  const row = JSON.parse(gunzipSync(file[1]).toString('utf8').trim());
  assert.equal(JSON.parse(row.AttributesData).name, '変更後');
  assert.deepEqual(JSON.parse(row.AttributesData).consent, consent);
});

test('ローカルtopic停止を一覧・詳細・購読者数・backupへ反映する', async () => {
  const f = managementFixture({ count: 1 });
  assert.equal((await f.request('POST /contacts/unsubscribe', { email: f.addresses[0], scope: 'news' })).statusCode, 200);
  const list = await f.request('GET /contacts', undefined, { rawQueryString: 'topic=news&status=OPT_OUT' });
  assert.equal(list.json.items.length, 1);
  assert.equal(list.json.items[0].TopicPreferences[0].SubscriptionStatus, 'OPT_OUT');
  assert.equal(await contactBlocked(runtime(f), f.addresses[0], 'news'), true);
  assert.equal(await contactBlocked(runtime(f), f.addresses[0], 'event'), false);
  assert.equal((await f.worker({ mode: 'daily' }, f.context)).results.backup, 'PASS');
  assert.equal(f.ddb.get('SETTINGS', 'TOPIC_COUNTS').counts.news, 0);
});

test('再同意は明示したtopicだけを再開し、未指定の購読も停止する', async () => {
  const f = managementFixture({ count: 1 });
  f.contacts[0].AttributesData = JSON.stringify({ v: 1, consent });
  f.contacts[0].TopicPreferences.push({ TopicName: 'event', SubscriptionStatus: 'OPT_IN' });
  const result = await f.request('POST /contacts/reconsent', reconsent(f));
  assert.equal(result.statusCode, 200, result.body);
  assert.deepEqual(metadata(f).blocked_topics, ['event']);
  assert.equal(await contactBlocked(runtime(f), f.addresses[0], 'news'), false);
  assert.equal(f.contacts[0].TopicPreferences.find((item) => item.TopicName === 'event').SubscriptionStatus, 'OPT_OUT');
});

test('再同意のSES応答不明では停止を保持し、再送信を許さない', async () => {
  const f = managementFixture({ count: 1 });
  f.deps.ses.updateContact = async () => { throw failure('TimeoutError'); };
  const result = await f.request('POST /contacts/reconsent', reconsent(f));
  assert.equal(result.statusCode, 500);
  assert.equal(metadata(f).blocked_all, true);
  assert.equal(await contactBlocked(runtime(f), f.addresses[0], 'news'), true);
});

test('再同意中に別の停止が保存された場合はCASで解除を拒否する', async () => {
  const f = managementFixture({ count: 1 });
  const update = f.deps.ses.updateContact;
  f.deps.ses.updateContact = async (input) => {
    await update(input);
    const stop = await f.request('POST /contacts/unsubscribe', { email: f.addresses[0], scope: 'ALL' });
    assert.equal(stop.statusCode, 200, stop.body);
    return {};
  };
  const result = await f.request('POST /contacts/reconsent', reconsent(f));
  assert.equal(result.statusCode, 409, result.body);
  assert.equal(result.json.error_code, 'VERSION_CONFLICT');
  assert.equal(metadata(f).blocked_all, true);
});

test('完全削除は属性を除去し、TTLなしtombstoneから再取り込みを拒否する', async () => {
  const f = managementFixture({ count: 1 });
  await f.request('POST /contacts/update', { email: f.addresses[0], name: '削除する名前' });
  const result = await f.request('POST /contacts/erase', { email: f.addresses[0], note: '本人による削除請求' });
  assert.equal(result.statusCode, 200, result.body);
  assert.equal(metadata(f).attributes, undefined);
  assert.equal(metadata(f).erased, true);
  assert.equal(metadata(f).expires_at, undefined);
  assert.equal(await contactBlocked(runtime(f), f.addresses[0], 'news'), true);
  assert.equal(f.contacts.length, 0);
});

test('手動登録とCSVはSES登録開始前に復元可能な属性を保存する', async () => {
  const f = managementFixture({ env: 'prod', count: 0 });
  const create = f.deps.ses.createContact;
  f.deps.ses.createContact = async (input) => {
    assert.deepEqual(metadata(f, input.EmailAddress).pending_attributes.consent, consent);
    assert.equal(metadata(f, input.EmailAddress).blocked_all, true);
    return create(input);
  };
  assert.equal((await f.request('POST /contacts', { email: 'manual@example.com', name: '手動登録', topics: ['news'], consent })).statusCode, 201);
  assert.deepEqual(metadata(f, 'manual@example.com').attributes.consent, consent);
  assert.equal(metadata(f, 'manual@example.com').pending_attributes, undefined);
  assert.equal(metadata(f, 'manual@example.com').blocked_all, false);
  const createJob = f.deps.ses.createImportJob;
  f.deps.ses.createImportJob = async (input) => {
    assert.equal(metadata(f, 'csv@example.com').attributes.name, '会員');
    assert.equal(metadata(f, 'csv@example.com').expires_at, undefined);
    return createJob(input);
  };
  const received = await f.receive(f.importCsv('csv@example.com'));
  assert.equal((await f.worker({ mode: 'import', import_id: received.json.import_id }, f.context)).status, 'IMPORTING');
});

test('CSVはSESから消えていても保存済みの停止metadataを上書きしない', async () => {
  const f = managementFixture({ env: 'prod', count: 0 });
  const row = { PK: 'CONTACT_META', SK: hash('new@example.com'), version: 1, attributes: { consent }, blocked_all: true, blocked_topics: [] };
  f.ddb.set(row);
  const received = await f.receive(f.importCsv());
  assert.equal((await f.worker({ mode: 'import', import_id: received.json.import_id }, f.context)).status, 'DONE');
  assert.deepEqual(metadata(f, 'new@example.com'), row);
  assert.equal(f.jobs.size, 0);
});

test('日次は既存属性取得を100件に制限し、不足を明示して購読snapshotを残す', async () => {
  const f = managementFixture({ count: 105 });
  let reads = 0;
  const get = f.deps.ses.getContact;
  f.deps.ses.getContact = async (input) => { reads += 1; return get(input); };
  const daily = await f.worker({ mode: 'daily' }, f.context);
  assert.equal(reads, 100);
  assert.equal(daily.results.backup, 'FAIL');
  const manifest = JSON.parse(f.files.get('backups/contacts/2026-11-03.manifest.json'));
  assert.equal(manifest.complete, false);
  assert.equal(manifest.attributes_missing, 5);
  const rows = gunzipSync(f.files.get('backups/contacts/2026-11-03.jsonl.gz')).toString('utf8').trim().split('\n').map(JSON.parse);
  assert.equal(rows.length, 105);
  assert.equal(rows.filter((row) => row.PostlineMetadataStatus === 'MISSING').length, 5);
  assert.ok(f.notices.some((notice) => notice.code === 'BACKUP_ATTRIBUTES_MISSING'));
});

test('初期属性移行はworkerの500件上限と保存済みcursorから再開する', async () => {
  const f = managementFixture({ count: 505 });
  let reads = 0;
  const get = f.deps.ses.getContact;
  f.deps.ses.getContact = async (input) => { reads += 1; return get(input); };
  const first = await f.worker({ mode: 'contact-backfill' }, f.context);
  assert.equal(first.status, 'MORE');
  assert.equal(first.saved, 500);
  assert.equal(f.ddb.get('SETTINGS', 'CONTACT_BACKFILL').index, 500);
  // 次のListContactsまでに前方の行が消えても、数値indexによる取りこぼしを起こさない。
  f.contacts.splice(0, 5);
  const second = await f.worker({ mode: 'contact-backfill' }, f.context);
  assert.equal(second.status, 'DONE');
  assert.equal(second.saved, 5);
  assert.equal(reads, 505);
  assert.equal((await f.worker({ mode: 'contact-backfill' }, f.context)).status, 'DONE');
  assert.equal(reads, 505);
  assert.equal(metadata(f).expires_at, undefined);
});

test('新規登録のAlreadyExists競合は失敗した入力を同意正本にせず停止を保持する', async () => {
  const f = managementFixture({ env: 'prod', count: 0 });
  const email = 'race@example.com';
  const actual = { name: '既存会員', consent: { at: '2025-01-01T00:00:00Z', source: '既存の同意' } };
  f.deps.ses.createContact = async (input) => {
    f.contacts.push({ ...input, AttributesData: JSON.stringify(actual) });
    throw failure('AlreadyExistsException', 409);
  };
  const created = await f.request('POST /contacts', { email, name: '失敗した入力', topics: ['news'], consent });
  assert.equal(created.statusCode, 409, created.body);
  assert.equal(created.json.error_code, 'CONTACT_EXISTS');
  const current = await f.request('POST /contacts/get', { email });
  assert.deepEqual(JSON.parse(current.json.AttributesData), actual);
  assert.equal(current.json.UnsubscribeAll, true);
  assert.equal(metadata(f, email).registration_state, 'CONFLICT');
  assert.equal(metadata(f, email).pending_attributes, undefined);
});

test('登録応答不明の仮属性は正本として表示せず、送信停止と復旧用記録を保持する', async () => {
  const f = managementFixture({ env: 'prod', count: 0 });
  const email = 'pending@example.com';
  f.deps.ses.createContact = async (input) => { f.contacts.push(input); throw failure('TimeoutError'); };
  assert.equal((await f.request('POST /contacts', { email, name: '仮登録', topics: ['news'], consent })).statusCode, 500);
  const current = await f.request('POST /contacts/get', { email });
  assert.deepEqual(JSON.parse(current.json.AttributesData), {});
  assert.equal(current.json.UnsubscribeAll, true);
  assert.equal(metadata(f, email).pending_attributes.name, '仮登録');
  assert.equal((await f.worker({ mode: 'daily' }, f.context)).results.backup, 'FAIL');
  assert.equal(f.ddb.get('SETTINGS', 'CONTACT_BACKUP').attributes_missing, 1);
  const allowed = await f.request('POST /contacts/reconsent', { ...reconsent(f), email });
  assert.equal(allowed.statusCode, 200, allowed.body);
  assert.equal(metadata(f, email).registration_state, 'ACTIVE');
  assert.equal(metadata(f, email).pending_attributes, undefined);
  assert.equal(metadata(f, email).blocked_all, false);
});

test('属性取得障害でも購読snapshotを残し、欠損と通知を記録する', async () => {
  const f = managementFixture({ count: 1 });
  f.deps.ses.getContact = async () => { throw failure('TimeoutError'); };
  assert.equal((await f.worker({ mode: 'daily' }, f.context)).results.backup, 'FAIL');
  const row = JSON.parse(gunzipSync(f.files.get('backups/contacts/2026-11-03.jsonl.gz')).toString('utf8').trim());
  assert.equal(row.EmailAddress, f.addresses[0]);
  assert.equal(row.PostlineMetadataStatus, 'MISSING');
});

test('旧SESの1024バイトを超える属性は切り捨てず移行未完了として停止する', async () => {
  const f = managementFixture({ count: 1 });
  f.contacts[0].AttributesData = JSON.stringify({ name: 'a'.repeat(1025), consent });
  await assert.rejects(f.worker({ mode: 'contact-backfill' }, f.context), { code: 'INTERNAL' });
  assert.equal(metadata(f), undefined);
  assert.equal(f.ddb.get('SETTINGS', 'CONTACT_BACKFILL').complete, false);
  assert.equal((await f.worker({ mode: 'daily' }, f.context)).results.backup, 'FAIL');
  assert.equal(f.ddb.get('SETTINGS', 'CONTACT_BACKUP').attributes_missing, 1);
});

test('snapshot後のローカル停止を送信直前に確認し、SESを呼び出さない', async () => {
  const f = managementFixture({ count: 1 });
  await f.prepare();
  assert.equal((await f.request('POST /contacts/unsubscribe', { email: f.addresses[0], scope: 'news' })).statusCode, 200);
  await f.send();
  assert.equal(f.sends.length, 0);
  assert.equal(f.getCampaign().counts.failed, 1);
});

test('送信間隔の待機中に受け付けたローカル停止もAPI開始前に再確認する', async () => {
  const f = managementFixture({ count: 2 });
  await f.prepare();
  let stopped = false;
  f.onSleep = async () => {
    if (!f.sends.length || stopped) return;
    stopped = true;
    for (const email of f.addresses) f.ddb.set({ PK: 'CONTACT_META', SK: hash(email), version: 1, attributes: {}, blocked_all: true, blocked_topics: [] });
  };
  await f.send();
  assert.equal(stopped, true);
  assert.equal(f.sends.length, 1);
  assert.equal(f.getCampaign().counts.failed, 1);
});
