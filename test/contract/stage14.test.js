import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { fixture, eraseHash } from '../helpers/sending.js';
import { managementFixture } from '../helpers/management.js';
import { addressHash } from '../../src/common/log.js';
import { contactBlocked } from '../../src/common/contact-metadata.js';
import { auditArchiveKey } from '../../src/common/audit-archive.js';
import { marshall } from '../../src/common/ddb.js';

const oldKey = '7'.repeat(64);
const newKey = '8'.repeat(64);
const hash = (email, key = oldKey) => addressHash(email, key);
const consent = { at: '2026-01-01T00:00:00Z', source: '入会フォーム' };
const meta = (f, email = f.addresses[0], key = oldKey) => f.ddb.get('CONTACT_META', hash(email, key));
function setMeta(f, index, fields) {
  const item = { ...meta(f, f.addresses[index]), ...fields };
  for (const [key, value] of Object.entries(item)) if (value === undefined) delete item[key];
  f.ddb.set(item);
}
const recipients = (f) => [...f.files.entries()].filter(([key]) => key.startsWith('recipients/')).flatMap(([, body]) => body.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line).e)).sort();
const runtime = (f) => ({ ...f.deps, store: f.store, secrets: f.deps.secretsProvider });

test('第14段階 7.3 準備はACTIVEの正本とSES・アプリ両方の購読を確認し、記録なしと許可リストを別集計する', async () => {
  const f = fixture({ count: 12 });
  f.ddb.items.delete(`CONTACT_META/${hash(f.addresses[1])}`);
  setMeta(f, 2, { registration_state: 'PENDING' });
  setMeta(f, 3, { registration_state: 'CONFLICT' });
  setMeta(f, 4, { registration_state: undefined });
  setMeta(f, 5, { erased: true });
  setMeta(f, 6, { blocked_all: true });
  setMeta(f, 7, { blocked_topics: ['news'] });
  setMeta(f, 8, { blocked_topics: ['event'] });
  f.contacts[9].UnsubscribeAll = true;
  f.contacts[10].TopicPreferences[0].SubscriptionStatus = 'OPT_OUT';
  f.settings.nonprod_allowlist = f.addresses.slice(0, 11);
  f.contactPages = [{ Contacts: f.contacts.slice(0, 6), NextToken: '1' }, { Contacts: [...f.contacts.slice(6), f.contacts[1], f.contacts[0]] }];
  f.deps.kms.generateMac = async () => { throw new Error('Prepare must not call KMS'); };
  assert.equal((await f.prepare()).action, 'SEND');
  assert.deepEqual(recipients(f), [f.addresses[0], f.addresses[8]].sort());
  assert.deepEqual(f.getCampaign().counts, { accepted: 0, failed: 0, unknown: 0, skipped_blocked: 0, excluded_allowlist: 1, excluded_no_record: 4 });
  assert.equal(f.listInputs.length, 2);
  assert.ok(f.listInputs.every((input) => input.PageSize === 1000 && input.Filter.FilteredStatus === 'OPT_IN'));
});

test('第14段階 7.3 正本が一件もなければ0件DONEで、送信もS3の宛先作成もしない', async () => {
  const f = fixture({ count: 3, registered: false });
  assert.equal((await f.prepare()).action, 'DONE');
  assert.equal(f.getCampaign().counts.excluded_no_record, 3);
  assert.equal(f.getCampaign().recipients_total, 0);
  assert.deepEqual(recipients(f), []);
  assert.equal(f.sends.length, 0);
});

test('第14段階 7.3 再開はexcluded_no_recordと保存済み宛先を維持し、一覧を再取得しない', async () => {
  const f = fixture({ count: 2 });
  f.ddb.items.delete(`CONTACT_META/${hash(f.addresses[1])}`);
  await f.prepare();
  const before = recipients(f);
  f.setCampaign({ status: 'QUEUED' });
  f.deps.ses.listContacts = async () => { throw new Error('Resume must use snapshot'); };
  assert.equal((await f.prepare({ resume: true })).action, 'SEND');
  assert.equal(f.getCampaign().counts.excluded_no_record, 1);
  assert.deepEqual(recipients(f), before);
});

