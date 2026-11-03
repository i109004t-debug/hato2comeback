import { createAuth, safeReturnTo, validateConfig } from './auth.js';
import { createApi, ApiError, errorText } from './api.js';
import { clone, element, showMessage, isMasked } from './dom.js';
import * as send from './views/send.js';
import * as contacts from './views/contacts.js';
import * as history from './views/history.js';
import * as settings from './views/settings.js';

export function parseRoute(hash) {
  const route = /^#\/(send|contacts|history|settings)(?:\/([0-9A-HJKMNP-TV-Z]{26}))?$/.exec(hash);
  if (!route || route[2] && route[1] !== 'send') return { view: 'send', id: undefined };
  return { view: route[1], id: route[2] };
}

export async function boot({ doc = document, location = window.location, historyApi = window.history, storage = window.sessionStorage, fetchFn = fetch } = {}) {
  const callbackPage = doc.body.dataset.page === 'callback';
  const search = location.search;
  if (callbackPage) historyApi.replaceState(null, '', '/callback.html');
  let auth;
  let api;
  let user;
  let activeController;
  let sequence = 0;
  let cleanups = [];
  let loginBusy = false;
  let roleTimer;

  function dispose() {
    sequence += 1;
    activeController?.abort();
    for (const dialog of doc.querySelectorAll('dialog[open]')) dialog.close('cancel');
    for (const cleanup of cleanups) cleanup();
    cleanups = [];
    clearTimeout(roleTimer);
  }

  function showLogin(message = '') {
    dispose();
    if (callbackPage) return;
    user = undefined;
    doc.getElementById('organization').textContent = '';
    doc.getElementById('identity').textContent = '';
    doc.getElementById('navigation').hidden = true;
    doc.getElementById('logout').hidden = true;
    const root = clone('login-template', doc);
    showMessage(root, message, !!message);
    root.querySelector('[data-login]').addEventListener('click', async (event) => {
      if (loginBusy) return;
      loginBusy = true; event.currentTarget.disabled = true;
      try { await auth.login(safeReturnTo(location.hash)); }
      catch { showMessage(root, 'ログインを開始できません。ブラウザーでセッションストレージとWeb Cryptoが使えることを確認してください。', true); loginBusy = false; root.querySelector('button').disabled = false; }
    });
    doc.getElementById('main').replaceChildren(root);
    doc.getElementById('main').setAttribute('aria-busy', 'false');
  }

  function header() {
    const labels = { admin: '管理者', sender: '配信担当', approver: '承認者', viewer: '閲覧者' };
    doc.getElementById('organization').textContent = user.organization_name || '配信組織の設定は管理者が行ってください';
    doc.getElementById('identity').textContent = `${user.name || 'ログイン中'} ／ ${user.roles.map((role) => labels[role]).filter(Boolean).join('・')}`;
    doc.getElementById('navigation').hidden = false;
    doc.getElementById('logout').hidden = false;
  }

  function showFailure(error) {
    dispose();
    const root = doc.getElementById('main');
    root.setAttribute('aria-busy', 'false');
    root.replaceChildren(element('p', errorText(error), 'message error'));
    const retry = element('button', '読み込み直す');
    retry.addEventListener('click', () => location.reload());
    root.append(retry);
  }

  let config;
  try {
    const response = await fetchFn('./config.json', { cache: 'no-store', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer' });
    if (!response.ok) throw new Error('CONFIGURATION_INVALID');
    config = validateConfig(await response.json(), location.origin);
    auth = createAuth({ config, storage, fetchFn, navigate: (url) => location.assign(url), replaceUrl: (url) => historyApi.replaceState(null, '', url), onExpired: () => showLogin(errorText(new ApiError('UNAUTHENTICATED'))) });
    api = createApi({ auth, fetchFn, baseUrl: config.apiBaseUrl, onUnauthenticated: () => showLogin(errorText(new ApiError('UNAUTHENTICATED'))) });
    if (callbackPage) { await auth.callback(search); return; }
  } catch (error) {
    if (callbackPage) doc.getElementById('callback-message').textContent = errorText(new ApiError(error?.message === 'UNAUTHENTICATED' ? 'UNAUTHENTICATED' : 'CONFIGURATION_INVALID'));
    else { doc.getElementById('main').replaceChildren(element('p', errorText(new ApiError('CONFIGURATION_INVALID')), 'message error')); doc.getElementById('main').setAttribute('aria-busy', 'false'); }
    return;
  }

  async function refreshUser(localApi, signal) {
    let next;
    try { next = await localApi.request('/me'); }
    catch (error) {
      if (signal.aborted) throw error;
      if (error.status === 403) { auth.clear(); showLogin(errorText(error)); }
      else if (auth.authenticated) showFailure(error);
      throw error;
    }
    const changed = user && (isMasked(user) !== isMasked(next) || [...user.roles].sort().join(',') !== [...next.roles].sort().join(','));
    user = next;
    header();
    if (changed) { void route(); throw new ApiError('FORBIDDEN', 403); }
  }

  async function route() {
    dispose();
    if (!auth.authenticated) { showLogin(); return; }
    const current = sequence;
    const controller = new AbortController();
    activeController = controller;
    const root = doc.getElementById('main');
    root.setAttribute('aria-busy', 'true');
    root.replaceChildren(element('p', '画面を読み込んでいます。'));
    const localApi = { async request(path, options = {}) {
      if (controller.signal.aborted) throw new ApiError('NETWORK');
      const result = await api.request(path, { ...options, signal: controller.signal });
      if (controller.signal.aborted) throw new ApiError('NETWORK');
      return result;
    } };
    const routeCleanups = [];
    cleanups = routeCleanups;
    const ctx = { root, api: localApi, config, get user() { return user; }, addCleanup(fn) { if (controller.signal.aborted) fn(); else routeCleanups.push(fn); }, refreshUser: () => refreshUser(localApi, controller.signal), navigate(hash) { if (!controller.signal.aborted) location.hash = safeReturnTo(hash); }, reload: () => location.reload() };
    try {
      await refreshUser(localApi, controller.signal);
      if (current !== sequence) return;
      const [org, topics] = await Promise.all([localApi.request('/settings'), localApi.request('/topics')]);
      if (current !== sequence) return;
      ctx.settings = org; ctx.topics = topics;
      const selected = parseRoute(location.hash);
      for (const link of doc.querySelectorAll('#navigation a')) {
        if (link.hash === `#/${selected.view}`) link.setAttribute('aria-current', 'page');
        else link.removeAttribute('aria-current');
      }
      doc.title = `HT2｜${{ send: '配信', contacts: '宛先', history: '配信履歴', settings: '設定' }[selected.view]}`;
      await { send, contacts, history, settings }[selected.view].mount(ctx, selected.id);
      if (current !== sequence) return;
      root.setAttribute('aria-busy', 'false');
      root.focus({ preventScroll: true });
      const checkRole = async () => {
        try { await refreshUser(localApi, controller.signal); } catch (error) { if (current === sequence) showFailure(error); }
        if (current === sequence) roleTimer = setTimeout(checkRole, 60000);
      };
      roleTimer = setTimeout(checkRole, 60000);
    } catch (error) {
      if (current !== sequence) return;
      showFailure(error);
    }
  }

  doc.getElementById('logout').addEventListener('click', async (event) => {
    event.currentTarget.disabled = true;
    dispose();
    doc.getElementById('main').replaceChildren(element('p', 'ログアウトしています。'));
    await auth.logout();
  });
  window.addEventListener('hashchange', route);
  window.addEventListener('pagehide', () => { dispose(); auth.stop(); });
  window.addEventListener('pageshow', (event) => { if (event.persisted) location.reload(); });
  await route();
}

if (typeof document !== 'undefined') void boot();
