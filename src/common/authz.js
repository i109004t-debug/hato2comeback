import { AppError } from './http.js';
import { now as defaultNow } from './time.js';

export const ROLES = Object.freeze(['admin', 'sender', 'approver', 'viewer']);
const all = ROLES;
const senders = ['admin', 'sender'];
const approvers = ['admin', 'approver'];
const operators = ['admin', 'sender', 'approver'];

export const PERMISSIONS = Object.freeze(Object.fromEntries([
  [all, ['me.get', 'settings.get', 'topics.list', 'contacts.list', 'contacts.get', 'campaigns.list', 'campaigns.get', 'campaigns.stats', 'campaigns.failures']],
  [senders, ['contacts.create', 'contacts.update', 'contacts.unsubscribe', 'imports.create', 'imports.list', 'imports.get', 'campaigns.create', 'campaigns.update', 'campaigns.test-send', 'campaigns.submit', 'campaigns.start', 'campaigns.unschedule']],
  [approvers, ['campaigns.approve', 'campaigns.reject']],
  [operators, ['campaigns.preview', 'campaigns.pause', 'campaigns.cancel', 'campaigns.resume']],
  [['admin'], ['settings.update', 'settings.delivery-check', 'contacts.reconsent', 'contacts.erase', 'campaigns.review', 'campaigns.unknowns', 'audit.list']],
].flatMap(([roles, operations]) => operations.map((operation) => [operation, Object.freeze([...roles])]))));

export function authorize(user, operation, { pause_reason } = {}) {
  const allowed = operation === 'campaigns.resume' && pause_reason !== 'USER' ? ['admin'] : PERMISSIONS[operation];
  if (!PERMISSIONS[operation] || !user?.roles?.some((role) => allowed.includes(role))) throw new AppError('FORBIDDEN', 403, 'この操作の権限がありません。');
  return user;
}

export function assertIndependentApproval(user, submittedBy) {
  authorize(user, 'campaigns.approve');
  if (!submittedBy || user.sub === submittedBy) throw new AppError('FORBIDDEN', 403, '申請者とは別の利用者が承認してください。');
}

export function requiresEmailMask(user) {
  return !user?.roles?.some((role) => ['admin', 'sender', 'approver'].includes(role));
}

export function createAuthz({ cognito, userPoolId, now = defaultNow }) {
  const cache = new Map();
  const pending = new Map();
  const resolveUser = async (sub) => {
    if (typeof sub !== 'string' || !sub) throw new AppError('UNAUTHENTICATED', 401, '再ログインしてください。');
    const hit = cache.get(sub);
    if (hit && now() < hit.expires) return structuredClone(hit.value);
    if (pending.has(sub)) return structuredClone(await pending.get(sub));
    const started = now();
    const load = (async () => {
      let user;
      try { user = await cognito.adminGetUser({ UserPoolId: userPoolId, Username: sub }); } catch (error) {
        if (error.name !== 'UserNotFoundException') throw error;
        throw new AppError('USER_DISABLED', 403, '利用者が無効です。');
      }
      if (user.Enabled !== true || user.UserStatus !== 'CONFIRMED') throw new AppError('USER_DISABLED', 403, '利用者が無効です。');
      const attributes = Object.fromEntries((user.UserAttributes ?? []).map(({ Name, Value }) => [Name, Value]));
      if (attributes.sub !== sub) throw new AppError('USER_DISABLED', 403, '利用者を確認できません。');
      const groups = [];
      let token;
      const seen = new Set();
      do {
        const page = await cognito.adminListGroupsForUser({ UserPoolId: userPoolId, Username: sub, ...(token ? { NextToken: token } : {}) });
        groups.push(...(page.Groups ?? []).map((group) => group.GroupName));
        token = page.NextToken;
        if (token && seen.has(token)) throw new Error('Repeated Cognito cursor');
        seen.add(token);
      } while (token);
      const roles = ROLES.filter((role) => groups.includes(role));
      if (!roles.length) throw new AppError('NO_ROLE', 403, '役割が設定されていません。');
      const value = { sub, name: attributes.name ?? '', roles };
      cache.set(sub, { value, expires: started + 60000 });
      return value;
    })();
    pending.set(sub, load);
    try { return structuredClone(await load); } finally { pending.delete(sub); }
  };
  return { resolveUser, authorize, clear: () => cache.clear() };
}
