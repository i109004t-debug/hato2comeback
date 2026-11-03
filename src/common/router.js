import { AppError, invalid } from './http.js';

export const API_ROUTES = Object.freeze([
  ['API-01', 'GET', '/me', 'me.get'],
  ['API-02', 'GET', '/settings', 'settings.get'], ['API-02', 'PUT', '/settings', 'settings.update'],
  ['API-03', 'GET', '/topics', 'topics.list'],
  ['API-04', 'GET', '/contacts', 'contacts.list'], ['API-05', 'POST', '/contacts/get', 'contacts.get'],
  ['API-06', 'POST', '/contacts', 'contacts.create'], ['API-07', 'POST', '/contacts/update', 'contacts.update'],
  ['API-08', 'POST', '/contacts/unsubscribe', 'contacts.unsubscribe'], ['API-09', 'POST', '/contacts/reconsent', 'contacts.reconsent'],
  ['API-10', 'POST', '/contacts/erase', 'contacts.erase'], ['API-11', 'POST', '/imports', 'imports.create'],
  ['API-12', 'GET', '/imports', 'imports.list'], ['API-12', 'GET', '/imports/{importId}', 'imports.get'],
  ['API-13', 'GET', '/campaigns', 'campaigns.list'], ['API-13', 'POST', '/campaigns', 'campaigns.create'],
  ['API-14', 'GET', '/campaigns/{id}', 'campaigns.get'], ['API-14', 'PATCH', '/campaigns/{id}', 'campaigns.update'],
  ...[['API-15', 'preview'], ['API-16', 'test-send'], ['API-17', 'submit'], ['API-18', 'approve'], ['API-18', 'reject'], ['API-19', 'start'], ['API-20', 'unschedule'], ['API-21', 'pause'], ['API-21', 'resume'], ['API-21', 'cancel'], ['API-22', 'review']].map(([id, action]) => [id, 'POST', `/campaigns/{id}/${action}`, `campaigns.${action}`]),
  ['API-23', 'GET', '/campaigns/{id}/stats', 'campaigns.stats'], ['API-24', 'GET', '/campaigns/{id}/failures', 'campaigns.failures'],
  ['API-25', 'GET', '/audit', 'audit.list'], ['API-26', 'POST', '/settings/delivery-check', 'settings.delivery-check'],
].map(([id, method, path, operation]) => Object.freeze({ id, method, path, operation })));

export function resolveRoute(method, path, { prefix = '/api/v1' } = {}) {
  if (typeof path !== 'string' || !path.startsWith(`${prefix}/`) || /[?#]/.test(path)) throw new AppError('NOT_FOUND', 404, '対象がありません。');
  const parts = path.slice(prefix.length).split('/');
  for (const route of API_ROUTES) {
    const expected = route.path.split('/');
    if (method !== route.method || parts.length !== expected.length) continue;
    const params = {};
    let match = true;
    for (let i = 0; i < parts.length; i += 1) {
      if (expected[i].startsWith('{')) {
        let value;
        try { value = decodeURIComponent(parts[i]); } catch { throw invalid('path', 'ENCODING'); }
        if (!value || /[/\\@\p{Cc}]/u.test(value)) { match = false; break; }
        params[expected[i].slice(1, -1)] = value;
      } else if (expected[i] !== parts[i]) { match = false; break; }
    }
    if (match) return { ...route, params };
  }
  throw new AppError('NOT_FOUND', 404, '対象がありません。');
}

export function createRouter(handlers = {}, options = {}) {
  return {
    resolve: (method, path) => resolveRoute(method, path, options),
    async handle(event, context) {
      const route = resolveRoute(event.requestContext?.http?.method, event.rawPath, options);
      if (typeof handlers[route.operation] !== 'function') throw new AppError('NOT_FOUND', 404, '対象がありません。');
      return handlers[route.operation]({ event, context, route, params: route.params });
    },
  };
}
