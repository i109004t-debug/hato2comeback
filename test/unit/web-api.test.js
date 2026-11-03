import test from 'node:test';
import assert from 'node:assert/strict';
import { ApiError, ERROR_MESSAGES, convertError, errorText, isUncertainMutation, apiPath, createApi } from '../../web/js/api.js';

const id = '01JAZ6Y0N00000000000000001';
const response = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });
function fixture(fetchFn, authOverrides = {}) {
  const counts = { refresh: 0, clear: 0, expired: 0 };
  const calls = [];
  const auth = { accessToken: async () => 'access', refresh: async () => { counts.refresh++; return 'new-access'; }, clear: () => counts.clear++, ...authOverrides };
  const api = createApi({ auth, onUnauthenticated: () => counts.expired++, fetchFn: async (...args) => { calls.push(args); return fetchFn(...args); } });
  return { api, calls, counts };
}

test('10.4 全エラーコードを利用者向けの日本語へ変換する', () => {
  const codes = ['INVALID_REQUEST', 'UNAUTHENTICATED', 'FORBIDDEN', 'FORBIDDEN_ORIGIN', 'USER_DISABLED', 'NO_ROLE', 'NOT_FOUND', 'STATE_CONFLICT', 'VERSION_CONFLICT', 'HASH_MISMATCH', 'CONTACT_EXISTS', 'ERASED_ADDRESS', 'RECONSENT_REQUIRED', 'ALREADY_STARTED', 'SENDING_IN_PROGRESS', 'CONTACT_IMPORT_IN_PROGRESS', 'PAYLOAD_TOO_LARGE', 'SETTINGS_INCOMPLETE', 'INVALID_ADDRESS', 'NONSTANDARD_ADDRESS', 'QUOTA_INSUFFICIENT', 'TEST_RECIPIENT_NOT_REGISTERED', 'RECIPIENT_NOT_ALLOWED_IN_ENV', 'DELIVERY_CHECK_REQUIRED', 'SES_BUSY', 'SES_PAUSED', 'SENDING_DISABLED', 'REPUTATION_ALARM', 'AUTH_CHECK_FAILED', 'EVENT_DESTINATION_DISABLED', 'EVENT_LOG_STALE', 'MONITORING_UNAVAILABLE', 'SUPPRESSION_MISCONFIGURED', 'CONFIGURATION_INVALID', 'INTERNAL'];
  for (const code of codes) {
    const error = convertError({ error_code: code, request_id: 'request-123', message: 'private@example.jp' }, 409);
    assert.equal(error.code, code);
    assert.equal(error.message, ERROR_MESSAGES[code]);
    assert.match(errorText(error), /問い合わせ番号：request-123/);
    assert.doesNotMatch(errorText(error), /private@example/);
  }
  assert.match(ERROR_MESSAGES.HASH_MISMATCH, /読み込み直し/);
  assert.match(ERROR_MESSAGES.QUOTA_INSUFFICIENT, /24時間/);
});

test('10.4 不明なコード・サーバーの自由文・不正な項目名を反射しない', () => {
  const error = convertError({ error_code: 'token=secret', message: 'private@example.jp', request_id: 'private@example.jp', field_errors: [{ field: 'private@example.jp', code: 'secret' }, { field: 'consent.source', code: 'REQUIRED' }, { field: 'test_recipients[0]', code: 'secret' }] }, 500);
  assert.equal(error.code, 'INTERNAL');
  assert.deepEqual(error.fields, ['同意の記録', 'テスト送信先']);
  assert.doesNotMatch(errorText(error), /secret|private|@/);
  assert.doesNotMatch(errorText(new Error('raw-token')), /raw-token/);
  assert.equal(new ApiError('__proto__').message, ERROR_MESSAGES.INTERNAL);
  assert.deepEqual(convertError({ field_errors: [{ field: 42 }, { field: '__proto__' }] }, 400).fields, []);
});

