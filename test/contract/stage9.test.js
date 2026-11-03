import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { managementFixture } from '../helpers/management.js';
import { fixture, ID, eraseHash } from '../helpers/sending.js';
import { addressHash } from '../../src/common/log.js';
import { createSecrets } from '../../src/common/secrets.js';
import { createConfig } from '../../src/common/config.js';
import { createSender, buildSendInput } from '../../src/common/sender.js';
import { eraseMatch } from '../../src/common/erase.js';
import { createHandler } from '../../src/worker/handler.js';

const key = '7'.repeat(64);
const nextKey = '8'.repeat(64);
const consent = { at: '2026-01-01T00:00:00Z', source: '入会フォーム' };
const hash = (email) => addressHash(email, key);
const nextHash = (email) => addressHash(email, nextKey);

test('T-61 KMSに正規化したアドレスとHMAC_SHA_256だけを渡し、MAC全32バイトを16進にする', async () => {
  let observed;
  const result = await eraseMatch({ eraseMacKeyId: 'key', kms: { generateMac: async (input) => { observed = input; return { Mac: Uint8Array.from({ length: 32 }, (_, i) => i) }; } } }, 'T.a+news@googlemail.com');
  assert.equal(observed.KeyId, 'key'); assert.equal(observed.MacAlgorithm, 'HMAC_SHA_256'); assert.equal(observed.Message.toString(), 'ta@gmail.com');
  assert.equal(result, '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f');
});

for (const Mac of [undefined, 'a'.repeat(32), Buffer.alloc(31), Buffer.alloc(33)]) test(`4.7 不正なKMS応答を照合不能として拒否 ${typeof Mac}/${Mac?.length}`, async () => {
  await assert.rejects(eraseMatch({ kms: { generateMac: async () => ({ Mac }) } }, 'a@example.com'), { status: 503, code: 'ERASE_CHECK_UNAVAILABLE' });
});

for (const value of [{ key }, { kid: '', key }, { kid: 'k1', key: 'x'.repeat(31) }, { kid: 'k2', key, previous: { kid: 'k1', key: 'short' } }, { kid: 'k1', key, previous: { kid: 'k1', key: nextKey } }]) test(`4.7 kidと鍵の不正形式を拒否 ${JSON.stringify(value).slice(0, 30)}`, async () => {
  const provider = createSecrets({ env: 'dev', secrets: { getSecretValue: async () => ({ SecretString: JSON.stringify(value) }) } });
  await assert.rejects(provider.get('address-hmac'), { code: 'CONFIGURATION_INVALID' });
});

test('4.7 新旧のkid/keyを検証して読み、旧シークレット名は受け付けない', async () => {
  const value = { kid: 'k2', key: nextKey, previous: { kid: 'k1', key } };
  const provider = createSecrets({ env: 'dev', secrets: { getSecretValue: async (input) => { assert.equal(input.SecretId, '/ht2/dev/address-hmac'); return { SecretString: JSON.stringify(value) }; } } });
  assert.deepEqual(await provider.get('address-hmac'), value);
  await assert.rejects(provider.get('erase-hmac'), TypeError);
});

test('T-71 origはSES CreateContactだけに残し、CONTACT_METAと監査には保存しない', async () => {
  const f = managementFixture({ env: 'prod' });
  const response = await f.request('POST /contacts', { email: 'A.B+news@googlemail.com', consent, topics: ['news'] });
  assert.equal(response.statusCode, 201, response.body);
  assert.equal(JSON.parse(f.changes[0].AttributesData).orig, 'A.B+news@googlemail.com');
  const saved = f.ddb.get('CONTACT_META', hash('ab@gmail.com'));
  assert.equal(saved.kid, 'k1'); assert.equal(saved.attributes.orig, undefined);
  assert.ok(!JSON.stringify([saved, ...[...f.ddb.items.values()].filter((item) => item.PK.startsWith('AUDIT#'))]).includes('@'));
  const audit = [...f.ddb.items.values()].find((item) => item.action === 'CONTACT_CREATE');
  assert.equal(audit.addr_id, hash('ab@gmail.com')); assert.equal(audit.addr_id.length, 64); assert.equal(audit.addr8, undefined);
});

