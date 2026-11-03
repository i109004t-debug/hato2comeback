import { ROLES } from './authz.js';

export async function listStaff(runtime) {
  const users = new Map();
  for (const role of ROLES) {
    let token;
    const seen = new Set();
    do {
      const page = await runtime.cognito.listUsersInGroup({ UserPoolId: runtime.userPoolId, GroupName: role, ...(token ? { NextToken: token } : {}) });
      if (!Array.isArray(page.Users)) throw new Error('Invalid staff response');
      for (const item of page.Users) {
        const attributes = Object.fromEntries((item.Attributes ?? []).map(({ Name, Value }) => [Name, Value]));
        if (!item.Username || item.Username.includes('@')) throw new Error('Unsafe staff username');
        const user = users.get(item.Username) ?? { username: item.Username, sub: attributes.sub, email: attributes.email ?? '', name: attributes.name ?? '', status: item.UserStatus, enabled: item.Enabled === true, roles: [] };
        if (!user.roles.includes(role)) user.roles.push(role);
        users.set(item.Username, user);
      }
      token = page.NextToken;
      if (token && seen.has(token)) throw new Error('Repeated staff cursor');
      if (token) seen.add(token);
    } while (token);
  }
  return [...users.values()];
}

export const enabledAdmins = (items) => items.filter((item) => item.enabled && item.status === 'CONFIRMED' && item.roles.includes('admin'));