test('10.1 アドレスをURLに含めず、既知のAPI経路とクエリに限定', () => {
  assert.equal(apiPath(`/campaigns/${id}/failures`, { limit: 50, cursor: 'abc_123-' }), `/campaigns/${id}/failures?limit=50&cursor=abc_123-`);
  assert.equal(apiPath('/contacts', { topic: 'kaiho', status: '', cursor: null }), '/contacts?topic=kaiho');
  for (const path of ['https://evil.example', '//evil.example', '/contacts/member@example.jp', '/campaigns/../settings', '/settings?email=member@example.jp']) assert.throws(() => apiPath(path), ApiError);
  assert.throws(() => apiPath('/contacts', { email: 'member@example.jp' }), ApiError);
  assert.throws(() => apiPath('/contacts', { cursor: 'member@example.jp' }), ApiError);
  assert.throws(() => createApi({ auth: {}, baseUrl: 'https://evil.example' }), ApiError);
});

test('9.5・10.1 JSON本文とアクセストークンを送り、キャッシュ・資格情報・転送を抑止', async () => {
  const f = fixture(async () => response(200, { ok: true }));
  await f.api.request('/contacts/get', { method: 'POST', body: { email: 'member@example.jp' } });
  const [url, init] = f.calls[0];
  assert.equal(url, '/api/v1/contacts/get');
  assert.equal(init.headers.Authorization, 'Bearer access');
  assert.equal(init.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(init.body), { email: 'member@example.jp' });
  assert.equal(init.cache, 'no-store');
  assert.equal(init.credentials, 'omit');
  assert.equal(init.redirect, 'error');
  assert.equal(init.referrerPolicy, 'no-referrer');
});

test('API-11 CSVを専用Content-Typeと同じIdempotency-Keyで送る', async () => {
  const f = fixture(async () => response(202, { import_id: id }));
  const csv = 'email,name\nmember@example.jp,会員\n';
  await f.api.request('/imports', { method: 'POST', csv, idempotencyKey: 'key-123' });
  assert.equal(f.calls[0][1].body, csv);
  assert.equal(f.calls[0][1].headers['Content-Type'], 'text/csv; charset=utf-8');
  assert.equal(f.calls[0][1].headers['Idempotency-Key'], 'key-123');
  await assert.rejects(f.api.request('/imports', { method: 'POST', csv, idempotencyKey: 'bad\r\nheader' }), ApiError);
  assert.equal(f.calls.length, 1);
});

test('9.5 401だけ一度更新して同じ本文で再要求する', async () => {
  let attempt = 0;
  const f = fixture(async () => ++attempt === 1 ? response(401, { message: 'Unauthorized' }) : response(200, { status: 'QUEUED' }));
  const value = await f.api.request(`/campaigns/${id}/start`, { method: 'POST', body: { mode: 'NOW' } });
  assert.equal(value.status, 'QUEUED');
  assert.equal(f.counts.refresh, 1);
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1][1].headers.Authorization, 'Bearer new-access');
  assert.equal(f.calls[0][1].body, f.calls[1][1].body);
});

test('11.6 REAUTH_REQUIREDでは要求もトークン更新も繰り返さず、ログアウトからログインへ進む', async () => {
  let logouts = 0;
  const f = fixture(async () => response(401, { error_code: 'REAUTH_REQUIRED' }), { logout: async () => { logouts += 1; } });
  await assert.rejects(f.api.request('/staff/other-admin/disable', { method: 'POST', body: {} }), { code: 'REAUTH_REQUIRED', status: 401 });
  assert.equal(f.calls.length, 1); assert.equal(f.counts.refresh, 0); assert.equal(logouts, 1);
});

test('第11段階 API-26〜35は既知のパスと内部識別子だけを許す', () => {
  for (const path of ['/readiness', '/staff', '/staff/uuid-123/reset-mfa', '/contacts/events', `/settings/delivery-check/${id}/cases/T-25`, `/settings/delivery-check/${id}/evidence`, `/settings/delivery-check/${id}/submit`, `/imports/${id}/confirm`, `/imports/${id}/discard`]) assert.equal(apiPath(path), path);
  assert.equal(apiPath('/imports', { mode: 'UPDATE_EXISTING' }), '/imports?mode=UPDATE_EXISTING');
  for (const path of ['/staff/member@example.com/disable', '/staff/uuid-123/delete', '/staff/uuid-123/roles/extra', `/settings/delivery-check/${id}/cases/anything`, `/imports/${id}/replay`]) assert.throws(() => apiPath(path));
});