for (const [operation, body] of [
  ['POST /contacts', { email: 'new@example.com', consent: { ...consent, source: 'mail user@example.com 申込' }, topics: ['news'] }],
  ['POST /contacts/reconsent', { email: 'member0@example.com', reconsent: { at: '2026-11-01T00:00:00Z', source: '本人 user@example.com' }, topics: ['news'], note: '本人確認' }],
]) test(`T-71 同意の取得経路のアドレスを422で拒否 ${operation}`, async () => {
  const f = managementFixture({ env: 'prod', count: 1 });
  const result = await f.request(operation, body);
  assert.equal(result.statusCode, 422); assert.equal(result.json.error_code, 'CONSENT_SOURCE_HAS_ADDRESS'); assert.equal(f.changes.length, 0);
});

for (const operation of ['create', 'reconsent', 'erase']) test(`T-61 KMS障害時は${operation}を503で拒否してSESを変更しない`, async () => {
  const f = managementFixture({ env: 'prod', count: 1 });
  f.deps.kms.generateMac = async () => { throw new Error('KMS unavailable'); };
  const result = await f.request(operation === 'create' ? 'POST /contacts' : `POST /contacts/${operation}`, operation === 'create' ? { email: 'new@example.com', consent, topics: ['news'] } : operation === 'erase' ? { email: f.addresses[0], note: '本人依頼' } : { email: f.addresses[0], reconsent: { ...consent, at: '2026-11-01T00:00:00Z' }, topics: ['news'], note: '本人確認' });
  assert.equal(result.statusCode, 503); assert.equal(result.json.error_code, 'ERASE_CHECK_UNAVAILABLE'); assert.equal(f.changes.length, 0);
});

test('T-61 取込の各行をKMSで照合し、照合不能ならジョブ・属性を作らない', async () => {
  const f = managementFixture({ env: 'prod' });
  const received = await f.receive(f.importCsv()); let calls = 0;
  f.deps.kms.generateMac = async () => { calls += 1; throw new Error('denied'); };
  await assert.rejects(f.worker({ mode: 'import', import_id: received.json.import_id }, f.context), { code: 'ERASE_CHECK_UNAVAILABLE' });
  assert.equal(calls, 1); assert.equal(f.jobs.size, 0); assert.equal(f.ddb.get('CONTACT_META', hash('new@example.com')), undefined);
});

test('T-71 取込の同意にアドレスがあれば行の結果にコードだけを記録する', async () => {
  const f = managementFixture({ env: 'prod' });
  const received = await f.receive(f.importCsv().replace('フォーム', 'private@example.com'));
  await f.worker({ mode: 'import', import_id: received.json.import_id }, f.context);
  const report = JSON.parse(f.files.get(`imports/report/${received.json.import_id}.json`));
  assert.deepEqual(report.rows, [{ row: 2, code: 'CONSENT_SOURCE_HAS_ADDRESS' }]); assert.equal(f.jobs.size, 0);
});

for (const state of ['Enabled', 'Disabled', 'PendingDeletion', 'Unavailable']) test(`4.7 日次点検はEraseMacKeyの状態を通知する ${state}`, async () => {
  const f = managementFixture({ count: 0 });
  f.deps.kms.describeKey = async (input) => { assert.equal(input.KeyId, 'erase-key'); if (state === 'Unavailable') throw new Error('denied'); return { KeyMetadata: { KeyState: state } }; };
  await f.worker({ mode: 'daily' }, f.context);
  assert.equal(f.notices.some((notice) => notice.code === 'ERASE_KEY_UNAVAILABLE'), state !== 'Enabled');
});

for (const state of ['INSUFFICIENT_DATA', 'ALARM', 'MISSING', 'UNAVAILABLE']) test(`T-72 日次の評判監視は観測不足を通知理由にしない ${state}`, async () => {
  const f = managementFixture({ env: 'prod', count: 0 });
  if (state === 'MISSING') f.alarms.shift();
  else if (state === 'UNAVAILABLE') f.deps.cloudwatch.describeAlarms = async () => { throw new Error('denied'); };
  else f.alarms[0].StateValue = state;
  const result = await f.worker({ mode: 'daily' }, f.context);
  assert.equal(result.results.evidence, state === 'INSUFFICIENT_DATA' ? 'PASS' : 'FAIL');
  assert.equal(f.notices.some((notice) => ['REPUTATION_ALARM', 'MONITORING_UNAVAILABLE'].includes(notice.code)), state !== 'INSUFFICIENT_DATA');
});

