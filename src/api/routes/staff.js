import { AppError } from '../../common/http.js';
import { listStaff, enabledAdmins } from '../../common/staff.js';
import { updateRecord, timestamp } from '../../common/records.js';

export function assertRecentAuthentication(claims, now) {
  const age = now / 1000 - Number(claims.auth_time);
  if (!Number.isFinite(age) || age < 0 || age > 900) throw new AppError('REAUTH_REQUIRED', 401, 'ログアウトしてからログインし直してください。');
}

async function list({ runtime }) {
  const items = await listStaff(runtime);
  return { items, enabled_admins: enabledAdmins(items).length };
}

async function change(ctx) {
  const { runtime, params, body, user, claims, audit, requestId } = ctx;
  assertRecentAuthentication(claims, runtime.now());
  // Cognitoの変更は再試行しない。結果不明の排他も5分で失効する。
  const previous = await runtime.store.get('LOCK', 'STAFF');
  if (previous?.owner && !(previous.expires_at_ms <= runtime.now())) throw new AppError('STATE_CONFLICT', 409, 'スタッフ変更中です。一覧で結果を確かめてください。');
  const held = await updateRecord(runtime, 'LOCK', 'STAFF', previous, { owner: requestId, acquired_at: timestamp(runtime), expires_at_ms: runtime.now() + 300000 });
  let mutated = false;
  let complete = false;
  const action = params.action ?? 'create';
  try {
    let target;
    let input;
    if (action !== 'create') {
      target = await runtime.cognito.adminGetUser({ UserPoolId: runtime.userPoolId, Username: params.username });
      const attributes = Object.fromEntries((target.UserAttributes ?? []).map(({ Name, Value }) => [Name, Value]));
      if (attributes.sub === user.sub || target.Username === user.sub || params.username === user.sub) throw new AppError('SELF_CHANGE_FORBIDDEN', 409, '自分自身は変更できません。');
      input = { UserPoolId: runtime.userPoolId, Username: params.username };
      if (['roles', 'disable'].includes(action)) {
        const items = await listStaff(runtime);
        const admins = enabledAdmins(items);
        if (admins.some((item) => item.username === params.username) && (action === 'disable' || !body.roles.includes('admin'))) {
          const remaining = admins.length - 1;
          if (remaining === 0 || remaining === 1 && body.confirm_single_admin !== true) throw new AppError('LAST_ADMIN', 409, remaining === 0 ? '有効な管理者を0人にはできません。' : '管理者が1人になります。警告を確認してください。');
        }
      }
    }
    await audit(`STAFF_${action.toUpperCase().replaceAll('-', '_')}`, target ? params.username : 'staff', { phase: 'REQUESTED', confirm_single_admin: body.confirm_single_admin === true, ...(body.roles ? { roles: body.roles } : {}) });
    mutated = true;
    if (action === 'create') {
      const response = await runtime.cognito.adminCreateUser({ UserPoolId: runtime.userPoolId, Username: body.email, UserAttributes: [{ Name: 'email', Value: body.email }, { Name: 'email_verified', Value: 'true' }, { Name: 'name', Value: body.name }], DesiredDeliveryMediums: ['EMAIL'] });
      input = { UserPoolId: runtime.userPoolId, Username: response.User?.Username };
      if (!input.Username || input.Username.includes('@')) throw new Error('Invalid created username');
      for (const role of body.roles) await runtime.cognito.adminAddUserToGroup({ ...input, GroupName: role });
    } else if (action === 'roles') {
      const current = (await listStaff(runtime)).find((item) => item.username === params.username)?.roles ?? [];
      for (const role of body.roles.filter((role) => !current.includes(role))) await runtime.cognito.adminAddUserToGroup({ ...input, GroupName: role });
      for (const role of current.filter((role) => !body.roles.includes(role))) await runtime.cognito.adminRemoveUserFromGroup({ ...input, GroupName: role });
    } else if (action === 'disable') {
      await runtime.cognito.adminDisableUser(input);
      await runtime.cognito.adminUserGlobalSignOut(input);
    } else if (action === 'enable') await runtime.cognito.adminEnableUser(input);
    else if (action === 'reset-mfa') {
      await runtime.cognito.adminSetUserMFAPreference({ ...input, SoftwareTokenMfaSettings: { Enabled: false, PreferredMfa: false } });
      await runtime.cognito.adminUserGlobalSignOut(input);
    } else if (action === 'reset-password') await runtime.cognito.adminResetUserPassword(input);
    else throw new AppError('NOT_FOUND', 404, '操作がありません。');
    await audit(`STAFF_${action.toUpperCase().replaceAll('-', '_')}`, input.Username, { phase: 'COMPLETED' });
    complete = true;
    runtime.authz.clear();
    return { status: 'DONE', username: input.Username };
  } catch (error) {
    if (mutated) {
      await audit(`STAFF_${action.toUpperCase().replaceAll('-', '_')}`, params.username ?? 'staff', { phase: 'UNKNOWN' });
      throw new AppError('INTERNAL', 500, 'スタッフの変更を確定できません。一覧で結果を確かめてください。');
    }
    throw error;
  } finally {
    try {
      if (!mutated || complete) await updateRecord(runtime, 'LOCK', 'STAFF', held, {}, ['owner', 'acquired_at', 'expires_at_ms']);
    } finally {
      if (mutated) {
        runtime.authz.clear();
        await runtime.notify('STAFF_CHANGED', 'staff');
      }
    }
  }
}

export default { 'staff.list': list, 'staff.create': change, 'staff.change': change };