for (const state of [null, undefined, 'PENDING', 'CONFLICT', 'UNKNOWN', 'ACTIVE']) {
  test(`第14段階 7.4.1 送信直前の正本状態 ${state} を判定し、非ACTIVEはSKIPPED CONTACT_BLOCKED`, async () => {
    const f = fixture({ count: 1 });
    assert.equal((await f.prepare()).action, 'SEND');
    if (state === null) f.ddb.items.delete(`CONTACT_META/${hash(f.addresses[0])}`);
    else setMeta(f, 0, { registration_state: state });
    assert.equal(await contactBlocked(runtime(f), f.addresses[0], 'news'), state !== 'ACTIVE');
    await f.send();
    assert.equal(f.sends.length, state === 'ACTIVE' ? 1 : 0);
    assert.equal(f.getCampaign().counts.skipped_blocked, state === 'ACTIVE' ? 0 : 1);
    if (state !== 'ACTIVE') {
      const body = [...f.files.entries()].find(([key]) => key.startsWith('results/'))[1];
      const result = JSON.parse(body.trim());
      assert.equal(result.r, 'SKIPPED');
      assert.equal(result.c, 'CONTACT_BLOCKED');
      assert.equal(f.getCampaign().counts.failed, 0);
    }
  });
}

test('第14段階 7.4.1 日次枠を予約した後に正本が消えても送らず、枠を戻さない', async () => {
  const f = fixture({ count: 1 });
  await f.prepare();
  f.ddb.afterUpdate = async (input) => { if (input.Key.PK.S === 'DAILY') f.ddb.items.delete(`CONTACT_META/${hash(f.addresses[0])}`); };
  await f.send();
  assert.equal(f.sends.length, 0);
  assert.equal(f.getCampaign().counts.skipped_blocked, 1);
  assert.equal(f.ddb.get('DAILY', '2026-11-03').reserved_attempts, 1);
});

test('第14段階 4.7 送信直前のKMS照合は残し、ACTIVEでもERASED一致なら送らない', async () => {
  const f = fixture({ count: 1 });
  await f.prepare();
  f.ddb.set({ PK: 'ERASED', SK: eraseHash(f.addresses[0]) });
  let calls = 0;
  const mac = f.deps.kms.generateMac;
  f.deps.kms.generateMac = async (input) => { calls += 1; return mac(input); };
  await f.send();
  assert.ok(calls > 0);
  assert.equal(f.sends.length, 0);
  assert.equal(f.getCampaign().counts.skipped_blocked, 1);
});

test('第14段階 API-06 新規登録はSES成功後にACTIVEとなり、次の準備の対象になる', async () => {
  const f = managementFixture({ env: 'prod', count: 0 });
  const email = 'manual@example.com';
  const create = f.deps.ses.createContact;
  f.deps.ses.createContact = async (input) => {
    assert.equal(meta(f, email).registration_state, 'PENDING');
    return create(input);
  };
  const response = await f.request('POST /contacts', { email, topics: ['news'], consent });
  assert.equal(response.statusCode, 201, response.body);
  assert.equal(meta(f, email).registration_state, 'ACTIVE');
  assert.equal((await f.prepare()).action, 'SEND');
  assert.deepEqual(recipients(f), [email]);
});

test('第14段階 NEW_ONLYの取込からSES完了・準備・送信まで、BACKUP復旧後も全ての新規会員が対象になる', async () => {
  const f = managementFixture({ env: 'prod', count: 0 });
  f.ddb.set({ PK: 'SETTINGS', SK: 'REKEY', source: 'BACKUP', kid: 'k1', complete: true });
  const emails = ['csv1@example.com', 'csv2@example.com'];
  const createJob = f.deps.ses.createImportJob;
  f.deps.ses.createImportJob = async (input) => {
    const key = input.ImportDataSource.S3Url.replace(`s3://${f.deps.dataBucket}/`, '');
    const rows = f.files.get(key).trim().split('\n').map(JSON.parse);
    for (const row of rows) {
      assert.equal(meta(f, row.emailAddress).registration_state, 'ACTIVE');
      f.contacts.push({ EmailAddress: row.emailAddress, UnsubscribeAll: row.unsubscribeAll, AttributesData: row.attributesData, TopicPreferences: row.topicPreferences.map(({ topicName, subscriptionStatus }) => ({ TopicName: topicName, SubscriptionStatus: subscriptionStatus })) });
    }
    return createJob(input);
  };
  const received = await f.receive(f.importCsv(emails[0], `${emails[1]},会員2,2026-01-01T00:00:00Z,フォーム,news\n`));
  assert.equal(received.statusCode, 202, received.body);
  const id = received.json.import_id;
  assert.equal((await f.worker({ mode: 'import', import_id: id })).status, 'PREVIEW');
  assert.equal((await f.confirmImport(id)).status, 'IMPORTING');
  const job = f.ddb.get('IMPORT', id).job_id;
  Object.assign(f.jobs.get(job), { JobStatus: 'COMPLETED', ProcessedRecordsCount: 2 });
  const completed = await f.request(`GET /imports/${id}`);
  assert.equal(completed.json.status, 'DONE');
  assert.equal((await f.prepare()).action, 'SEND');
  assert.deepEqual(recipients(f), emails);
  assert.equal(f.getCampaign().counts.excluded_no_record, 0);
  await f.send();
  assert.equal((await f.send()).action, 'DONE');
  assert.equal(f.sends.length, 2);
  assert.equal(f.getCampaign().counts.accepted, 2);
});