test('T-70 全体停止から5秒境界で送信を止め、期限後の設定取得障害でも古い許可を使わない', async () => {
  const f = fixture({ count: 1 }); let enabled = true; let unavailable = false;
  const config = createConfig({ env: 'stg', now: f.deps.now, ssm: { getParameter: async () => { if (unavailable) throw new Error('ssm unavailable'); return { Parameter: { Value: JSON.stringify({ sending_enabled: enabled, nonprod_allowlist: f.addresses }) } }; } } });
  f.deps.config = config; await f.prepare(); await config.get();
  const began = f.deps.now();
  enabled = false; f.advance(4999);
  assert.equal((await config.get()).sending_enabled, true);
  f.advance(1);
  const sender = createSender({ ...f.deps, config, store: f.store, lock: { get: async () => ({ owner: 'test:stop', expires_at_ms: f.deps.now() + 60000 }) }, precheck: { run: async () => { throw new Error('must not reach health'); } } });
  const send = () => sender.trySend(buildSendInput(f.getCampaign(), f.addresses[0], f.deps), { next: f.deps.now(), interval: 100 }, { owner: 'test:stop', test: true });
  assert.equal((await send()).code, 'SENDING_DISABLED'); assert.equal(f.sends.length, 0); assert.equal(f.deps.now() - began, 5000);
  unavailable = true; f.advance(5000);
  await assert.rejects(send(), /ssm unavailable/); assert.equal(f.sends.length, 0);
});

test('T-70 最終連絡先確認がキャッシュ期限をまたいだ場合も送信前に設定を取り直す', async () => {
  const f = fixture({ count: 1 }); let enabled = true;
  const config = createConfig({ env: 'stg', now: f.deps.now, ssm: { getParameter: async () => ({ Parameter: { Value: JSON.stringify({ sending_enabled: enabled, nonprod_allowlist: f.addresses }) } }) } });
  await config.get(); f.advance(4999);
  let reads = 0; const get = f.ddb.getItem;
  f.ddb.getItem = async (input) => { const result = await get(input); if (input.Key.PK.S === 'ERASED' && ++reads === 2) { enabled = false; f.advance(1); } return result; };
  const health = { ok: true, checkedAt: f.deps.now(), config: await config.get(), quotaRemaining: 100, rate: 10 };
  const sender = createSender({ ...f.deps, config, store: f.store, health, lock: { get: async () => ({ owner: 'test:expiry', expires_at_ms: f.deps.now() + 60000 }) }, precheck: { consume() {}, run: async () => health } });
  const result = await sender.trySend(buildSendInput(f.getCampaign(), f.addresses[0], f.deps), { next: f.deps.now(), interval: 100 }, { owner: 'test:expiry', test: true });
  assert.equal(result.code, 'SENDING_DISABLED'); assert.equal(f.sends.length, 0);
});

for (const schema of [2, '1', undefined]) test(`T-69 APIは未知の配信・取込の版を409で拒否する ${schema}`, async () => {
  const f = managementFixture(); f.setCampaign({ schema_version: schema });
  if (schema === undefined) { const item = f.getCampaign(); delete item.schema_version; f.ddb.set(item); }
  for (const path of [f.campaignPath, '/campaigns']) {
    const result = await f.request(`GET ${path}`); assert.equal(result.statusCode, 409); assert.equal(result.json.error_code, 'UNSUPPORTED_SCHEMA');
  }
  const received = await f.receive(f.importCsv()); const id = received.json.import_id;
  const item = { ...f.ddb.get('IMPORT', id), schema_version: schema };
  if (schema === undefined) delete item.schema_version;
  f.ddb.set(item);
  const result = await f.request(`GET /imports/${id}`); assert.equal(result.statusCode, 409); assert.equal(result.json.error_code, 'UNSUPPORTED_SCHEMA');
  assert.equal((await f.request(`POST ${f.campaignPath}/submit`, {})).json.error_code, 'UNSUPPORTED_SCHEMA');
});

