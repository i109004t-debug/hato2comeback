import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { managementFixture } from '../helpers/management.js';
import { eraseHash } from '../helpers/sending.js';
import { addressHash } from '../../src/common/log.js';
import { auditArchiveKey } from '../../src/common/audit-archive.js';
import { createAuditItem, createAudit } from '../../src/common/audit.js';
import { ApiError, errorText } from '../../web/js/api.js';

const oldKey = '7'.repeat(64);
const newKey = '8'.repeat(64);
const oldId = (email) => addressHash(email, oldKey);
const newId = (email) => addressHash(email, newKey);
const backupAt = '2026-11-02T03:00:00.000Z';
const consent = { at: '2026-01-01T00:00:00Z', source: '入会フォーム' };
const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');

function archive(f, action, addr_id, details, ts = '2026-11-03T09:30:00.000Z') {
  const item = { PK: 'AUDIT#202611', SK: `${ts}#${f.files.size}`, ts, action, target: 'contact', addr_id, details };
  const key = auditArchiveKey(item);
  f.files.set(key, JSON.stringify({ eventName: 'INSERT', after: item, sha256: createHash('sha256').update(JSON.stringify({ after: item })).digest('hex') }));
  return key;
}

function rekeyFixture({ identified = true, previous = false, count = 4 } = {}) {
  const f = managementFixture({ count });
  f.settings.sending_enabled = false;
  f.deps.auditArchiveBucket = 'archive';
  f.deps.secretsProvider = { get: async () => ({ kid: 'k2', key: newKey, ...(previous ? { previous: { kid: 'k1', key: oldKey } } : {}) }) };
  f.resetWorker();
  const rows = f.addresses.map((EmailAddress) => ({ EmailAddress, ...(identified ? { HT2AddrId: oldId(EmailAddress) } : {}), AttributesData: JSON.stringify({ name: 'バックアップの名前', consent }), TopicPreferences: [{ TopicName: 'news', SubscriptionStatus: 'OPT_IN' }] }));
  const body = gzipSync(rows.map((row) => JSON.stringify(row)).join('\n'));
  f.files.set('backups/contacts/2026-11-02.jsonl.gz', body);
  f.manifest = 'backups/contacts/2026-11-02.manifest.json';
  f.files.set(f.manifest, JSON.stringify({ complete: true, backed_up_at: backupAt, total: count, sha256: createHash('sha256').update(body).digest('hex') }));
  for (const email of f.addresses) f.ddb.set({ PK: 'CONTACT_META', SK: oldId(email), kid: 'k1', version: 1, attributes: { name: '旧鍵' } });
  f.rekey = () => f.worker({ mode: 'rekey', source: 'BACKUP', backup_date: '2026-11-02' }, f.context);
  return f;
}