test('第14段階 API-09 記録のない宛先も新しい再同意でACTIVEとなり、準備の対象へ戻る', async () => {
  const f = managementFixture({ count: 1 });
  assert.equal(meta(f), undefined);
  let pending = false;
  f.ddb.afterUpdate = async (_, item) => {
    if (item.PK !== 'CONTACT_META' || item.version !== 1) return;
    pending = true;
    assert.equal(item.registration_state, 'PENDING');
    assert.equal(item.blocked_all, true);
    assert.equal(await contactBlocked(runtime(f), f.addresses[0], 'news'), true);
  };
  const response = await f.request('POST /contacts/reconsent', { email: f.addresses[0], topics: ['news'], reconsent: { at: '2026-11-01T00:00:00Z', source: '本人の再申込' }, note: '本人の依頼を照合' });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(pending, true);
  assert.equal(meta(f).registration_state, 'ACTIVE');
  assert.equal(meta(f).blocked_all, false);
  assert.equal((await f.prepare()).action, 'SEND');
  assert.deepEqual(recipients(f), f.addresses);
});

test('第14段階 contact-backfillは新しい正本をACTIVEで作り、既存のPENDINGを昇格させない', async () => {
  const f = managementFixture({ count: 2 });
  f.ddb.set({ PK: 'CONTACT_META', SK: hash(f.addresses[1]), kid: 'k1', version: 1, registration_state: 'PENDING', blocked_all: true });
  assert.equal((await f.worker({ mode: 'contact-backfill' })).status, 'DONE');
  assert.equal(meta(f).registration_state, 'ACTIVE');
  assert.equal(meta(f, f.addresses[1]).registration_state, 'PENDING');
  assert.equal((await f.prepare()).action, 'SEND');
  assert.deepEqual(recipients(f), [f.addresses[0]]);
  assert.equal(f.getCampaign().counts.excluded_no_record, 1);
});

test('第14段階 BACKUP復旧後の記録なしは日次・詳細表示・名前変更・backfillで有効化せず、再同意でだけ復帰する', async () => {
  const f = managementFixture({ count: 1 });
  f.contacts[0].AttributesData = JSON.stringify({ name: '旧属性', consent });
  f.ddb.set({ PK: 'SETTINGS', SK: 'REKEY', source: 'BACKUP', kid: 'k1', complete: true });
  assert.equal((await f.worker({ mode: 'daily' })).results.backup, 'FAIL');
  assert.equal(meta(f), undefined);
  assert.equal(f.ddb.get('SETTINGS', 'CONTACT_BACKUP').attributes_missing, 1);
  const detail = await f.request('POST /contacts/get', { email: f.addresses[0] });
  assert.equal(detail.statusCode, 200, detail.body);
  assert.equal(detail.json.UnsubscribeAll, true);
  assert.equal(meta(f), undefined);
  const update = await f.request('POST /contacts/update', { email: f.addresses[0], name: '変更だけ' });
  assert.equal(update.json.error_code, 'RECONSENT_REQUIRED');
  await assert.rejects(f.worker({ mode: 'contact-backfill' }), { code: 'RECONSENT_REQUIRED' });
  assert.equal(meta(f), undefined);
  const response = await f.request('POST /contacts/reconsent', { email: f.addresses[0], topics: ['news'], reconsent: { at: '2026-11-01T00:00:00Z', source: '本人の再申込' }, note: '本人依頼を確認' });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(meta(f).registration_state, 'ACTIVE');
  assert.equal(meta(f).blocked_all, false);
  assert.equal((await f.prepare()).action, 'SEND');
  assert.deepEqual(recipients(f), f.addresses);
});