for (const mode of ['prepare', 'send', 'finish', 'import']) test(`T-69 worker/${mode}は未知の版をNEEDS_REVIEWへ保存して送信・取込を始めない`, async () => {
  const f = managementFixture();
  let input = f.event(mode); let PK = 'CAMPAIGN'; let id = ID;
  if (mode === 'import') { const received = await f.receive(f.importCsv()); id = received.json.import_id; PK = 'IMPORT'; input = { mode, import_id: id }; }
  const prior = f.ddb.get(PK, id); f.ddb.set({ ...prior, schema_version: 99 });
  const result = await f.worker(input, f.context);
  assert.equal(result.reason, 'UNSUPPORTED_SCHEMA');
  const saved = f.ddb.get(PK, id); assert.equal(saved.status, 'NEEDS_REVIEW'); assert.equal(saved.schema_version, 99); assert.equal(saved.version, prior.version + 1);
  assert.equal(saved.review?.reason ?? saved.error_code, 'UNSUPPORTED_SCHEMA'); assert.equal(f.sends.length, 0); assert.equal(f.jobs.size, 0);
});

test('T-61 結果ファイルとAPI-24は同じaddr_id・伏せ字・位置だけを返し、メールタグridも一致する', async () => {
  const f = managementFixture({ count: 1 }); await f.prepare();
  f.onSend = () => { throw Object.assign(new Error('timeout'), { name: 'TimeoutError' }); };
  await f.send();
  const raw = [...f.files.entries()].find(([path]) => path.startsWith('results/'))[1]; const result = JSON.parse(raw.trim());
  assert.deepEqual(Object.keys(result).sort(), ['a', 'm', 'r', 'c', 't', 'ci', 'ix'].sort());
  assert.equal(result.a, hash(f.addresses[0])); assert.equal(result.ci, 0); assert.equal(result.ix, 0); assert.ok(!raw.includes(f.addresses[0]));
  assert.equal(f.sends[0].input.EmailTags.find((tag) => tag.Name === 'rid').Value, result.a);
  assert.deepEqual((await f.request(`GET ${f.campaignPath}/failures`)).json.items[0], result);
});

function rekeyFixture(count = 2) {
  const f = managementFixture({ count }); f.settings.sending_enabled = false;
  for (const email of f.addresses) f.ddb.set({ PK: 'CONTACT_META', SK: hash(email), kid: 'k1', version: 1, attributes: { name: '会員', consent }, blocked_all: false, blocked_topics: ['event'] });
  f.deps.secretsProvider = { get: async () => ({ kid: 'k2', key: nextKey, previous: { kid: 'k1', key } }) };
  f.resetWorker();
  f.rekey = (extra = {}) => f.worker({ mode: 'rekey', source: 'SES', ...extra }, f.context);
  return f;
}

test('4.7 rekey SESは旧鍵の属性・停止・erasedを原子的に移し、旧kidを消して冪等に完了する', async () => {
  const f = rekeyFixture();
  f.ddb.set({ ...f.ddb.get('CONTACT_META', hash(f.addresses[0])), erased: true, blocked_all: true });
  f.ddb.set({ PK: 'ERASED', SK: eraseHash(f.addresses[0]) });
  const result = await f.rekey(); assert.equal(result.status, 'DONE'); assert.equal(result.saved, 2);
  assert.equal(f.ddb.get('CONTACT_META', hash(f.addresses[0])), undefined);
  const erased = f.ddb.get('CONTACT_META', nextHash(f.addresses[0])); assert.equal(erased.kid, 'k2'); assert.equal(erased.erased, true); assert.equal(erased.attributes, undefined);
  const saved = f.ddb.get('CONTACT_META', nextHash(f.addresses[1])); assert.deepEqual(saved.attributes, { name: '会員', consent }); assert.deepEqual(saved.blocked_topics, ['event']);
  assert.equal(f.ddb.get('LOCK', 'CONTACT_CREATE').owner, undefined);
  assert.deepEqual(await f.rekey(), { status: 'DONE', saved: 0, examined: 0 }); assert.equal(f.changes.length, 0);
});

test('4.7 rekeyはLambda残時間でMOREを返してカーソル・排他を保存し、次の起動で再開する', async () => {
  const f = rekeyFixture(); let writes = 0; const transact = f.deps.ddb.transactWriteItems;
  f.deps.ddb.transactWriteItems = async (input) => { const result = await transact(input); if (++writes === 1) f.setRemaining(120000); return result; };
  const first = await f.rekey(); assert.equal(first.status, 'MORE'); assert.equal(first.saved, 1);
  const state = f.ddb.get('SETTINGS', 'REKEY'); assert.equal(state.index, 1); assert.equal(state.running_until_ms, 0); assert.equal(state.complete, false);
  assert.equal(f.ddb.get('LOCK', 'CONTACT_CREATE').owner, 'rekey:k2'); assert.ok(!JSON.stringify(state).includes('@'));
  f.setRemaining(900000); f.resetWorker();
  const second = await f.rekey(); assert.equal(second.status, 'DONE'); assert.equal(second.saved, 1);
});

