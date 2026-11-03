import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, validateCsvHeader, validateImportCsv, writeSesImport, validateImportRequest } from '../../src/common/csv.js';

const header = 'email,name,consent_at,consent_source,consent_version,topics';
const options = { topics: ['kaiho', 'event'], importId: '01JC7Q00000000000000000000', now: () => Date.parse('2026-11-03T00:00:00Z') };
const line = 'member@example.jp,山田,2026-10-01T09:00:00+09:00,入会フォーム,2026-04,kaiho';

test('5.3 CSV: BOM、CRLF、引用符内の改行・カンマ・二重引用符', () => {
  assert.deepEqual(parseCsv('\uFEFFa,b\r\n"one,two","three\r\nfour"\r\n"say ""hello""",\r\n'), [['a', 'b'], ['one,two', 'three\r\nfour'], ['say "hello"', '']]);
  assert.deepEqual(parseCsv('a,"b\nc"'), [['a', 'b\nc']]);
  assert.deepEqual(parseCsv('a,b,'), [['a', 'b', '']]);
  assert.deepEqual(parseCsv(''), []);
  assert.deepEqual(parseCsv('""'), [['']]);
});

test('5.3 不正な引用符・文字コード・単独CRを拒否', () => {
  for (const value of ['a,"unclosed', 'a,b"c', 'a,"b"x', 'a\rb']) assert.throws(() => parseCsv(value), { code: 'INVALID_REQUEST' });
  assert.throws(() => parseCsv(Uint8Array.of(0xff)), { code: 'INVALID_REQUEST' });
});

test('5.3 未知列、重複列、必須列の欠落、列数の不一致', () => {
  for (const value of [['email', 'unknown'], ['email', 'email', 'consent_at', 'consent_source', 'topics'], ['email', 'topics'], undefined]) assert.throws(() => validateCsvHeader(value), { code: 'INVALID_REQUEST' });
  assert.deepEqual(validateCsvHeader(['topics', 'email', 'consent_source', 'consent_at']), ['topics', 'email', 'consent_source', 'consent_at']);
  assert.throws(() => validateImportCsv(`${header}\n${line},extra`, options), (error) => error.fieldErrors[0].code === 'COLUMN_COUNT');
});

test('5.3 2MiB・20,000行の境界', () => {
  const exact = 'a'.repeat(2 * 1024 * 1024);
  assert.equal(parseCsv(exact)[0][0].length, exact.length);
  assert.throws(() => parseCsv(exact + 'a'), { code: 'PAYLOAD_TOO_LARGE' });
  assert.equal(parseCsv(`email\n${'a\n'.repeat(20000)}`).length, 20001);
  assert.throws(() => parseCsv(`email\n${'a\n'.repeat(20001)}`), { code: 'PAYLOAD_TOO_LARGE' });
});

test('5.4 正規化・orig保持・Gmail重複・行番号だけの拒否結果', () => {
  const csv = `${header}\nA.B+fc@googlemail.com,山田,2026-10-01T00:00:00Z,入会,,kaiho;event\nab@gmail.com,山田,2026-10-01T00:00:00Z,入会,,kaiho\nbad@example.com,山田,2027-01-01T00:00:00Z,入会,,kaiho\na..b@example.com,山田,2026-10-01T00:00:00Z,入会,,kaiho`;
  const result = validateImportCsv(csv, options);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].row, 2);
  assert.equal(result.rows[0].email, 'ab@gmail.com');
  assert.equal(result.rows[0].attributes.orig, 'A.B+fc@googlemail.com');
  assert.deepEqual(result.rejected, [{ row: 3, code: 'DUPLICATE_IN_FILE' }, { row: 4, code: 'INVALID_REQUEST' }, { row: 5, code: 'NONSTANDARD_ADDRESS' }]);
  assert.ok(!JSON.stringify(result.rejected).includes('@'));
});

test('5.4 行の名前・同意・トピック・1KB属性制限', () => {
  for (const modified of [line.replace('山田', 'あ'.repeat(51)), line.replace('山田', '"山\n田"'), line.replace('入会フォーム', ''), line.replace('kaiho', 'missing'), line.replace('kaiho', 'kaiho;kaiho')]) {
    assert.equal(validateImportCsv(`${header}\n${modified}`, options).rejected.length, 1);
  }
  const name = '😀'.repeat(50);
  const source = '😀'.repeat(100);
  const version = '😀'.repeat(30);
  const oversized = `${header}\n${'a'.repeat(64)}@${'b'.repeat(63)}.com,${name},2026-10-01T00:00:00Z,${source},${version},kaiho`;
  // originなども合計に含め、境界は実際のJSONバイト数で検査する。
  assert.equal(validateImportCsv(oversized, { ...options, importId: 'a'.repeat(300) }).rejected.length, 1);
});

test('5.4.8 SES形式: JSONのエスケープと全トピックのOPT_IN/OPT_OUT', () => {
  const csv = `${header}\nmember@example.jp,"山田,""太郎""",2026-10-01T00:00:00Z,入会,,kaiho`;
  const result = validateImportCsv(csv, options);
  const output = writeSesImport(result.rows, options.topics);
  const parsed = output.trimEnd().split('\n').map(JSON.parse);
  assert.equal(parsed.length, 1);
  assert.deepEqual(parsed[0].topicPreferences, [{ topicName: 'kaiho', subscriptionStatus: 'OPT_IN' }, { topicName: 'event', subscriptionStatus: 'OPT_OUT' }]);
  assert.equal(parsed[0].unsubscribeAll, false);
  assert.equal(parsed[0].emailAddress, 'member@example.jp');
  assert.deepEqual(JSON.parse(parsed[0].attributesData), result.rows[0].attributes);
  assert.throws(() => writeSesImport([{ ...result.rows[0], topics: ['unknown'] }], options.topics));
});

test('API-11 CSVのContent-TypeとIdempotency-Keyを検査', () => {
  const event = { headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Idempotency-Key': 'import_123' }, body: `${header}\n${line}` };
  assert.equal(validateImportRequest(event).idempotencyKey, 'import_123');
  assert.throws(() => validateImportRequest({ ...event, headers: { 'Content-Type': 'text/csv' } }));
  assert.throws(() => validateImportRequest({ ...event, headers: { ...event.headers, 'Content-Type': 'application/json' } }));
});
