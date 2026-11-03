import { ApiError, errorText, isUncertainMutation } from '../api.js';
import { clone, element, tableRows, showMessage, hasRole, createActionGate, confirmDialog } from '../dom.js';

export const ROLE_LABELS = Object.freeze({ admin: '管理者', sender: '配信担当', approver: '承認者', viewer: '閲覧者' });

export async function mount(ctx) {
  if (!hasRole(ctx.user, 'admin')) throw new ApiError('FORBIDDEN', 403);
  const root = clone('staff-template');
  ctx.root.replaceChildren(root);
  const gate = createActionGate();
  let uncertain = false;
  function permissions() {
    for (const control of root.querySelectorAll('button, input, select')) control.disabled = gate.busy || uncertain || control.dataset.self === 'true';
  }
  async function perform(fn, mutation = false) {
    return gate.run(async () => {
      permissions(); showMessage(root, '');
      try { await fn(); } catch (error) { if (mutation && isUncertainMutation(error)) uncertain = true; showMessage(root, errorText(error), true); }
    }).finally(permissions);
  }
  async function load() {
    const response = await ctx.api.request('/staff');
    root.querySelector('[data-admin-warning]').textContent = response.enabled_admins < 2 ? '有効な管理者が1人以下です。管理者を2人以上にしてください。' : '';
    tableRows(root.querySelector('[data-staff]'), response.items.map((user) => {
      const actions = element('div');
      const self = user.sub === ctx.user.sub;
      const roles = element('select'); roles.multiple = true;
      for (const [value, label] of Object.entries(ROLE_LABELS)) { const option = element('option', label); option.value = value; option.selected = user.roles.includes(value); roles.append(option); }
      roles.setAttribute('aria-label', `${user.name}の役割`); roles.dataset.self = String(self);
      actions.append(roles);
      for (const [action, label] of [['roles', '役割を保存'], [user.enabled ? 'disable' : 'enable', user.enabled ? '無効化' : '有効化'], ['reset-mfa', '認証アプリを初期化'], ['reset-password', 'パスワードを再設定']]) {
        const button = element('button', label); button.type = 'button'; button.dataset.self = String(self);
        button.addEventListener('click', () => perform(async () => {
          const selected = [...roles.selectedOptions].map((option) => option.value);
          if (action === 'roles' && !selected.length) throw new ApiError('INVALID_REQUEST');
          if (!await confirmDialog(`${user.name || user.email}：${label}を行います。変更は監査ログに残ります。`)) return;
          await ctx.api.request(`/staff/${user.username}/${action}`, { method: 'POST', body: action === 'roles' ? { roles: selected } : {} });
          await load(); showMessage(root, 'スタッフの変更を保存しました。役割は60秒以内に反映されます。');
        }, true));
        actions.append(button);
      }
      return [user.email, user.name, user.roles.map((role) => ROLE_LABELS[role]).join('・'), `${user.enabled ? '有効' : '無効'}／${{ CONFIRMED: '登録完了', FORCE_CHANGE_PASSWORD: '初回ログイン待ち', RESET_REQUIRED: 'パスワード再設定待ち', UNCONFIRMED: '確認待ち' }[user.status] ?? '要確認'}`, actions];
    }));
  }
  root.querySelector('[data-staff-create]').addEventListener('submit', (event) => {
    event.preventDefault();
    if (uncertain) return;
    const form = event.currentTarget;
    perform(async () => {
      const values = new FormData(form);
      await ctx.api.request('/staff', { method: 'POST', body: { email: values.get('email'), name: values.get('name'), roles: values.getAll('roles') } });
      form.reset(); await load(); showMessage(root, 'スタッフを追加しました。Cognitoから届く仮パスワードでログインし、パスワード変更と認証アプリの登録を行ってください。');
    }, true);
  });
  await perform(load);
}
