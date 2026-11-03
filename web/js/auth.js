const SESSION_KEY = 'ht2_session';
const PKCE_KEY = 'ht2_pkce';

export function base64url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

export async function pkceChallenge(verifier, cryptoApi = globalThis.crypto) {
  return base64url(new Uint8Array(await cryptoApi.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
}

export async function createPkce(cryptoApi = globalThis.crypto) {
  const verifier = base64url(cryptoApi.getRandomValues(new Uint8Array(32)));
  return { verifier, challenge: await pkceChallenge(verifier, cryptoApi), state: base64url(cryptoApi.getRandomValues(new Uint8Array(16))) };
}

export function safeReturnTo(value) {
  return typeof value === 'string' && /^#\/(?:send(?:\/[0-9A-HJKMNP-TV-Z]{26})?|contacts|history|settings)$/.test(value) ? value : '#/send';
}

export function validateConfig(input, origin) {
  if (!input || !/^[a-z0-9]+$/i.test(input.clientId ?? '')) throw new Error('CONFIGURATION_INVALID');
  const auth = new URL(input.authDomain);
  if (auth.protocol !== 'https:' || auth.username || auth.password || auth.pathname !== '/' || auth.search || auth.hash) throw new Error('CONFIGURATION_INVALID');
  const redirect = new URL(input.redirectUri);
  const logout = new URL(input.logoutUri);
  if (redirect.origin !== origin || redirect.username || redirect.password || redirect.pathname !== '/callback.html' || redirect.search || redirect.hash || logout.origin !== origin || logout.username || logout.password || logout.pathname !== '/' || logout.search || logout.hash || new URL(origin).protocol !== 'https:') throw new Error('CONFIGURATION_INVALID');
  if (input.apiBaseUrl !== '/api/v1' || !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i.test(input.senderDomain ?? '')) throw new Error('CONFIGURATION_INVALID');
  return { ...input, authDomain: auth.origin };
}

export function createAuth({ config, storage, fetchFn = fetch, cryptoApi = globalThis.crypto, now = Date.now, navigate, replaceUrl, setTimer = setTimeout, clearTimer = clearTimeout, onExpired = () => {} }) {
  let session = null;
  let pendingRefresh;
  let timer;
  let generation = 0;
  try {
    const saved = JSON.parse(storage.getItem(SESSION_KEY));
    if (saved && typeof saved.access_token === 'string' && saved.access_token && typeof saved.refresh_token === 'string' && saved.refresh_token && Number.isFinite(saved.expires_at)) session = saved;
    else storage.removeItem(SESSION_KEY);
  } catch { storage.removeItem(SESSION_KEY); }

  function clear() {
    generation += 1;
    session = null;
    clearTimer(timer);
    storage.removeItem(SESSION_KEY);
    storage.removeItem(PKCE_KEY);
  }

  function schedule() {
    clearTimer(timer);
    if (session) timer = setTimer(() => { refresh().catch(() => onExpired()); }, Math.max(0, session.expires_at - now() - 60000));
  }

  async function tokenRequest(fields) {
    const response = await fetchFn(`${config.authDomain}/oauth2/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: config.clientId, ...fields }), cache: 'no-store', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error('UNAUTHENTICATED');
    return response.json();
  }

  function save(tokens, previousRefresh, started) {
    if (typeof tokens.access_token !== 'string' || !tokens.access_token || !Number.isFinite(tokens.expires_in) || tokens.expires_in <= 60 || tokens.token_type?.toLowerCase() !== 'bearer') throw new Error('UNAUTHENTICATED');
    const refreshToken = tokens.refresh_token || previousRefresh;
    if (typeof refreshToken !== 'string' || !refreshToken) throw new Error('UNAUTHENTICATED');
    session = { access_token: tokens.access_token, refresh_token: refreshToken, expires_at: started + tokens.expires_in * 1000 };
    storage.setItem(SESSION_KEY, JSON.stringify(session));
    schedule();
  }

  async function login(returnTo = '#/send') {
    clear();
    const pkce = await createPkce(cryptoApi);
    storage.setItem(PKCE_KEY, JSON.stringify({ verifier: pkce.verifier, state: pkce.state, returnTo: safeReturnTo(returnTo), createdAt: now() }));
    const url = new URL('/oauth2/authorize', config.authDomain);
    url.search = new URLSearchParams({ response_type: 'code', client_id: config.clientId, redirect_uri: config.redirectUri, scope: 'openid email profile', state: pkce.state, code_challenge: pkce.challenge, code_challenge_method: 'S256' });
    navigate(url.href);
  }

  async function callback(search) {
    const params = new URLSearchParams(search);
    let saved;
    try { saved = JSON.parse(storage.getItem(PKCE_KEY)); } catch { /* 不正な保存値は拒否する。 */ }
    clear();
    replaceUrl('/callback.html');
    if (!saved || params.getAll('state').length !== 1 || params.get('state') !== saved.state || !/^[A-Za-z0-9_-]{22}$/.test(saved.state) || !/^[A-Za-z0-9_-]{43}$/.test(saved.verifier) || params.getAll('code').length !== 1 || !params.get('code') || params.has('error') || !Number.isFinite(saved.createdAt) || now() < saved.createdAt || now() - saved.createdAt > 600000) throw new Error('UNAUTHENTICATED');
    const started = now();
    const epoch = generation;
    try {
      const tokens = await tokenRequest({ grant_type: 'authorization_code', code: params.get('code'), redirect_uri: config.redirectUri, code_verifier: saved.verifier });
      if (epoch !== generation) throw new Error('UNAUTHENTICATED');
      save(tokens, undefined, started);
      navigate(`/index.html${safeReturnTo(saved.returnTo)}`);
    } catch { clear(); throw new Error('UNAUTHENTICATED'); }
  }

  function refresh() {
    if (pendingRefresh) return pendingRefresh;
    if (!session?.refresh_token) return Promise.reject(new Error('UNAUTHENTICATED'));
    const epoch = generation;
    const previous = session.refresh_token;
    const started = now();
    pendingRefresh = (async () => {
      try {
        const tokens = await tokenRequest({ grant_type: 'refresh_token', refresh_token: previous });
        if (epoch !== generation) throw new Error('UNAUTHENTICATED');
        save(tokens, previous, started);
        return session.access_token;
      } catch {
        if (epoch === generation) clear();
        throw new Error('UNAUTHENTICATED');
      } finally { pendingRefresh = undefined; }
    })();
    return pendingRefresh;
  }

  async function accessToken() {
    if (!session) throw new Error('UNAUTHENTICATED');
    if (now() >= session.expires_at - 60000) return refresh();
    return session.access_token;
  }

  async function logout() {
    const token = session?.refresh_token;
    clear();
    try {
      if (token) await fetchFn(`${config.authDomain}/oauth2/revoke`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: config.clientId, token }), cache: 'no-store', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(10000) });
    } catch { /* 通信失敗時もタブ内のトークンは破棄してログアウトへ進む。 */ }
    const url = new URL('/logout', config.authDomain);
    url.search = new URLSearchParams({ client_id: config.clientId, logout_uri: config.logoutUri });
    navigate(url.href);
  }

  schedule();
  return { login, callback, refresh, accessToken, logout, clear, stop: () => clearTimer(timer), get authenticated() { return !!session; } };
}
