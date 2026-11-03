import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { base64url, pkceChallenge, createPkce, safeReturnTo, validateConfig, createAuth } from '../../web/js/auth.js';

const origin = 'https://app.example.jp';
const config = { authDomain: 'https://ht2.auth.ap-northeast-1.amazoncognito.com', clientId: 'example123', redirectUri: `${origin}/callback.html`, logoutUri: `${origin}/`, apiBaseUrl: '/api/v1', senderDomain: 'fc.example.jp' };
const now = 1793664000000;
const tokens = (extra = {}) => ({ access_token: 'access', refresh_token: 'refresh', expires_in: 900, token_type: 'Bearer', ...extra });

function fixture(options = {}) {
  const values = new Map(Object.entries(options.values ?? {}));
  const storage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key) };
  const calls = [];
  const navigations = [];
  const replacements = [];
  const timers = [];
  const cleared = [];
  let expired = 0;
  const auth = createAuth({ config, storage, cryptoApi: webcrypto, now: () => now, navigate: (url) => navigations.push(url), replaceUrl: (url) => replacements.push(url), fetchFn: async (...args) => {
    calls.push(args);
    return options.fetchFn ? options.fetchFn(...args) : { ok: true, json: async () => tokens() };
  }, setTimer: (fn, delay) => { timers.push({ fn, delay }); return timers.length; }, clearTimer: (id) => cleared.push(id), onExpired: () => expired++, ...options.deps });
  return { auth, values, calls, navigations, replacements, timers, cleared, get expired() { return expired; } };
}

const sessionValue = (extra = {}) => JSON.stringify({ access_token: 'old-access', refresh_token: 'old-refresh', expires_at: now + 900000, ...extra });
const pendingValue = (extra = {}) => JSON.stringify({ verifier: 'v'.repeat(43), state: 's'.repeat(22), returnTo: '#/history', createdAt: now, ...extra });

test('9.5 PKCE: RFC 7636のS256既知ベクトルとBase64URL', async () => {
  assert.equal(await pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk', webcrypto), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  assert.equal(base64url(new Uint8Array([251, 255, 255])), '-___');
});

test('9.5 PKCE: 32/16バイトの暗号乱数からURL安全な値を作る', async () => {
  const lengths = [];
  const cryptoApi = { subtle: webcrypto.subtle, getRandomValues(bytes) { lengths.push(bytes.length); return bytes.fill(bytes.length); } };
  const result = await createPkce(cryptoApi);
  assert.deepEqual(lengths, [32, 16]);
  assert.match(result.verifier, /^[A-Za-z0-9_-]{43}$/);
  assert.match(result.state, /^[A-Za-z0-9_-]{22}$/);
  assert.equal(result.challenge, await pkceChallenge(result.verifier, webcrypto));
  assert.notEqual((await createPkce()).state, (await createPkce()).state);
});

test('9.1・9.5 戻り先は既知の画面のハッシュに限定する', () => {
  for (const value of ['#/send', '#/contacts', '#/settings', '#/history', '#/send/01JAZ6Y0N00000000000000001']) assert.equal(safeReturnTo(value), value);
  for (const value of ['https://evil.example', '//evil.example', '#/send/../settings', '#/contacts/member@example.jp', '#/send?x=1', undefined]) assert.equal(safeReturnTo(value), '#/send');
});

test('12.2・12.3 公開設定はHTTPS、同一オリジンの戻り先とAPIだけを許可する', () => {
  assert.equal(validateConfig(config, origin).authDomain, config.authDomain);
  for (const change of [{ apiBaseUrl: 'https://evil.example/api/v1' }, { redirectUri: 'https://evil.example/callback.html' }, { logoutUri: 'https://evil.example/' }, { authDomain: 'http://auth.example.jp' }, { authDomain: 'https://user:pass@auth.example.jp' }, { authDomain: 'https://auth.example.jp/token' }, { senderDomain: '' }, { clientId: 'bad&client' }]) assert.throws(() => validateConfig({ ...config, ...change }, origin));
});

test('9.5 login: verifier/state/戻り先だけをセッションに保存しS256認可へ移動', async () => {
  const f = fixture();
  await f.auth.login('#/settings');
  const saved = JSON.parse(f.values.get('ht2_pkce'));
  assert.equal(saved.returnTo, '#/settings');
  const url = new URL(f.navigations[0]);
  assert.equal(url.origin, config.authDomain);
  assert.equal(url.pathname, '/oauth2/authorize');
  assert.equal(url.searchParams.get('state'), saved.state);
  assert.equal(url.searchParams.get('code_challenge'), await pkceChallenge(saved.verifier));
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('scope'), 'openid email profile');
  assert.equal(url.searchParams.has('code_verifier'), false);
  assert.equal(f.calls.length, 0);
});