test('4.7 rekeyのコピー競合は旧データを残してFAILEDを返し、停止を保ったまま再開する', async () => {
  const f = rekeyFixture(1); const transact = f.deps.ddb.transactWriteItems;
  f.deps.ddb.transactWriteItems = async () => { throw Object.assign(new Error('conflict'), { name: 'TransactionCanceledException' }); };
  const first = await f.rekey(); assert.equal(first.status, 'FAILED'); assert.equal(first.code, 'STATE_CONFLICT'); assert.ok(f.ddb.get('CONTACT_META', hash(f.addresses[0]))); assert.equal(f.ddb.get('CONTACT_META', nextHash(f.addresses[0])), undefined);
  assert.equal(f.ddb.get('SETTINGS', 'REKEY').status, 'FAILED'); assert.equal(f.ddb.get('LOCK', 'CONTACT_CREATE').owner, 'rekey:k2');
  f.deps.ddb.transactWriteItems = transact;
  assert.equal((await f.rekey()).status, 'DONE');
});

test('4.7 rekeyはページ境界のNextTokenを保存して次のページから再開する', async () => {
  const f = rekeyFixture();
  f.contactPages = [{ Contacts: [f.contacts[0]], NextToken: '1' }, { Contacts: [f.contacts[1]] }];
  const transact = f.deps.ddb.transactWriteItems; let writes = 0;
  f.deps.ddb.transactWriteItems = async (input) => { const result = await transact(input); if (++writes === 1) f.setRemaining(120000); return result; };
  assert.equal((await f.rekey()).status, 'MORE'); assert.equal(f.ddb.get('SETTINGS', 'REKEY').cursor, '1');
  f.setRemaining(900000);
  assert.equal((await f.rekey()).status, 'DONE');
  assert.equal(f.listInputs.at(-1).NextToken, '1');
});

test('4.7 rekey完了保存後に排他解放が失敗しても、次の起動で解放してDONEを返す', async () => {
  const f = rekeyFixture(1); const update = f.deps.ddb.updateItem;
  f.deps.ddb.updateItem = async (input) => { if (input.Key.PK.S === 'LOCK' && input.UpdateExpression.includes('REMOVE')) throw new Error('unavailable'); return update(input); };
  const first = await f.rekey(); assert.equal(first.status, 'FAILED'); assert.equal(f.ddb.get('SETTINGS', 'REKEY').complete, true); assert.equal(f.ddb.get('LOCK', 'CONTACT_CREATE').owner, 'rekey:k2');
  f.deps.ddb.updateItem = update;
  assert.equal((await f.rekey()).status, 'DONE'); assert.equal(f.ddb.get('LOCK', 'CONTACT_CREATE').owner, undefined);
});

test('4.7 rekey途中の入力変更・並行起動は拒否し、Lambda強制終了後は15分のリース期限で再開する', async () => {
  const f = rekeyFixture(1); f.setRemaining(120000); assert.equal((await f.rekey()).status, 'MORE');
  await assert.rejects(f.rekey({ source: 'BACKUP' }), { code: 'STATE_CONFLICT' });
  const current = f.ddb.get('SETTINGS', 'REKEY'); f.ddb.set({ ...current, running_until_ms: f.deps.now() + 900000 });
  await assert.rejects(f.rekey(), { code: 'CONTACT_IMPORT_IN_PROGRESS' });
  f.advance(900000); f.setRemaining(900000);
  assert.equal((await f.rekey()).status, 'DONE');
});

test('4.7 rekeyの排他中は日次の自動補完でSESの初期属性から正本を作らない', async () => {
  const f = rekeyFixture(1); f.setRemaining(120000); assert.equal((await f.rekey()).status, 'MORE');
  f.contacts[0].AttributesData = JSON.stringify({ name: 'SESの初期値', consent });
  f.setRemaining(900000);
  const result = await f.worker({ mode: 'daily' }, f.context);
  assert.equal(result.results.backup, 'FAIL'); assert.equal(f.ddb.get('CONTACT_META', nextHash(f.addresses[0])), undefined);
  assert.equal((await f.rekey()).status, 'DONE'); assert.equal(f.ddb.get('CONTACT_META', nextHash(f.addresses[0])).attributes.name, '会員');
});