test('第13段階 rekey BACKUPは旧鍵なしでAPI-07・08・一括停止とERASEを再適用し、名前・再同意を報告だけにする', async () => {
  const f = rekeyFixture();
  for (const [index, scope, operation] of [[0, 'news', 'UPDATE'], [1, 'ALL', 'UNSUBSCRIBE'], [2, 'event', 'IMPORT']]) archive(f, 'CONTACT_STOP', oldId(f.addresses[index]), { scope, operation });
  archive(f, 'ERASE', oldId(f.addresses[3]), { scope: 'ALL', operation: 'ERASE', erase_mac: eraseHash(f.addresses[3]) });
  archive(f, 'RECONSENT', oldId(f.addresses[1]), { topics: ['news'] });
  archive(f, 'CONTACT_UPDATE', oldId(f.addresses[0]), { attributes: { name: '再適用しない' } });
  archive(f, 'CONTACT_STOP', oldId(f.addresses[0]), { scope: 'event', operation: 'UPDATE' }, backupAt);
  const result = await f.rekey();
  assert.equal(result.status, 'DONE');
  assert.deepEqual(result.reapplied, { stops: 3, erasures: 1 });
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.redo.map((item) => item.action).sort(), ['CONTACT_UPDATE', 'RECONSENT']);
  assert.deepEqual(f.ddb.get('CONTACT_META', newId(f.addresses[0])).blocked_topics, ['news']);
  assert.equal(f.ddb.get('CONTACT_META', newId(f.addresses[0])).attributes.name, 'バックアップの名前');
  assert.equal(f.ddb.get('CONTACT_META', newId(f.addresses[1])).blocked_all, true);
  assert.equal(f.ddb.get('CONTACT_META', newId(f.addresses[1])).attributes.name, undefined);
  assert.deepEqual(f.ddb.get('CONTACT_META', newId(f.addresses[2])).blocked_topics, ['event']);
  const erased = f.ddb.get('CONTACT_META', newId(f.addresses[3]));
  assert.equal(erased.erased, true); assert.equal(erased.attributes, undefined); assert.equal(erased.kid, 'k2');
  assert.ok(f.ddb.get('ERASED', eraseHash(f.addresses[3])));
  assert.ok(!f.contacts.some((item) => item.EmailAddress === f.addresses[3]));
  assert.ok(f.addresses.every((email) => !f.ddb.get('CONTACT_META', oldId(email))));
  assert.equal(f.ddb.get('LOCK', 'CONTACT_CREATE').owner, undefined);
  assert.ok(!JSON.stringify(result).includes('@'));
  const writes = f.ddb.calls.length;
  assert.deepEqual((await f.rekey()).reapplied, result.reapplied);
  assert.equal(f.ddb.calls.length, writes);
});

for (const previous of [false, true]) test(`第14段階 古いバックアップの停止は旧鍵${previous ? 'ありで照合' : 'なしなら復旧未完了に'}する`, async () => {
  const f = rekeyFixture({ identified: false, previous, count: 2 });
  archive(f, 'CONTACT_STOP', oldId(f.addresses[0]), { scope: 'news', operation: 'IMPORT' });
  const result = await f.rekey();
  assert.equal(result.status, previous ? 'DONE' : 'FAILED');
  assert.equal(f.ddb.get('CONTACT_META', newId(f.addresses[1])).blocked_all, false);
  assert.equal(f.ddb.get('CONTACT_META', newId(f.addresses[1])).attributes.name, 'バックアップの名前');
  if (previous) assert.deepEqual(result.warnings, []);
  else {
    assert.equal(result.code, 'BACKUP_ATTRIBUTES_MISSING');
    assert.ok(f.ddb.get('CONTACT_META', oldId(f.addresses[1])));
    assert.equal(f.ddb.get('LOCK', 'CONTACT_CREATE').owner, 'rekey:k2');
    assert.equal(f.ddb.get('SETTINGS', 'REKEY').complete, false);
  }
});

test('第13段階 旧IDを対応付けられないERASEもKMS照合で復旧し、SESと属性を消す', async () => {
  const f = rekeyFixture({ identified: false, count: 1 });
  archive(f, 'ERASE', oldId(f.addresses[0]), { scope: 'ALL', operation: 'ERASE', erase_mac: eraseHash(f.addresses[0]) });
  const result = await f.rekey();
  assert.equal(result.status, 'DONE'); assert.equal(result.reapplied.erasures, 1);
  assert.equal(f.contacts.length, 0);
  assert.equal(f.ddb.get('CONTACT_META', newId(f.addresses[0])).attributes, undefined);
  assert.ok(f.ddb.get('ERASED', eraseHash(f.addresses[0])));
});