function archive(f, id, scope, index) {
  const ts = '2026-11-03T09:30:00.000Z';
  const item = { PK: 'AUDIT#202611', SK: `${ts}#${index}`, ts, action: 'CONTACT_STOP', target: 'contact', addr_id: id, details: { scope, operation: 'UNSUBSCRIBE' } };
  f.files.set(auditArchiveKey(item), JSON.stringify({ eventName: 'INSERT', after: item, sha256: createHash('sha256').update(JSON.stringify({ after: item })).digest('hex') }));
}

for (const source of ['SES', 'BACKUP']) test(`第14段階 rekey ${source}は有効会員の正本をACTIVEで作り、新しい鍵で準備できる`, async () => {
  const f = managementFixture({ count: 2, registered: true });
  f.settings.sending_enabled = false;
  f.deps.secretsProvider = { get: async () => ({ kid: 'k2', key: newKey, ...(source === 'SES' ? { previous: { kid: 'k1', key: oldKey } } : {}) }) };
  if (source === 'BACKUP') {
    const body = gzipSync(f.contacts.map((contact) => JSON.stringify({ ...contact, HT2AddrId: hash(contact.EmailAddress), AttributesData: JSON.stringify({ consent }) })).join('\n'));
    f.files.set('backups/contacts/2026-11-02.jsonl.gz', body);
    f.files.set('backups/contacts/2026-11-02.manifest.json', JSON.stringify({ complete: true, backed_up_at: '2026-11-02T03:00:00Z', total: 2, sha256: createHash('sha256').update(body).digest('hex') }));
  }
  f.resetWorker();
  const result = await f.worker({ mode: 'rekey', source, ...(source === 'BACKUP' ? { backup_date: '2026-11-02' } : {}) });
  assert.equal(result.status, 'DONE');
  for (const email of f.addresses) assert.equal(meta(f, email, newKey).registration_state, 'ACTIVE');
  f.settings.sending_enabled = true;
  assert.equal((await f.worker(f.event('prepare'))).action, 'SEND');
  assert.deepEqual(recipients(f), f.addresses);
});

test('第14段階 rekey SESはPENDING・CONFLICT・状態なしをACTIVEへ昇格させない', async () => {
  const f = managementFixture({ count: 3, registered: true });
  const states = ['PENDING', 'CONFLICT', undefined];
  states.forEach((registration_state, index) => setMeta(f, index, { registration_state }));
  f.settings.sending_enabled = false;
  f.deps.secretsProvider = { get: async () => ({ kid: 'k2', key: newKey, previous: { kid: 'k1', key: oldKey } }) };
  f.resetWorker();
  assert.equal((await f.worker({ mode: 'rekey', source: 'SES' })).status, 'DONE');
  f.addresses.forEach((email, index) => assert.equal(meta(f, email, newKey).registration_state, states[index]));
  f.settings.sending_enabled = true;
  assert.equal((await f.worker(f.event('prepare'))).action, 'DONE');
  assert.equal(f.getCampaign().counts.excluded_no_record, 3);
});