test('4.7 rekeyを別のkidへ続けて実行するときは前回の位置とバックアップハッシュをリセットする', async () => {
  const f = rekeyFixture(1); assert.equal((await f.rekey()).status, 'DONE');
  f.deps.secretsProvider = { get: async () => ({ kid: 'k3', key: '9'.repeat(64), previous: { kid: 'k2', key: nextKey } }) }; f.resetWorker();
  assert.equal((await f.rekey()).status, 'DONE');
  assert.equal(f.ddb.get('CONTACT_META', nextHash(f.addresses[0])), undefined);
  assert.equal(f.ddb.get('CONTACT_META', addressHash(f.addresses[0], '9'.repeat(64))).kid, 'k3');
});

for (const guard of ['sending', 'contact-lock', 'missing-previous', 'missing-metadata', 'kms']) test(`4.7 rekeyは前提が満たせなければ移さない ${guard}`, async () => {
  const f = rekeyFixture(1);
  if (guard === 'sending') f.settings.sending_enabled = true;
  if (guard === 'contact-lock') f.ddb.set({ PK: 'LOCK', SK: 'CONTACT_CREATE', owner: 'import:other' });
  if (guard === 'missing-previous') { f.deps.secretsProvider = { get: async () => ({ kid: 'k2', key: nextKey }) }; f.resetWorker(); }
  if (guard === 'missing-metadata') f.ddb.items.delete(`CONTACT_META/${hash(f.addresses[0])}`);
  if (guard === 'kms') f.deps.kms.generateMac = async () => { throw new Error('denied'); };
  if (['sending', 'contact-lock'].includes(guard)) await assert.rejects(f.rekey(), { code: guard === 'sending' ? 'STATE_CONFLICT' : 'CONTACT_IMPORT_IN_PROGRESS' });
  else assert.equal((await f.rekey()).status, 'FAILED');
  assert.equal(f.ddb.get('CONTACT_META', nextHash(f.addresses[0])), undefined);
});

function backup(f, rows) {
  const body = gzipSync(rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : ''));
  const sha256 = createHash('sha256').update(body).digest('hex');
  f.files.set('backups/contacts/2026-11-02.jsonl.gz', body);
  f.files.set('backups/contacts/2026-11-02.manifest.json', JSON.stringify({ complete: true, total: rows.length, sha256 }));
  f.ddb.set({ PK: 'SETTINGS', SK: 'CONTACT_BACKUP', complete: true, backed_up_at: '2026-11-02T03:00:00Z' });
}

for (const explicit of [false, true]) test(`4.7 rekey BACKUPは${explicit ? '指定日' : '最新'}の完全なバックアップの停止を引き継ぎ、KMS消去済み宛先を作らない`, async () => {
  const f = rekeyFixture();
  f.deps.secretsProvider = { get: async () => ({ kid: 'k2', key: nextKey }) }; f.resetWorker();
  backup(f, f.addresses.map((EmailAddress) => ({ EmailAddress, UnsubscribeAll: true, TopicPreferences: [{ TopicName: 'news', SubscriptionStatus: 'OPT_OUT' }], AttributesData: JSON.stringify({ name: '復元会員', consent, orig: EmailAddress }) })));
  f.ddb.set({ PK: 'ERASED', SK: eraseHash(f.addresses[0]) });
  const result = await f.rekey({ source: 'BACKUP', ...(explicit ? { backup_date: '2026-11-02' } : {}) });
  assert.equal(result.status, 'DONE'); assert.equal(f.ddb.get('CONTACT_META', nextHash(f.addresses[0])), undefined);
  const saved = f.ddb.get('CONTACT_META', nextHash(f.addresses[1])); assert.equal(saved.kid, 'k2'); assert.equal(saved.blocked_all, true); assert.deepEqual(saved.blocked_topics, ['news']); assert.equal(saved.attributes.orig, undefined);
  assert.ok([...f.ddb.items.values()].filter((item) => item.PK === 'CONTACT_META').every((item) => item.kid === 'k2'));
});