for (const failure of ['archive', 'tamper', 'incomplete', 'timestamp', 'erase', 'report']) test(`第13段階 rekey監査の${failure}障害は旧項目・排他を残し、修復後に再開できる`, async () => {
  const f = rekeyFixture({ count: 1 });
  const key = archive(f, 'CONTACT_STOP', oldId(f.addresses[0]), { scope: 'news', operation: 'IMPORT' });
  const original = f.files.get(key);
  const manifest = f.files.get(f.manifest);
  const get = f.deps.s3.getObject;
  const remove = f.deps.ses.deleteContact;
  const put = f.deps.s3.putObject;
  if (failure === 'archive') f.deps.s3.getObject = async (input) => { if (input.Bucket === 'archive') throw new Error('denied'); return get(input); };
  if (failure === 'tamper') { const value = JSON.parse(original); value.after.details.scope = 'ALL'; f.files.set(key, JSON.stringify(value)); }
  if (failure === 'incomplete') { f.files.delete(key); archive(f, 'ERASE', oldId(f.addresses[0]), { scope: 'ALL', operation: 'ERASE' }); }
  if (failure === 'timestamp') { const value = JSON.parse(manifest); delete value.backed_up_at; f.files.set(f.manifest, JSON.stringify(value)); }
  if (failure === 'erase') { f.files.delete(key); archive(f, 'ERASE', oldId(f.addresses[0]), { scope: 'ALL', operation: 'ERASE', erase_mac: eraseHash(f.addresses[0]) }); f.deps.ses.deleteContact = async () => { throw new Error('denied'); }; }
  if (failure === 'report') f.deps.s3.putObject = async (input) => { if (input.Key.startsWith('restore-reports/')) throw new Error('denied'); return put(input); };
  assert.equal((await f.rekey()).status, 'FAILED');
  assert.ok(f.ddb.get('CONTACT_META', oldId(f.addresses[0])));
  assert.equal(f.ddb.get('LOCK', 'CONTACT_CREATE').owner, 'rekey:k2');
  f.deps.s3.getObject = get; f.deps.ses.deleteContact = remove; f.deps.s3.putObject = put;
  f.files.set(f.manifest, manifest);
  for (const path of [...f.files.keys()].filter((path) => path.startsWith('audit/'))) f.files.delete(path);
  f.files.set(key, original);
  assert.equal((await f.rekey()).status, 'DONE');
  assert.deepEqual(f.ddb.get('CONTACT_META', newId(f.addresses[0])).blocked_topics, ['news']);
});

test('第13段階 再実施一覧が400KiBを超えてもS3へ保存し、REKEYのDynamoDB項目を大きくしない', async () => {
  const f = rekeyFixture({ count: 0 });
  for (let index = 0; index < 3000; index += 1) archive(f, 'CONTACT_UPDATE', 'a'.repeat(64), {});
  const result = await f.rekey();
  assert.equal(result.status, 'DONE'); assert.equal(result.redo.length, 3000);
  assert.ok(Buffer.byteLength(JSON.stringify(result.redo)) > 400 * 1024);
  const state = f.ddb.get('SETTINGS', 'REKEY');
  assert.equal(state.redo, undefined); assert.ok(Buffer.byteLength(JSON.stringify(state)) < 400 * 1024);
  assert.deepEqual(JSON.parse(f.files.get(state.recovery_report_key)).redo, result.redo);
  assert.equal((await f.rekey()).redo.length, 3000);
});

test('第13段階 COPYで中断しても次回に監査を再適用してから旧kidを消す', async () => {
  const f = rekeyFixture({ count: 1 });
  archive(f, 'CONTACT_STOP', oldId(f.addresses[0]), { scope: 'ALL', operation: 'UNSUBSCRIBE' });
  const update = f.deps.ddb.updateItem;
  f.deps.ddb.updateItem = async (input) => { const result = await update(input); if (input.Key.PK.S === 'CONTACT_META') f.setRemaining(120000); return result; };
  assert.equal((await f.rekey()).status, 'MORE');
  assert.equal(f.ddb.get('SETTINGS', 'REKEY').phase, 'REPLAY');
  assert.ok(f.ddb.get('CONTACT_META', oldId(f.addresses[0])));
  f.deps.ddb.updateItem = update; f.setRemaining(900000);
  assert.equal((await f.rekey()).status, 'DONE');
  assert.equal(f.ddb.get('CONTACT_META', newId(f.addresses[0])).blocked_all, true);
});

