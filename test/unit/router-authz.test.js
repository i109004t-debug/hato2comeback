import test from 'node:test';
import assert from 'node:assert/strict';
import { API_ROUTES, createRouter, resolveRoute } from '../../src/common/router.js';
import { authorize, createAuthz, assertIndependentApproval, requiresEmailMask } from '../../src/common/authz.js';

const id = '01JC7Q00000000000000000000';

test('10.2 全APIをメソッドとパスで照合し、パラメーターを抽出', () => {
  for (const route of API_ROUTES) {
    const path = '/api/v1' + route.path.replace('{id}', id).replace('{importId}', id);
    const resolved = resolveRoute(route.method, path);
    assert.equal(resolved.operation, route.operation);
    assert.equal(resolved.id, route.id);
    if (route.path.includes('{id}')) assert.equal(resolved.params.id, id);
    if (route.path.includes('{importId}')) assert.equal(resolved.params.importId, id);
  }
});

test('$default相当の未定義ルート・メソッド・不正セグメントは404', () => {
  for (const [method, path] of [['GET', '/'], ['GET', '/api/v1/unknown'], ['DELETE', '/api/v1/contacts'], ['GET', '/v1/me'], ['GET', '/api/v1/me/'], ['POST', '/api/v1/campaigns//start'], ['GET', '/api/v1/contacts/a@example.com'], ['GET', '/api/v1/campaigns/a%2Fb']]) assert.throws(() => resolveRoute(method, path), { code: 'NOT_FOUND', status: 404 });
  assert.throws(() => resolveRoute('GET', '/api/v1/campaigns/%GG'), { code: 'INVALID_REQUEST' });
});

test('ルーターは選択したハンドラーだけを呼ぶ', async () => {
  const router = createRouter({ 'me.get': ({ route }) => ({ operation: route.operation }) });
  assert.deepEqual(await router.handle({ requestContext: { http: { method: 'GET' } }, rawPath: '/api/v1/me' }), { operation: 'me.get' });
  await assert.rejects(router.handle({ requestContext: { http: { method: 'GET' } }, rawPath: '/api/v1/topics' }), { code: 'NOT_FOUND' });
});

const expected = {
  viewer: ['me.get', 'settings.get', 'topics.list', 'contacts.list', 'contacts.get', 'campaigns.list', 'campaigns.get', 'campaigns.stats', 'campaigns.failures'],
  sender: ['me.get', 'settings.get', 'topics.list', 'contacts.list', 'contacts.get', 'contacts.create', 'contacts.update', 'contacts.unsubscribe', 'imports.create', 'imports.list', 'imports.get', 'campaigns.list', 'campaigns.create', 'campaigns.get', 'campaigns.update', 'campaigns.preview', 'campaigns.test-send', 'campaigns.submit', 'campaigns.start', 'campaigns.unschedule', 'campaigns.pause', 'campaigns.resume', 'campaigns.cancel', 'campaigns.stats', 'campaigns.failures'],
  approver: ['me.get', 'settings.get', 'topics.list', 'contacts.list', 'contacts.get', 'campaigns.list', 'campaigns.get', 'campaigns.preview', 'campaigns.approve', 'campaigns.reject', 'campaigns.pause', 'campaigns.resume', 'campaigns.cancel', 'campaigns.stats', 'campaigns.failures'],
};

for (const role of ['admin', 'sender', 'approver', 'viewer']) {
  test(`11.4 権限表の全API: ${role}`, () => {
    for (const { operation } of API_ROUTES) {
      const user = { sub: 'actor', roles: [role] };
      if (role === 'admin' || expected[role].includes(operation)) assert.equal(authorize(user, operation, { pause_reason: 'USER' }), user);
      else assert.throws(() => authorize(user, operation, { pause_reason: 'USER' }), { code: 'FORBIDDEN' });
    }
  });
}

test('7.6 USER以外・不明な停止理由の再開は管理者だけ、複数役割は合算', () => {
  for (const reason of ['AUTH_CHECK', 'QUOTA', 'OPERATOR_SWITCH', 'REPUTATION_ALARM', 'MONITORING_UNAVAILABLE', undefined, 'UNKNOWN']) {
    for (const role of ['sender', 'approver', 'viewer']) assert.throws(() => authorize({ roles: [role] }, 'campaigns.resume', { pause_reason: reason }), { code: 'FORBIDDEN' });
    assert.ok(authorize({ roles: ['admin'] }, 'campaigns.resume', { pause_reason: reason }));
  }
  assert.ok(authorize({ roles: ['sender', 'approver'] }, 'campaigns.approve'));
  assert.ok(authorize({ roles: ['sender', 'approver'] }, 'campaigns.create'));
  assert.throws(() => authorize({ roles: ['admin'] }, 'unknown'), { code: 'FORBIDDEN' });
  assert.equal(requiresEmailMask({ roles: ['viewer'] }), true);
  assert.equal(requiresEmailMask({ roles: ['viewer', 'sender'] }), false);
});