for (const cause of ['incomplete', 'hash', 'attributes', 'changed']) test(`4.7 rekey BACKUPは不完全・改変された根拠で旧項目を消さない ${cause}`, async () => {
  const f = rekeyFixture(1); backup(f, [{ EmailAddress: f.addresses[0], AttributesData: JSON.stringify({ consent }) }]);
  const manifestKey = 'backups/contacts/2026-11-02.manifest.json';
  if (cause === 'incomplete') f.files.set(manifestKey, JSON.stringify({ complete: false }));
  if (cause === 'hash') f.files.set('backups/contacts/2026-11-02.jsonl.gz', Buffer.from('broken'));
  if (cause === 'attributes') backup(f, [{ EmailAddress: f.addresses[0], HT2MetadataStatus: 'MISSING' }]);
  if (cause === 'changed') { f.setRemaining(120000); assert.equal((await f.rekey({ source: 'BACKUP' })).status, 'MORE'); backup(f, [{ EmailAddress: f.addresses[0], AttributesData: JSON.stringify({ name: 'changed' }) }]); f.setRemaining(900000); }
  const result = await f.rekey({ source: 'BACKUP' }); assert.equal(result.status, 'FAILED'); assert.ok(f.ddb.get('CONTACT_META', hash(f.addresses[0])));
});

test('4.7 rekey BACKUPの旧kid削除も500件で区切り、削除済みキーのカーソルから再開する', async () => {
  const f = rekeyFixture(0); backup(f, []);
  for (let i = 0; i < 501; i += 1) f.ddb.set({ PK: 'CONTACT_META', SK: i.toString(16).padStart(64, '0'), kid: 'k1', version: 1, attributes: {} });
  const first = await f.rekey({ source: 'BACKUP' }); assert.equal(first.status, 'MORE'); assert.equal(first.examined, 500);
  const state = f.ddb.get('SETTINGS', 'REKEY'); assert.equal(state.phase, 'CLEANUP'); assert.ok(state.cleanup_cursor);
  assert.equal([...f.ddb.items.values()].filter((item) => item.PK === 'CONTACT_META').length, 1);
  const second = await f.rekey({ source: 'BACKUP' }); assert.equal(second.status, 'DONE'); assert.equal(second.examined, 1);
  assert.equal([...f.ddb.items.values()].filter((item) => item.PK === 'CONTACT_META').length, 0);
});

test('4.7 rekeyで条件付き削除が競合しても旧項目と再開位置を保持し、リースを解放する', async () => {
  const f = rekeyFixture(0); backup(f, []);
  f.ddb.set({ PK: 'CONTACT_META', SK: 'a'.repeat(64), kid: 'k1', version: 1, attributes: {} });
  const remove = f.deps.ddb.deleteItem;
  f.deps.ddb.deleteItem = async () => { throw Object.assign(new Error('changed'), { name: 'ConditionalCheckFailedException' }); };
  const result = await f.rekey({ source: 'BACKUP' }); assert.equal(result.status, 'FAILED'); assert.equal(result.code, 'VERSION_CONFLICT');
  assert.ok(f.ddb.get('CONTACT_META', 'a'.repeat(64))); assert.equal(f.ddb.get('SETTINGS', 'REKEY').running_until_ms, 0);
  f.deps.ddb.deleteItem = remove;
  assert.equal((await f.rekey({ source: 'BACKUP' })).status, 'DONE');
});

test('4.7 rekeyのprevious設定漏れはデータを変更せず、設定を直した再実行で続行できる', async () => {
  const f = rekeyFixture(1); const provider = f.deps.secretsProvider;
  f.deps.secretsProvider = { get: async () => ({ kid: 'k2', key: nextKey }) }; f.resetWorker();
  assert.equal((await f.rekey()).code, 'CONFIGURATION_INVALID');
  f.deps.secretsProvider = provider; f.resetWorker();
  assert.equal((await f.rekey()).status, 'DONE');
});

for (const source of ['invalid', 'SES', 'BACKUP']) test(`4.7 rekeyの不正な入力を処理前に拒否 ${source}`, async () => {
  const f = rekeyFixture(1);
  await assert.rejects(f.rekey({ source, backup_date: source === 'BACKUP' ? '2026-02-30' : '2026-99-99' }), { code: 'INVALID_REQUEST' });
  assert.equal(f.ddb.get('SETTINGS', 'REKEY'), undefined);
});
