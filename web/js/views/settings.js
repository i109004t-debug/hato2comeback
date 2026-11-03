import { ApiError, errorText, isUncertainMutation } from '../api.js';
import { clone, setText, on, element, fillSelect, tableRows, showMessage, confirmDialog, hasRole, visibleAddress, formatTime, createActionGate } from '../dom.js';

export const DELIVERY_CASES = Object.freeze(['T-25', 'T-26', 'T-27', 'T-28', 'T-30', 'T-31', 'T-32', 'T-33', 'T-34', 'T-36', 'T-38', 'T-39', 'T-40', 'T-41', 'T-43', 'T-44', 'T-45', 'T-46', 'T-47', 'T-48', 'T-49', 'T-50', 'T-51']);

export function settingsInput(input, version) {
  const recipients = input.test_recipients.split(/\r?\n/).map((email) => email.trim()).filter(Boolean);
  if (recipients.length > 5) throw new ApiError('INVALID_REQUEST', 400, '', ['テスト送信先（最大5件）']);
  const rate = Number(input.max_rate_per_sec);
  if (!Number.isFinite(rate) || rate < 1) throw new ApiError('INVALID_REQUEST', 400, '', ['送信速度の上限']);
  return { version, from_local: input.from_local, from_name: input.from_name, reply_to: input.reply_to ?? '', legal: { sender_name: input.sender_name, address: input.address, contact: input.contact }, approval_required: input.approval_required === 'on', test_recipients: recipients, max_rate_per_sec: rate };
}

export function deliveryInput(input) {
  const cases = Object.fromEntries(DELIVERY_CASES.map((id) => [id, input[id]]));
  if (!['true', 'false'].includes(input.passed) || !input.note?.trim() || !/^delivery-checks\/[A-Za-z0-9/_.-]+$/.test(input.evidence_key ?? '') || input.evidence_key.split('/').includes('..') || !/^[a-f0-9]{64}$/.test(input.config_hash ?? '') || !/^[a-f0-9]{64}$/.test(input.dns_config_hash ?? '') || Object.values(cases).some((value) => !['PASS', 'FAIL'].includes(value))) throw new ApiError('INVALID_REQUEST', 400, '', ['受信確認の記録']);
  if (input.passed === 'true' && Object.values(cases).some((value) => value !== 'PASS')) throw new ApiError('DELIVERY_CHECK_REQUIRED');
  return { passed: input.passed === 'true', note: input.note.trim(), evidence_key: input.evidence_key, cases, config_hash: input.config_hash, dns_config_hash: input.dns_config_hash };
}

export async function mount(ctx) {
  const root = clone('settings-template');
  ctx.root.replaceChildren(root);
  const q = (selector) => root.querySelector(selector);
  const gate = createActionGate();
  let settings = ctx.settings;
  let auditCursor;
  let auditMonth;
  let conflict = false;
  const admin = () => hasRole(ctx.user, 'admin');
  const form = q('[data-settings]');
  for (const id of DELIVERY_CASES) {
    const label = element('label', id);
    const select = element('select'); select.name = id;
    fillSelect(select, [['FAIL', '未確認・不合格'], ['PASS', '合格']]);
    label.append(select); q('[data-cases]').append(label);
  }
  q('[data-audit-form]').elements.month.value = new Date().toISOString().slice(0, 7);

  function permissions() {
    q('[data-fields]').disabled = !admin() || gate.busy || conflict;
    q('[data-delivery-form]').hidden = !admin();
    q('[data-audit-area]').hidden = !admin();
    for (const control of q('[data-delivery-form]').elements) control.disabled = !admin() || gate.busy || conflict;
    q('[data-audit-next]').disabled = gate.busy || !auditCursor;
    setText(root, '[data-role-note]', admin() ? '管理者として組織設定を編集できます。スタッフのアカウント・役割の変更はAWSの管理者が行います。' : '設定の閲覧だけができます。変更は管理者が行います。');
    setText(root, '[data-domain]', `送信元ドメイン：${ctx.config.senderDomain}（構築時に固定）`);
  }

  function populate() {
    for (const name of ['from_name', 'from_local', 'reply_to', 'max_rate_per_sec']) form.elements[name].value = settings[name] ?? '';
    for (const name of ['sender_name', 'address', 'contact']) form.elements[name].value = settings.legal?.[name] ?? '';
    form.elements.approval_required.checked = settings.approval_required !== false;
    form.elements.test_recipients.value = (settings.test_recipients ?? []).map((email) => visibleAddress(email, ctx.user)).join('\n');
    const record = settings.delivery_check;
    setText(root, '[data-delivery-status]', record ? `${record.status === 'PASS' ? '合格の記録あり（開始時に有効性を再確認します）' : '不合格'}／確認日時：${formatTime(record.passed_at)}` : '受信確認の記録はありません。');
  }

  async function perform(fn, mutation = false) {
    return gate.run(async () => {
      permissions(); showMessage(root, '');
      try { await fn(); } catch (error) {
        if (mutation && (error.code === 'VERSION_CONFLICT' || isUncertainMutation(error))) conflict = true;
        showMessage(root, errorText(error), true);
      }
    }).finally(permissions);
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (!admin() || conflict) return;
    const values = Object.fromEntries(new FormData(form));
    perform(async () => {
      const body = settingsInput(values, settings.version);
      if (!body.approval_required && settings.approval_required !== false && !await confirmDialog('承認を不要にします。スタッフが1人だけの組織であることを確認してください。変更は監査ログに残ります。')) return;
      settings = await ctx.api.request('/settings', { method: 'PUT', body });
      populate(); showMessage(root, '組織設定を保存しました。');
    }, true);
  });
  q('[data-delivery-form]').addEventListener('submit', (event) => {
    event.preventDefault();
    if (!admin() || conflict) return;
    const values = Object.fromEntries(new FormData(event.currentTarget));
    perform(async () => {
      const body = deliveryInput(values);
      if (!await confirmDialog(body.passed ? '受信確認を合格として登録します。必須試験の結果と現在の設定が一致することを確認してください。' : '受信確認を不合格として登録し、一般の配信を止めます。')) return;
      await ctx.api.request('/settings/delivery-check', { method: 'POST', body });
      settings = await ctx.api.request('/settings');
      populate(); showMessage(root, '受信確認の記録を登録しました。');
    }, true);
  });
  async function audit(cursor) {
    const page = await ctx.api.request('/audit', { query: { month: auditMonth, limit: 50, cursor } });
    auditCursor = page.cursor;
    tableRows(q('[data-audit]'), page.items.map((record) => [formatTime(record.ts), record.action, record.result, record.target, record.request_id]));
  }
  q('[data-audit-form]').addEventListener('submit', (event) => {
    event.preventDefault();
    if (!admin()) return;
    const month = event.currentTarget.elements.month.value.replace('-', '');
    perform(async () => { auditMonth = month; await audit(); });
  });
  on(root, '[data-audit-next]', 'click', () => perform(() => audit(auditCursor)));
  populate(); permissions();
}
