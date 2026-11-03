import test from 'node:test';
import assert from 'node:assert/strict';
import { validateSubject, validateBody, validateSettings, validateRoute, validateConsent, validateParams, validateQuery, bodyWarnings, routeSchemas, isIsoDateTime } from '../../src/common/validate.js';
import { createFooter, UNSUBSCRIBE_PLACEHOLDER } from '../../src/common/footer.js';
import { API_ROUTES } from '../../src/common/router.js';

const now = () => Date.parse('2026-11-03T00:00:00Z');
const context = { now, topics: ['kaiho', 'event'], senderDomain: 'example.jp' };
const legal = { sender_name: '会報事務局', address: '東京都千代田区', contact: 'support@example.jp' };
const settings = () => ({ version: 3, from_local: 'info', from_name: 'ファンクラブ', legal: { ...legal } });
const consent = { at: '2026-10-01T09:00:00+09:00', source: '入会フォーム' };

test('6.3 件名は1〜200文字・制御文字とテンプレート構文を拒否', () => {
  assert.equal(validateSubject('😀'.repeat(200)), '😀'.repeat(200));
  for (const value of ['', 'a'.repeat(201), 'a\n', 'a\r', 'a\t', 'a\x7f', 'a\u2028', 'a\u2029', '{{x', 'x}}', '\ud800']) assert.throws(() => validateSubject(value), { code: 'INVALID_REQUEST' });
});

test('6.3 本文のUTF-8サイズ50KiB境界・改行正規化・警告', () => {
  assert.equal(Buffer.byteLength(validateBody('あ'.repeat(17066) + 'ab')), 51200);
  assert.throws(() => validateBody('あ'.repeat(17067)), { code: 'PAYLOAD_TOO_LARGE', status: 413 });
  assert.equal(validateBody('a\r\nb\rc\n'), 'a\nb\nc\n');
  assert.equal(validateBody(''), '');
  assert.throws(() => validateBody('{{x}}'), { code: 'INVALID_REQUEST' });
  assert.deepEqual(bodyWarnings('https://bit.ly/abcd'), ['SHORT_URL']);
  assert.deepEqual(bodyWarnings('https://example.com/'), []);
});

test('4.3 組織設定の既定値、差出人・法定表示・送信先の検証', () => {
  const result = validateSettings(settings(), context);
  assert.equal(result.approval_required, true);
  assert.equal(result.max_rate_per_sec, 10);
  assert.deepEqual(result.test_recipients, []);
  for (const name of ['a\n', 'a\t', 'a<', 'a>', 'a"', '{{x', 'x}}', '', 'a'.repeat(65)]) assert.throws(() => validateSettings({ ...settings(), from_name: name }, context));
  for (const field of ['sender_name', 'address', 'contact']) {
    for (const value of ['', ' ', '{{x', 'x}}', 'x\n']) assert.throws(() => validateSettings({ ...settings(), legal: { ...legal, [field]: value } }, context));
  }
  for (const contact of ['https://example.jp/contact', '03-1234-5678', '+81 (3) 1234 5678']) assert.equal(validateSettings({ ...settings(), legal: { ...legal, contact } }, context).legal.contact, contact);
  assert.throws(() => validateSettings({ ...settings(), legal: { ...legal, contact: '連絡先なし' } }, context));
  for (const value of [0, -1, Infinity, '10']) assert.throws(() => validateSettings({ ...settings(), max_rate_per_sec: value }, context));
  assert.throws(() => validateSettings({ ...settings(), test_recipients: Array(6).fill('a@example.com') }, context));
  assert.throws(() => validateSettings({ ...settings(), test_recipients: ['a.b@gmail.com', 'ab@googlemail.com'] }, context));
  assert.throws(() => validateSettings({ ...settings(), from_local: ' info' }, context));
  assert.throws(() => validateSettings({ ...settings(), reply_to: 'a\n@example.com' }, context));
  assert.throws(() => validateSettings({ ...settings(), reply_to: 'a{{b@example.com' }, context));
  assert.throws(() => validateSettings({ ...settings(), from_local: 'a{{b' }, context));
  assert.throws(() => validateSettings({ ...settings(), version: undefined }, context));
});

test('15.2 ルート・入れ子の未知項目をfield_errorsで拒否し、受入記録の偽装を拒否', () => {
  for (const operation of Object.keys(routeSchemas).filter((key) => key !== 'imports.create')) {
    assert.throws(() => validateRoute(operation, { unknown: true }, context), (error) => error.fieldErrors.some((item) => item.code === 'UNKNOWN_FIELD'));
  }
  assert.throws(() => validateSettings({ ...settings(), delivery_check: { status: 'PASS' } }, context), { code: 'INVALID_REQUEST' });
  assert.throws(() => validateSettings({ ...settings(), legal: { ...legal, extra: true } }, context), (error) => error.fieldErrors.some((item) => item.field === 'legal.$unknown'));
  assert.ok(API_ROUTES.every((route) => Object.hasOwn(routeSchemas, route.operation)));
});