test('9.5 二度目の401で保存値を破棄し再ログインへ進む', async () => {
  const f = fixture(async () => response(401, {}));
  await assert.rejects(f.api.request('/me'), (error) => error.code === 'UNAUTHENTICATED');
  assert.equal(f.calls.length, 2);
  assert.equal(f.counts.refresh, 1);
  assert.equal(f.counts.clear, 1);
  assert.equal(f.counts.expired, 1);
});

test('9.5 更新に失敗したときAPIを繰り返さず再ログインへ進む', async () => {
  const f = fixture(async () => response(401, {}), { refresh: async () => { throw new Error('UNAUTHENTICATED'); } });
  await assert.rejects(f.api.request('/me'), (error) => error.code === 'UNAUTHENTICATED');
  assert.equal(f.calls.length, 1);
  assert.equal(f.counts.expired, 1);
});

test('送信・取込・状態変更はネットワーク障害や5xxで自動再要求しない', async () => {
  for (const path of [`/campaigns/${id}/start`, `/campaigns/${id}/test-send`, `/campaigns/${id}/review`, '/imports']) {
    for (const failure of ['network', 503, 500]) {
      const f = fixture(async () => { if (failure === 'network') throw new Error('address@example.jp'); return response(failure, { error_code: failure === 503 ? 'SES_BUSY' : 'INTERNAL', request_id: 'r-1' }); });
      await assert.rejects(f.api.request(path, { method: 'POST', body: {} }), (error) => error instanceof ApiError && !errorText(error).includes('address@example.jp'));
      assert.equal(f.calls.length, 1);
      assert.equal(f.counts.refresh, 0);
    }
  }
});

test('10.4 403・409・422は更新・再送をせず、項目と問い合わせ番号を表示', async () => {
  for (const [status, code] of [[403, 'FORBIDDEN'], [409, 'VERSION_CONFLICT'], [422, 'DELIVERY_CHECK_REQUIRED']]) {
    const f = fixture(async () => response(status, { error_code: code, field_errors: [{ field: 'subject', code: 'INVALID' }], request_id: 'request_1' }));
    await assert.rejects(f.api.request('/settings'), (error) => error.code === code && /件名/.test(errorText(error)) && /request_1/.test(errorText(error)));
    assert.equal(f.calls.length, 1);
  }
});

test('不正なJSON応答の内容を表示しない', async () => {
  const f = fixture(async () => ({ status: 502, ok: false, json: async () => { throw new Error('private@example.jp'); } }));
  await assert.rejects(f.api.request('/me'), (error) => error.code === 'INTERNAL' && !errorText(error).includes('@'));
  assert.equal(f.calls.length, 1);
});

test('不正な成功応答も結果不明として状態変更ボタンを止める', async () => {
  const f = fixture(async () => ({ status: 200, ok: true, json: async () => { throw new Error('invalid'); } }));
  await assert.rejects(f.api.request(`/campaigns/${id}/start`, { method: 'POST', body: { mode: 'NOW' } }), (error) => isUncertainMutation(error));
  assert.equal(isUncertainMutation(new Error('rendering failed')), true);
  assert.equal(isUncertainMutation(new ApiError('NETWORK')), true);
  assert.equal(isUncertainMutation(new ApiError('VERSION_CONFLICT', 409)), false);
  assert.equal(isUncertainMutation(new ApiError('INVALID_REQUEST', 400)), false);
});

test('再認証後の401がJSONでなくてもトークンを破棄する', async () => {
  const f = fixture(async () => ({ status: 401, ok: false, json: async () => { throw new Error('not json'); } }));
  await assert.rejects(f.api.request('/me'), (error) => error.code === 'UNAUTHENTICATED');
  assert.equal(f.calls.length, 2);
  assert.equal(f.counts.expired, 1);
});