test('第14段階 rekey BACKUPはバックアップ外を作らず、未対応の停止とSES連絡先の件数を警告し、有効会員は止めない', async () => {
  const f = managementFixture({ count: 4, registered: true });
  f.settings.sending_enabled = false;
  const rows = f.contacts.slice(0, 2).map((contact) => ({ ...contact, HT2AddrId: hash(contact.EmailAddress), AttributesData: JSON.stringify({ name: '会員', consent }) }));
  const body = gzipSync(rows.map((row) => JSON.stringify(row)).join('\n'));
  f.files.set('backups/contacts/2026-11-02.jsonl.gz', body);
  f.files.set('backups/contacts/2026-11-02.manifest.json', JSON.stringify({ complete: true, backed_up_at: '2026-11-02T03:00:00Z', total: 2, sha256: createHash('sha256').update(body).digest('hex') }));
  archive(f, hash(f.addresses[0]), 'news', 0);
  archive(f, hash(f.addresses[2]), 'ALL', 1);
  archive(f, hash(f.addresses[2]), 'news', 2);
  f.deps.secretsProvider = { get: async () => ({ kid: 'k2', key: newKey }) };
  f.resetWorker();
  const event = { mode: 'rekey', source: 'BACKUP', backup_date: '2026-11-02' };
  const result = await f.worker(event);
  assert.equal(result.status, 'DONE');
  assert.deepEqual(result.warnings.map(({ code, count }) => ({ code, count })), [{ code: 'UNIDENTIFIED_STOPS', count: 2 }, { code: 'CONTACTS_NOT_IN_BACKUP', count: 2 }]);
  assert.ok(result.warnings.every(({ message }) => message === '送信の対象外。再登録か再同意で戻す。'));
  assert.deepEqual(meta(f, f.addresses[0], newKey).blocked_topics, ['news']);
  assert.equal(meta(f, f.addresses[1], newKey).blocked_all, false);
  assert.equal(meta(f, f.addresses[1], newKey).attributes.name, '会員');
  for (const email of f.addresses.slice(2)) {
    assert.equal(meta(f, email), undefined);
    assert.equal(meta(f, email, newKey), undefined);
  }
  await f.worker({ mode: 'daily' });
  for (const email of f.addresses.slice(2)) assert.equal(meta(f, email, newKey), undefined);
  assert.ok(!JSON.stringify(result.warnings).includes('@'));
  assert.deepEqual((await f.worker(event)).warnings, result.warnings);
  f.settings.sending_enabled = true;
  assert.equal((await f.worker(f.event('prepare'))).action, 'SEND');
  assert.deepEqual(recipients(f), [f.addresses[1]]);
  assert.equal(f.getCampaign().counts.excluded_no_record, 2);
});

test('第14段階 7.3 10万件を100ページ・500ファイルで準備し、宛先ごとのKMSとGetItemを呼ばない', async () => {
  const f = fixture({ env: 'prod', count: 100000, cap: 100000 });
  f.contactPages = Array.from({ length: 100 }, (_, index) => ({ Contacts: f.contacts.slice(index * 1000, (index + 1) * 1000), ...(index < 99 ? { NextToken: String(index + 1) } : {}) }));
  const rows = [...f.ddb.items.values()].filter((item) => item.PK === 'CONTACT_META').sort((a, b) => a.SK.localeCompare(b.SK));
  const positions = new Map(rows.map((item, index) => [item.SK, index + 1]));
  const query = f.deps.ddb.query;
  let queries = 0;
  f.deps.ddb.query = async (input) => {
    if (input.ExpressionAttributeValues[':pk'].S !== 'CONTACT_META') return query(input);
    assert.equal(input.ConsistentRead, true);
    queries += 1;
    const offset = positions.get(input.ExclusiveStartKey?.SK.S) ?? 0;
    const page = rows.slice(offset, offset + 2000);
    return { Items: page.map(marshall), ...(offset + page.length < rows.length ? { LastEvaluatedKey: marshall({ PK: 'CONTACT_META', SK: page.at(-1).SK }) } : {}) };
  };
  const get = f.deps.ddb.getItem;
  f.deps.ddb.getItem = async (input) => {
    assert.ok(!['CONTACT_META', 'ERASED'].includes(input.Key.PK.S), 'Prepare must read metadata in pages');
    return get(input);
  };
  f.deps.kms.generateMac = async () => { throw new Error('Prepare must not call KMS'); };
  assert.equal((await f.prepare()).action, 'SEND');
  assert.equal(f.getCampaign().recipients_total, 100000);
  assert.equal(f.getCampaign().chunks_total, 500);
  assert.equal(f.getCampaign().counts.excluded_no_record, 0);
  assert.equal(f.listInputs.length, 100);
  assert.equal(queries, 50);
  const saved = recipients(f);
  assert.equal(saved.length, 100000);
  assert.equal(new Set(saved).size, 100000);
  assert.deepEqual(saved, [...f.addresses].sort());
  assert.ok([...f.files.entries()].filter(([key]) => key.startsWith('recipients/')).every(([, value]) => value.trim().split('\n').length === 200));
});