test('第13段階 日次バックアップに元のaddr_idと時刻を保存する', async () => {
  const f = managementFixture({ count: 1 });
  await f.worker({ mode: 'daily' }, f.context);
  const path = [...f.files.keys()].find((path) => path.endsWith('.jsonl.gz') && path.startsWith('backups/'));
  const row = JSON.parse(gunzipSync(f.files.get(path)).toString('utf8').trim());
  assert.equal(row.HT2AddrId, oldId(f.addresses[0]));
  assert.ok(JSON.parse(f.files.get(path.replace('.jsonl.gz', '.manifest.json'))).backed_up_at);
});

for (const [input, expected] of [
  ['2026-11-03T09:00:00.123456Z', '2026-11-03T09:00:00.123Z'],
  ['2026-11-03T18:00:00.999999999999999999+09:00', '2026-11-03T09:00:00.999Z'],
  ['2026-11-03T09:00:00.0000000001Z', '2026-11-03T09:00:00.000Z'],
]) test(`第13段階 restore-apply/checkは小数をミリ秒に切り捨てる ${input}`, async () => {
  const f = managementFixture(); f.settings.sending_enabled = false;
  f.deps.ddb.scan = async () => ({ Items: [] }); f.resetWorker();
  await f.worker({ mode: 'restore-apply', source_table: 'ht2-stg-restore-202611030900', types: ['CONTACT_META'], restore_point: input }, f.context);
  const result = await f.worker({ mode: 'restore-check', restore_point: input }, f.context);
  assert.equal(result.restore_point, expected);
  assert.equal(f.ddb.get('SETTINGS', 'RESTORE#202611030900').restore_point, expected);
});

test('第13段階 ミリ秒切捨て直後の停止もrestore-checkで再適用する', async () => {
  const f = managementFixture({ count: 1 }); f.settings.sending_enabled = false;
  archive(f, 'CONTACT_STOP', oldId(f.addresses[0]), { scope: 'ALL', operation: 'UPDATE' }, '2026-11-03T09:00:00.124Z');
  const result = await f.worker({ mode: 'restore-check', restore_point: '2026-11-03T09:00:00.123999Z' }, f.context);
  assert.equal(result.reapplied.stops, 1);
  assert.equal(f.ddb.get('CONTACT_META', oldId(f.addresses[0])).blocked_all, true);
});

for (const input of ['2026-02-30T00:00:00.123456Z', '2026-11-03T09:00:00.Z', '2026-11-03T09:00:00.123xZ', '2026-11-03T09:00:00.123456+99:00']) test(`第13段階 小数桁を広げても不正な復元時刻は拒否 ${input}`, async () => {
  const f = managementFixture();
  await assert.rejects(f.worker({ mode: 'restore-check', restore_point: input }, f.context), { code: 'INVALID_REQUEST' });
  assert.equal(f.ddb.calls.length, 0);
});

test('第13段階 スタッフ追加は確認済みアドレスでCognitoへ渡す', async () => {
  const f = managementFixture();
  assert.equal((await f.request('POST /staff', { email: 'new@example.com', name: '担当', roles: ['viewer'] })).statusCode, 200);
  assert.deepEqual(f.staffCalls[0].input.UserAttributes.find((item) => item.Name === 'email_verified'), { Name: 'email_verified', Value: 'true' });
  assert.ok(read('web/index.html').includes('管理者が本人のメールアドレスを確かめてから作成'));
});

