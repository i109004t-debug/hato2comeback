import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { AppError, ERROR_STATUS, jsonResponse, errorResponse, parseJsonBody, readBody, assertOrigin, accessClaims, assertRequestUrl } from '../../src/common/http.js';
import { createLogger, redact, addr8, addressHash } from '../../src/common/log.js';
import { createAuditItem, createAudit } from '../../src/common/audit.js';
import { createMetrics, METRIC_UNITS } from '../../src/common/metrics.js';
import { unmarshall } from '../../src/common/ddb.js';

test('10.1 JSON応答・Cache-Controlと10.4の全エラーコード', () => {
  const response = jsonResponse(201, { ok: true });
  assert.equal(response.statusCode, 201);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.deepEqual(JSON.parse(response.body), { ok: true });
  for (const [code, status] of Object.entries(ERROR_STATUS)) {
    const fields = [{ field: 'subject', code: 'INVALID' }];
    const error = new AppError(code, status, '入力を確認してください。', fields);
    const response = errorResponse(error, 'request');
    assert.equal(response.statusCode, status);
    assert.equal(JSON.parse(response.body).error_code, code);
    assert.deepEqual(JSON.parse(response.body).field_errors, fields);
  }
});

test('15.2 想定外エラーは500 INTERNAL、スタックはログだけ、機密情報を伏せる', () => {
  const lines = [];
  const logger = createLogger({ fn: 'api', req_id: 'r', write: (line) => lines.push(line) });
  const response = errorResponse(new Error('member@example.com https://example.com/unsub?token=secret'), 'request', logger);
  assert.equal(response.statusCode, 500);
  assert.equal(JSON.parse(response.body).error_code, 'INTERNAL');
  assert.ok(!response.body.includes('stack'));
  assert.equal(lines.length, 1);
  assert.ok(JSON.parse(lines[0]).err.stack);
  assert.ok(!lines[0].includes('member@example.com'));
  const business = errorResponse(new AppError('INVALID_REQUEST', 400, 'member@example.com token=private https://example.com/unsub'), 'r');
  assert.ok(!business.body.includes('member@example.com'));
  assert.ok(!business.body.includes('token=private'));
  assert.ok(!business.body.includes('https://'));
});

test('HTTP本文はJSONオブジェクト・Content-Type・Base64・UTF-8・サイズを検査', () => {
  const event = { headers: { 'Content-Type': 'application/json; charset=UTF-8' }, body: '{"subject":"会報"}' };
  assert.deepEqual(parseJsonBody(event), { subject: '会報' });
  assert.deepEqual(parseJsonBody({ ...event, body: Buffer.from(event.body).toString('base64'), isBase64Encoded: true }), { subject: '会報' });
  assert.deepEqual(parseJsonBody({}), {});
  for (const body of ['[]', 'null', '3', '{bad', '']) assert.throws(() => parseJsonBody({ ...event, body }), { code: 'INVALID_REQUEST' });
  assert.throws(() => parseJsonBody({ ...event, headers: { 'content-type': 'text/plain' } }), { code: 'INVALID_REQUEST' });
  assert.throws(() => readBody({ body: '%%%', isBase64Encoded: true }), { code: 'INVALID_REQUEST' });
  assert.throws(() => readBody({ body: '/w==', isBase64Encoded: true }), { code: 'INVALID_REQUEST' });
  assert.throws(() => readBody({ body: 'ああ' }, 5), { code: 'PAYLOAD_TOO_LARGE' });
});

test('12.3 オリジン検証は新旧の値だけ受理し、空の値を拒否', () => {
  for (const value of ['current', 'previous']) assert.doesNotThrow(() => assertOrigin({ headers: { 'X-Origin-Verify': value } }, { current: 'current', previous: 'previous' }));
  for (const value of [undefined, '', 'bad', 'current-and-more']) assert.throws(() => assertOrigin({ headers: { 'x-origin-verify': value } }, { current: 'current', previous: '' }), { code: 'FORBIDDEN_ORIGIN' });
  assert.throws(() => assertOrigin({}), { code: 'FORBIDDEN_ORIGIN' });
});