test('6.5 管理者であっても自己承認を拒否', () => {
  assert.throws(() => assertIndependentApproval({ sub: 'actor', roles: ['admin'] }, 'actor'), { code: 'FORBIDDEN' });
  assert.doesNotThrow(() => assertIndependentApproval({ sub: 'other', roles: ['approver'] }, 'actor'));
});

function fixture() {
  let time = 0;
  let enabled = true;
  let status = 'CONFIRMED';
  let groups = ['sender', 'viewer'];
  let gets = 0;
  let lists = 0;
  const authz = createAuthz({ userPoolId: 'pool', now: () => time, cognito: {
    adminGetUser: async (input) => {
      gets += 1;
      assert.equal(input.UserPoolId, 'pool');
      assert.equal(input.Username, 'user-sub');
      return { Enabled: enabled, UserStatus: status, UserAttributes: [{ Name: 'sub', Value: 'user-sub' }, { Name: 'name', Value: '担当者' }] };
    },
    adminListGroupsForUser: async () => { lists += 1; return { Groups: groups.map((GroupName) => ({ GroupName })) }; },
  } });
  return { authz, setTime: (value) => { time = value; }, disable: () => { enabled = false; }, setStatus: (value) => { status = value; }, setGroups: (value) => { groups = value; }, calls: () => ({ gets, lists }) };
}

test('11.3 Cognitoの現在の役割を60秒キャッシュし、無効化を期限で反映', async () => {
  const f = fixture();
  const user = await f.authz.resolveUser('user-sub');
  assert.deepEqual(user.roles, ['sender', 'viewer']);
  user.roles.push('admin');
  f.disable();
  f.setTime(59999);
  assert.deepEqual((await f.authz.resolveUser('user-sub')).roles, ['sender', 'viewer']);
  f.setTime(60000);
  await assert.rejects(f.authz.resolveUser('user-sub'), { code: 'USER_DISABLED' });
  assert.deepEqual(f.calls(), { gets: 2, lists: 1 });
});

test('11.3 未確認利用者・役割なしの拒否と役割変更の反映', async () => {
  for (const status of ['UNCONFIRMED', 'FORCE_CHANGE_PASSWORD', 'RESET_REQUIRED']) {
    const f = fixture(); f.setStatus(status);
    await assert.rejects(f.authz.resolveUser('user-sub'), { code: 'USER_DISABLED' });
  }
  const f = fixture(); f.setGroups(['other']);
  await assert.rejects(f.authz.resolveUser('user-sub'), { code: 'NO_ROLE' });
  f.setGroups(['approver']);
  assert.deepEqual((await f.authz.resolveUser('user-sub')).roles, ['approver']);
  f.setGroups(['sender']); f.setTime(60000);
  assert.deepEqual((await f.authz.resolveUser('user-sub')).roles, ['sender']);
});

test('11.3 同じ利用者の同時照会は共有し、グループの次ページも読む', async () => {
  let calls = 0;
  const authz = createAuthz({ userPoolId: 'pool', cognito: {
    adminGetUser: async () => { calls += 1; return { Enabled: true, UserStatus: 'CONFIRMED', UserAttributes: [{ Name: 'sub', Value: 'sub' }] }; },
    adminListGroupsForUser: async (input) => input.NextToken ? { Groups: [{ GroupName: 'approver' }] } : { Groups: [{ GroupName: 'sender' }], NextToken: 'next' },
  } });
  const users = await Promise.all([authz.resolveUser('sub'), authz.resolveUser('sub')]);
  assert.equal(calls, 1);
  assert.deepEqual(users[0].roles, ['sender', 'approver']);
  assert.deepEqual(users[1], users[0]);
});

test('削除済み・sub不一致・Cognito障害では認可しない', async () => {
  for (const response of [Object.assign(new Error(), { name: 'UserNotFoundException' }), { Enabled: true, UserStatus: 'CONFIRMED', UserAttributes: [{ Name: 'sub', Value: 'different' }] }]) {
    const authz = createAuthz({ userPoolId: 'pool', cognito: { adminGetUser: async () => { if (response instanceof Error) throw response; return response; } } });
    await assert.rejects(authz.resolveUser('sub'), { code: 'USER_DISABLED' });
  }
  const authz = createAuthz({ userPoolId: 'pool', cognito: { adminGetUser: async () => { throw new Error('unavailable'); } } });
  await assert.rejects(authz.resolveUser('sub'), /unavailable/);
});