for (const size of [1024 * 1024, 1024 * 1024 + 1, 1024 * 1024 + 4, 2 * 1024 * 1024]) test(`第13段階 API-28の証跡サイズ境界 ${size}`, async () => {
  const f = managementFixture();
  const start = await f.request('POST /settings/delivery-check', {});
  assert.equal(start.statusCode, 201, start.body);
  const response = await f.request(`POST /settings/delivery-check/${start.json.check_id}/evidence`, { case_id: 'T-25', file_name: 'proof.txt', content_base64: Buffer.alloc(size).toString('base64') });
  assert.equal(response.statusCode, size <= 1024 * 1024 ? 200 : 413, response.body);
  if (size > 1024 * 1024) {
    assert.equal(response.json.error_code, 'EVIDENCE_TOO_LARGE');
    assert.equal(response.json.message, '証跡のファイルは1MiB以下にしてください。');
    assert.ok(![...f.files.keys()].some((key) => key.startsWith('delivery-checks/') && key.includes('proof.txt')));
  }
  assert.match(errorText(new ApiError('EVIDENCE_TOO_LARGE', 413)), /証跡のファイルは1MiB以下にしてください。/);
  assert.ok(read('web/help.html').includes('EVIDENCE_TOO_LARGE'));
  assert.match(read('web/js/views/settings.js'), /file.size > 1024 \* 1024\) throw new ApiError\('EVIDENCE_TOO_LARGE'\)/);
});

for (const action of ['CONTACT_STOP', 'ERASE']) test(`第13段階 ${action}の監査は必須情報を省略・改変して書けない`, async () => {
  const entry = { actor_sub: 'admin', action, target: 'contact', result: 'SUCCESS', request_id: 'r', addr_id: 'a'.repeat(64), details: { scope: 'ALL', operation: action, ...(action === 'ERASE' ? { erase_mac: 'b'.repeat(64) } : {}) } };
  const variants = [{ ...entry, addr_id: undefined }, { ...entry, addr_id: ['a'.repeat(64)] }, { ...entry, details: undefined }, { ...entry, details: { ...entry.details, scope: undefined } }, { ...entry, details: { ...entry.details, scope: ['ALL'] } }, { ...entry, details: { ...entry.details, operation: '' } }];
  if (action === 'ERASE') variants.push({ ...entry, details: { ...entry.details, erase_mac: undefined } }, { ...entry, details: { ...entry.details, erase_mac: 'wrong' } }, { ...entry, details: { ...entry.details, scope: 'news' } });
  let writes = 0;
  const deps = { hmacKey: oldKey, tableName: 'table', ddb: { putItem: async () => { writes += 1; } } };
  for (const value of variants) {
    assert.throws(() => createAuditItem(value, deps), TypeError);
    await assert.rejects(createAudit(deps).write(value), TypeError);
  }
  assert.equal(writes, 0);
  assert.equal(createAuditItem({ ...entry, addr_id: undefined, email: 'member@example.com' }, deps).addr_id, oldId('member@example.com'));
  await createAudit(deps).write(entry); assert.equal(writes, 1);
});

test('第13段階 API-07・08・10と一括停止が復元に必要な監査を必ず残す', async () => {
  const f = managementFixture({ env: 'prod', count: 4, registered: true });
  assert.equal((await f.request('POST /contacts/update', { email: f.addresses[0], topics: { news: 'OPT_OUT' } })).statusCode, 200);
  assert.equal((await f.request('POST /contacts/unsubscribe', { email: f.addresses[1], scope: 'ALL' })).statusCode, 200);
  assert.equal((await f.request('POST /contacts/erase', { email: f.addresses[2], note: '本人依頼' })).statusCode, 200);
  const received = await f.receive(`email,name,stop\n${f.addresses[3]},,news\n`, 'stage13', 'UPDATE_EXISTING');
  const id = received.json.import_id;
  assert.equal((await f.worker({ mode: 'import', import_id: id })).status, 'PREVIEW');
  assert.equal((await f.confirmImport(id)).status, 'DONE');
  const audits = [...f.ddb.items.values()].filter((item) => ['CONTACT_STOP', 'ERASE'].includes(item.action));
  assert.equal(audits.length, 4);
  assert.deepEqual(audits.map((item) => item.details.operation).sort(), ['ERASE', 'IMPORT', 'UNSUBSCRIBE', 'UPDATE']);
  for (const item of audits) {
    assert.match(item.addr_id, /^[a-f0-9]{64}$/); assert.ok(item.details.scope);
    if (item.action === 'ERASE') assert.equal(item.details.erase_mac, eraseHash(f.addresses[2]));
    assert.ok(!JSON.stringify(item).includes('@'));
  }
});