test('11.2 API Gateway確認済みaccessトークンのclient_id・subを確認', () => {
  const event = (claims) => ({ requestContext: { authorizer: { jwt: { claims } } } });
  assert.deepEqual(accessClaims(event({ token_use: 'access', client_id: 'client', sub: 'actor', 'cognito:groups': ['admin'] }), 'client'), { sub: 'actor' });
  for (const claims of [{ token_use: 'id', client_id: 'client', sub: 'actor' }, { token_use: 'access', client_id: 'other', sub: 'actor' }, {}]) assert.throws(() => accessClaims(event(claims), 'client'), { code: 'UNAUTHENTICATED' });
});

test('10.1 宛先アドレスをURL・クエリに含めない、HTTPSを確認', () => {
  for (const event of [{ rawPath: '/api/v1/contacts/a%40example.com' }, { rawQueryString: 'email=a%40example.com' }, { queryStringParameters: { email: 'a@example.com' } }, { rawPath: '/api/v1/%GG' }, { headers: { 'x-forwarded-proto': 'http' } }]) assert.throws(() => assertRequestUrl(event), { code: 'INVALID_REQUEST' });
  assert.doesNotThrow(() => assertRequestUrl({ rawPath: '/api/v1/contacts', rawQueryString: 'topic=kaiho&limit=50', headers: { 'x-forwarded-proto': 'https' } }));
});

test('13.1 ログは1行JSON・必須項目・入れ子の機密キー・例外本文を伏せる', () => {
  const lines = [];
  const logger = createLogger({ fn: 'worker', req_id: 'request', now: () => 0, write: (line) => lines.push(line) });
  logger.info('send member@example.com https://example.com/unsubscribe?token=raw', {
    campaign_id: 'campaign', email: 'member@example.com', subject: '非公開の件名', body: '非公開本文', token: 'opaque-token', authorization: 'Bearer abc',
    nested: { ToAddresses: ['member@example.com'], AttributesData: '{"orig":"member@example.com"}', task_token: 'task-token', headers: { Authorization: 'Bearer abc' } },
    err: new Error('SES returned member@example.com'),
  });
  assert.equal(lines.length, 1);
  assert.equal(lines[0].split('\n').length, 2);
  assert.ok(lines[0].endsWith('\n'));
  const entry = JSON.parse(lines[0]);
  assert.equal(entry.ts, '1970-01-01T00:00:00.000Z');
  assert.equal(entry.level, 'info');
  assert.equal(entry.fn, 'worker');
  assert.equal(entry.req_id, 'request');
  assert.equal(entry.campaign_id, 'campaign');
  for (const value of ['member@example.com', '非公開の件名', '非公開本文', 'opaque-token', 'task-token', 'https://']) assert.ok(!lines[0].includes(value));
  assert.equal(entry.nested.ToAddresses, '[REDACTED]');
  const circular = {}; circular.self = circular;
  assert.equal(redact(circular).self, '[CIRCULAR]');
  assert.equal(redact({ msg: 'Bearer rawtoken' }).msg, 'Bearer [REDACTED]');
  assert.ok(!redact({ msg: '{"task_token":"opaque-secret"}' }).msg.includes('opaque-secret'));
});

test('13.1 addr8は正規化済みアドレスのHMAC先頭8文字', () => {
  assert.equal(addr8('a@example.com', 'key').length, 8);
  assert.equal(addr8('a@example.com', 'key'), addressHash('a@example.com', 'key').slice(0, 8));
  assert.notEqual(addr8('a@example.com', 'key'), addr8('a@example.com', 'other'));
  assert.throws(() => addr8('a@example.com', ''));
});