test('9.5 callback: state不一致・重複・期限切れ・欠落ではトークン交換せず消去', async () => {
  for (const [pending, query] of [
    [pendingValue(), '?code=secret&state=wrong'],
    [pendingValue(), `?code=secret&state=${'s'.repeat(22)}&state=duplicate`],
    [pendingValue(), `?code=secret&code=other&state=${'s'.repeat(22)}`],
    [pendingValue({ createdAt: now - 600001 }), `?code=secret&state=${'s'.repeat(22)}`],
    [pendingValue({ createdAt: now + 1 }), `?code=secret&state=${'s'.repeat(22)}`],
    ['broken', '?code=secret&state=wrong'],
    [pendingValue(), `?error=access_denied&state=${'s'.repeat(22)}`],
  ]) {
    const f = fixture({ values: { ht2_pkce: pending } });
    await assert.rejects(f.auth.callback(query), /UNAUTHENTICATED/);
    assert.equal(f.calls.length, 0);
    assert.equal(f.values.has('ht2_pkce'), false);
    assert.equal(f.values.has('ht2_session'), false);
    assert.deepEqual(f.replacements, ['/callback.html']);
  }
});

test('9.5 callback: コード交換、クエリ除去、ht2_session保存、指定画面へ戻る', async () => {
  const f = fixture({ values: { ht2_pkce: pendingValue() } });
  await f.auth.callback(`?code=one-use-code&state=${'s'.repeat(22)}`);
  const [url, init] = f.calls[0];
  assert.equal(url, `${config.authDomain}/oauth2/token`);
  assert.equal(init.body.get('code_verifier'), 'v'.repeat(43));
  assert.equal(init.body.get('grant_type'), 'authorization_code');
  assert.equal(init.body.get('code'), 'one-use-code');
  assert.equal(init.redirect, 'error');
  assert.equal(f.values.has('ht2_pkce'), false);
  assert.deepEqual(JSON.parse(f.values.get('ht2_session')), { access_token: 'access', refresh_token: 'refresh', expires_at: now + 900000 });
  assert.deepEqual(f.navigations, ['/index.html#/history']);
  assert.equal(await f.auth.accessToken(), 'access');
  assert.equal(f.timers.at(-1).delay, 840000);
});

test('9.5 callbackのトークン応答に不足があればログインを成立させない', async () => {
  for (const result of [tokens({ access_token: '' }), tokens({ expires_in: 30 }), tokens({ token_type: 'Other' }), tokens({ refresh_token: '' })]) {
    const f = fixture({ values: { ht2_pkce: pendingValue() }, fetchFn: async () => ({ ok: true, json: async () => result }) });
    await assert.rejects(f.auth.callback(`?code=code&state=${'s'.repeat(22)}`), /UNAUTHENTICATED/);
    assert.equal(f.values.has('ht2_session'), false);
  }
});