test('10.3 宛先の作成・更新・再同意のスキーマ', () => {
  const value = validateRoute('contacts.create', { email: 'A.B@gmail.com', consent, topics: ['kaiho'] }, context);
  assert.equal(value.email, 'ab@gmail.com');
  assert.equal(value.orig, 'A.B@gmail.com');
  assert.throws(() => validateRoute('contacts.create', { email: 'a@example.com', consent, topics: ['missing'] }, context));
  assert.throws(() => validateRoute('contacts.create', { email: 'a@example.com', consent, topics: ['kaiho', 'kaiho'] }, context));
  assert.throws(() => validateRoute('contacts.update', { email: 'a@example.com' }, context));
  assert.equal(validateRoute('contacts.update', { email: 'a@example.com', name: '' }, context).name, '');
  assert.throws(() => validateRoute('contacts.update', { email: 'a@example.com', topics: { kaiho: 'OTHER' } }, context));
  assert.equal(validateRoute('contacts.unsubscribe', { email: 'a@example.com', scope: 'ALL' }, context).scope, 'ALL');
  assert.throws(() => validateRoute('contacts.unsubscribe', { email: 'a@example.com', scope: 'missing' }, context));
  assert.throws(() => validateRoute('contacts.reconsent', { email: 'a@example.com', topics: ['kaiho'], reconsent: consent }, context));
  assert.throws(() => validateConsent({ ...consent, source: 'a'.repeat(101) }, context));
  assert.throws(() => validateConsent({ ...consent, version: 'a'.repeat(31) }, context));
});

test('3.5 同意日時の暦日・タイムゾーン・未来の拒否', () => {
  for (const value of ['2026-02-29T00:00:00Z', '2026-13-01T00:00:00Z', '2026-01-00T00:00:00Z', '2026-01-01', '2026-01-01T24:00:00Z', '2026-01-01T00:00:60Z', '2026-01-01T00:00:00+24:00']) assert.equal(isIsoDateTime(value), false);
  assert.ok(isIsoDateTime('2024-02-29T12:34:56.123+09:00'));
  assert.throws(() => validateConsent({ ...consent, at: '2027-01-01T00:00:00Z' }, context));
});

test('7.1 予約は5分後〜90日後、NOWにatを含めない', () => {
  assert.deepEqual(validateRoute('campaigns.start', { mode: 'NOW' }, context), { mode: 'NOW' });
  for (const delta of [300000, 90 * 86400000]) assert.ok(validateRoute('campaigns.start', { mode: 'SCHEDULED', at: new Date(now() + delta).toISOString() }, context));
  for (const delta of [299999, 90 * 86400000 + 1]) assert.throws(() => validateRoute('campaigns.start', { mode: 'SCHEDULED', at: new Date(now() + delta).toISOString() }, context));
  assert.throws(() => validateRoute('campaigns.start', { mode: 'NOW', at: '2026-12-01T00:00:00Z' }, context));
});

test('10.2 配信の本文スキーマとパラメーター・ページング', () => {
  assert.equal(validateRoute('campaigns.create', { topic: 'kaiho', subject: '会報', body_text: 'a\r\nb' }, context).body_text, 'a\nb');
  assert.throws(() => validateRoute('campaigns.update', { version: 1 }, context));
  assert.throws(() => validateRoute('campaigns.test-send', { recipients: ['a@example.com'] }, context));
  assert.throws(() => validateRoute('campaigns.approve', { content_sha256: '0'.repeat(12) }, context));
  assert.ok(validateRoute('campaigns.approve', { content_sha256: '0'.repeat(64), max_recipients: 1000, send_by: '2026-11-10T10:00:00Z' }, context));
  assert.throws(() => validateRoute('campaigns.review', { decision: 'OTHER', note: '確認' }, context));
  assert.ok(validateParams({ id: '01JC7Q00000000000000000000' }));
  assert.throws(() => validateParams({ id: 'invalid' }));
  assert.deepEqual(validateQuery('contacts.list', { limit: '50', topic: 'kaiho' }), { limit: 50, topic: 'kaiho' });
  assert.deepEqual(validateQuery('campaigns.list'), { limit: 50 });
  for (const limit of ['0', '51', '2.5', '-1', '01']) assert.throws(() => validateQuery('contacts.list', { limit }));
  assert.throws(() => validateQuery('contacts.get', { email: 'a@example.com' }));
  assert.throws(() => validateQuery('audit.list', { month: '202613' }));
  assert.ok(validateQuery('audit.list', { month: '202611' }));
});

test('API-26〜29 受入検査の入力を検証し、旧手入力方式は拒否する', () => {
  const input = { passed: true, note: '確認済み', evidence_key: 'delivery-checks/id/result.json', cases: { 'T-30': 'PASS' }, config_hash: 'a'.repeat(64), dns_config_hash: 'b'.repeat(64) };
  assert.throws(() => validateRoute('delivery-check.start', input));
  assert.deepEqual(validateRoute('delivery-check.start', {}), {});
  assert.deepEqual(validateRoute('delivery-check.case', { result: 'PASS', note: '確認済み' }), { result: 'PASS', note: '確認済み' });
  assert.throws(() => validateRoute('delivery-check.case', { result: true, note: '確認済み' }));
  assert.deepEqual(validateRoute('delivery-check.submit', { note: '確認済み' }), { note: '確認済み' });
});

test('6.7 フッターに法定表示と解除URLがちょうど1つ', () => {
  const footer = createFooter({ legal }, '会報');
  for (const text of Object.values(legal)) assert.ok(footer.includes(text));
  assert.equal(footer.split(UNSUBSCRIBE_PLACEHOLDER).length - 1, 1);
  assert.match(footer, /^\n----\n/);
  assert.match(footer, /配信停止・配信設定の変更/);
  for (const field of Object.keys(legal)) {
    for (const value of ['{{x', 'x}}', '', 'x\n']) assert.throws(() => createFooter({ legal: { ...legal, [field]: value } }, '会報'), { code: 'SETTINGS_INCOMPLETE' });
  }
  assert.throws(() => createFooter({ legal }, '{{amazonSESUnsubscribeUrl}}'), { code: 'SETTINGS_INCOMPLETE' });
});