test('4.3 監査キーはUTC月・ISO8601#ULID、1年TTL・addr8・条件付き作成', async () => {
  const time = Date.parse('2026-10-31T15:00:00Z');
  const deps = { now: () => time, id: () => '01JC7Q00000000000000000000', hmacKey: 'key' };
  const entry = { actor_sub: 'actor', action: 'CONTACT_CREATE', target: 'contact', result: 'OK', request_id: 'request', email: 'A.B+fc@googlemail.com', details: { attributes: { name: '会員', consent: { at: '2026-10-01T00:00:00Z', source: '入会フォーム' }, orig: 'A.B+fc@googlemail.com' } } };
  const item = createAuditItem(entry, deps);
  assert.equal(item.PK, 'AUDIT#202610');
  assert.equal(item.SK, '2026-10-31T15:00:00.000Z#01JC7Q00000000000000000000');
  assert.equal(item.expires_at, time / 1000 + 365 * 86400);
  assert.equal(item.addr8, addr8('ab@gmail.com', 'key'));
  assert.ok(!JSON.stringify(item).includes('@'));
  assert.equal(item.details.attributes.consent.source, '入会フォーム');
  let input;
  const audit = createAudit({ ...deps, tableName: 'table', ddb: { putItem: async (value) => { input = value; } } });
  await audit.write(entry);
  assert.equal(input.ConditionExpression, 'attribute_not_exists(PK)');
  assert.deepEqual(unmarshall(input.Item), item);
});

test('13.2 全アプリメトリクスをEMFで出力し、機密情報を次元に入れない', () => {
  const lines = [];
  const metrics = createMetrics({ env: 'prod', now: () => 1000, write: (line) => lines.push(line) });
  assert.deepEqual(Object.keys(METRIC_UNITS).sort(), 'Accepted Failed Unknown Throttled Paused NeedsReview StartFailed PrepareRecipients PrepareSeconds SesBusy ImportRows ImportSkipped ImportRejected ApiError4xx ApiError5xx ApiLatencyMs SesSendingEnabled SesMax24HourSend SesSentLast24Hours SesMaxSendRate'.split(' ').sort());
  assert.equal(METRIC_UNITS.PrepareSeconds, 'Seconds');
  assert.equal(METRIC_UNITS.ApiLatencyMs, 'Milliseconds');
  for (const name of Object.keys(METRIC_UNITS)) {
    const dimensions = name === 'Paused' ? { Reason: 'USER' } : name.startsWith('Api') ? { Route: 'API-01' } : {};
    const entry = metrics.emit(name, 1, dimensions);
    assert.equal(entry._aws.Timestamp, 1000);
    assert.equal(entry._aws.CloudWatchMetrics[0].Namespace, 'Postline/prod');
    assert.equal(entry._aws.CloudWatchMetrics[0].Metrics[0].Unit, METRIC_UNITS[name]);
    assert.equal(entry[name], 1);
  }
  assert.equal(lines.length, Object.keys(METRIC_UNITS).length);
  for (const line of lines) {
    assert.ok(line.endsWith('\n'));
    assert.ok(Object.hasOwn(JSON.parse(line), '_aws'));
  }
  assert.throws(() => metrics.emit('UnknownMetric', 1));
  assert.throws(() => metrics.emit('Accepted', NaN));
  assert.throws(() => metrics.emit('Paused', 1, { Reason: 'member@example.com' }));
  assert.throws(() => metrics.emit('ApiLatencyMs', 1, { Route: '/contacts/member@example.com' }));
  assert.throws(() => metrics.emit('Accepted', 1, { email: 'member@example.com' }));
});

test('13.1〜13.2 既定出力はconsoleのJSON包絡を通さずstdoutへ1行ずつ書く', () => {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { createMetrics } from ${JSON.stringify(new URL('../../src/common/metrics.js', import.meta.url).href)};
    import { createLogger } from ${JSON.stringify(new URL('../../src/common/log.js', import.meta.url).href)};
    console.log = () => { throw new Error('console.log must not be used'); };
    createMetrics({ env: 'dev', now: () => 0 }).emit('NeedsReview');
    createLogger({ fn: 'api', now: () => 0 }).info('member@example.com');
  `], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout.trimEnd().split('\n').map((line) => JSON.parse(line));
  assert.equal(lines.length, 2);
  assert.equal(lines[0]._aws.CloudWatchMetrics[0].Namespace, 'Postline/dev');
  assert.equal(lines[0].message, undefined);
  assert.equal(lines[1].level, 'info');
  assert.equal(lines[1].msg, '[REDACTED_EMAIL]');
});