test('9.5 refresh: メモリと保存値を更新しローテーションを反映', async () => {
  const f = fixture({ values: { ht2_session: sessionValue({ expires_at: now + 60000 }) }, fetchFn: async () => ({ ok: true, json: async () => tokens({ refresh_token: 'rotated' }) }) });
  assert.equal(await f.auth.accessToken(), 'access');
  assert.equal(f.calls[0][1].body.get('grant_type'), 'refresh_token');
  assert.equal(f.calls[0][1].body.get('refresh_token'), 'old-refresh');
  assert.equal(JSON.parse(f.values.get('ht2_session')).refresh_token, 'rotated');
  assert.equal(f.timers.at(-1).delay, 840000);
});

test('9.5 refresh: 新しいリフレッシュトークンがなければ従来の値を保つ', async () => {
  const f = fixture({ values: { ht2_session: sessionValue() }, fetchFn: async () => ({ ok: true, json: async () => tokens({ refresh_token: undefined }) }) });
  await f.auth.refresh();
  assert.equal(JSON.parse(f.values.get('ht2_session')).refresh_token, 'old-refresh');
});

test('9.5 同時更新は1つにまとめ、ローテーション済みトークンを重複使用しない', async () => {
  let resolve;
  const f = fixture({ values: { ht2_session: sessionValue() }, fetchFn: () => new Promise((done) => { resolve = done; }) });
  const first = f.auth.refresh();
  const second = f.auth.refresh();
  assert.equal(f.calls.length, 1);
  resolve({ ok: true, json: async () => tokens() });
  assert.deepEqual(await Promise.all([first, second]), ['access', 'access']);
});

test('9.5 期限60秒前のタイマーから更新し、失敗したら保存値を消して再ログインへ', async () => {
  const f = fixture({ values: { ht2_session: sessionValue() }, fetchFn: async () => ({ ok: false }) });
  assert.equal(f.timers[0].delay, 840000);
  f.timers[0].fn();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.expired, 1);
  assert.equal(f.auth.authenticated, false);
  assert.equal(f.values.has('ht2_session'), false);
});

test('9.5 logout: revoke後にCognito logout、保存値は通信失敗時にも消去', async () => {
  for (const fail of [false, true]) {
    const f = fixture({ values: { ht2_session: sessionValue() }, fetchFn: async () => { if (fail) throw new Error('network secret'); return { ok: true }; } });
    await f.auth.logout();
    assert.equal(f.calls[0][0], `${config.authDomain}/oauth2/revoke`);
    assert.equal(f.calls[0][1].body.get('token'), 'old-refresh');
    assert.equal(f.values.has('ht2_session'), false);
    const url = new URL(f.navigations[0]);
    assert.equal(url.pathname, '/logout');
    assert.equal(url.searchParams.get('logout_uri'), config.logoutUri);
  }
});

test('9.5 logout中に更新応答が届いてもセッションを復活させない', async () => {
  let finish;
  const f = fixture({ values: { ht2_session: sessionValue() }, fetchFn: async (url) => url.endsWith('/token') ? new Promise((resolve) => { finish = resolve; }) : { ok: true } });
  const pending = f.auth.refresh();
  await f.auth.logout();
  finish({ ok: true, json: async () => tokens() });
  await assert.rejects(pending, /UNAUTHENTICATED/);
  assert.equal(f.values.has('ht2_session'), false);
});

test('9.5 ページ移動時はタイマーだけを止め、PKCEとセッションを引き継ぐ', async () => {
  const f = fixture({ values: { ht2_session: sessionValue(), ht2_pkce: pendingValue() } });
  f.auth.stop();
  assert.ok(f.values.has('ht2_session'));
  assert.ok(f.values.has('ht2_pkce'));
  assert.ok(f.cleared.includes(1));
});

test('9.5 壊れた保存値と未ログイン状態を安全に扱う', async () => {
  for (const saved of ['{broken', 'null', '{}', sessionValue({ expires_at: 'invalid' })]) {
    const f = fixture({ values: { ht2_session: saved } });
    assert.equal(f.auth.authenticated, false);
    await assert.rejects(f.auth.accessToken(), /UNAUTHENTICATED/);
    assert.equal(f.calls.length, 0);
  }
});
