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
  if (!input.note?.trim() || [...input.note].length > 1000) throw new ApiError('INVALID_REQUEST', 400, '', ['受入確認の記録']);
  return { note: input.note.trim() };
}

export const INVALIDATION_LABELS = Object.freeze({ CONFIG_CHANGED: '送信の設定かプログラムが変わったため', DNS_CHANGED: 'DNSの設定が変わったため', AUTH_CHECK_FAILED: '送信元の認証の確認で問題が見つかったため', EXPIRED: '確認から90日を過ぎたため' });
const DNS_LABELS = Object.freeze({ DKIM: 'DKIM', FROM_SPF: '差出人のSPF', MAIL_FROM_SPF: 'MAIL FROMのSPF', MAIL_FROM_MX: 'MAIL FROMのMX', FROM_A: '差出人のA', FROM_MX: '差出人のMX', DMARC: 'DMARC' });

export async function mount(ctx) {
  const root = clone('settings-template');
  ctx.root.replaceChildren(root);
  const q = (selector) => root.querySelector(selector);
  const gate = createActionGate();
  let settings = ctx.settings;
  let auditCursor;
  let auditMonth;
  let conflict = false;
  let acceptance;
  let selectedCheck;
  const admin = () => hasRole(ctx.user, 'admin');
  const form = q('[data-settings]');
  q('[data-audit-form]').elements.month.value = new Date().toISOString().slice(0, 7);

  function permissions() {
    q('[data-fields]').disabled = !admin() || gate.busy || conflict;
    q('[data-acceptance]').hidden = !admin();
    q('[data-audit-area]').hidden = !admin();
    for (const control of q('[data-acceptance]').querySelectorAll('button, input, select, textarea')) control.disabled = !admin() || gate.busy || conflict;
    q('[data-audit-next]').disabled = gate.busy || !auditCursor;
    setText(root, '[data-role-note]', admin() ? '組織設定と受入確認を管理できます。アカウントの変更は「スタッフ」で行います。' : '設定の閲覧だけができます。変更は管理者が行います。');
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
  function drawAcceptance() {
    const record = acceptance.delivery_check;
    const reason = INVALIDATION_LABELS[record?.invalidation_reason] ?? '';
    const details = (record?.invalidation_details ?? []).map((key) => DNS_LABELS[key]).filter(Boolean).join('・');
    setText(root, '[data-delivery-status]', record ? `${record.status === 'PASS' && !reason ? '合格' : '配信を開始できません'}／有効期限 ${formatTime(record.expires_at)}／残り${record.remaining_days}日${reason ? `／${reason}` : ''}${details ? `（${details}）` : ''}` : '受入記録はありません。');
    fillSelect(q('[data-check-select]'), acceptance.checks.map((check) => [check.check_id, `${formatTime(check.started_at)}に始めた検査`]), '検査を選ぶ');
    if (selectedCheck) q('[data-check-select]').value = selectedCheck.check_id;
    q('[data-check-steps]').hidden = !selectedCheck;
    fillSelect(q('[data-case-form]').elements.case_id, acceptance.required_cases.map((item) => [item.id, `${item.id} ${item.title}（人が記録する）`]));
    fillSelect(q('[data-evidence-form]').elements.case_id, acceptance.required_cases.map((item) => [item.id, `${item.id} ${item.title}`]));
    tableRows(q('[data-cases]'), acceptance.required_cases.map((item) => {
      const saved = selectedCheck?.cases?.[item.id];
      return [item.id, item.title, { PASS: '合格', FAIL: '不合格', NA: '対象外' }[saved?.result] ?? '未記録', saved?.note ?? '', `${saved?.evidence?.length ?? 0}件`];
    }));
    setText(root, '[data-test-sends]', (selectedCheck?.test_sends ?? []).map((item) => `${formatTime(item.at)} ${item.email_masked} ${item.status}`).join('\n'));
  }
  async function loadAcceptance() {
    acceptance = await ctx.api.request('/settings/delivery-check');
    selectedCheck = acceptance.checks.find((check) => check.check_id === selectedCheck?.check_id) ?? acceptance.checks.at(-1);
    drawAcceptance();
  }
  on(root, '[data-check-select]', 'change', (event) => { selectedCheck = acceptance.checks.find((check) => check.check_id === event.target.value); drawAcceptance(); });
  on(root, '[data-check-start]', 'click', () => perform(async () => {
    selectedCheck = await ctx.api.request('/settings/delivery-check', { method: 'POST', body: {} });
    await loadAcceptance(); showMessage(root, '受入検査を始めました。30日以内に試験と証跡を登録して確定してください。');
  }, true));
  q('[data-case-form]').addEventListener('submit', (event) => {
    event.preventDefault(); if (!selectedCheck || conflict) return;
    const values = Object.fromEntries(new FormData(event.currentTarget));
    perform(async () => {
      await ctx.api.request(`/settings/delivery-check/${selectedCheck.check_id}/cases/${values.case_id}`, { method: 'PUT', body: { result: values.result, note: values.note } });
      await loadAcceptance(); showMessage(root, '試験の結果を記録しました。');
    }, true);
  });
  q('[data-evidence-form]').addEventListener('submit', (event) => {
    event.preventDefault(); if (!selectedCheck || conflict) return;
    const form = event.currentTarget;
    const file = form.elements.file.files[0];
    const case_id = form.elements.case_id.value;
    perform(async () => {
      if (!file || !file.size || file.size > 1024 * 1024) throw new ApiError('PAYLOAD_TOO_LARGE');
      const bytes = new Uint8Array(await file.arrayBuffer());
      let binary = '';
      for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
      await ctx.api.request(`/settings/delivery-check/${selectedCheck.check_id}/evidence`, { method: 'POST', body: { case_id, file_name: file.name, content_base64: btoa(binary) } });
      await loadAcceptance(); form.elements.file.value = ''; showMessage(root, '証跡を登録しました。');
    }, true);
  });
  q('[data-delivery-form]').addEventListener('submit', (event) => {
    event.preventDefault(); if (!selectedCheck || conflict) return;
    const body = deliveryInput(Object.fromEntries(new FormData(event.currentTarget)));
    perform(async () => {
      if (!await confirmDialog('受入検査を確定します。不合格の必須試験がある場合は一般配信を止めます。')) return;
      await ctx.api.request(`/settings/delivery-check/${selectedCheck.check_id}/submit`, { method: 'POST', body });
      selectedCheck = undefined; await loadAcceptance(); showMessage(root, '受入検査を確定しました。');
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
  if (admin()) await perform(loadAcceptance);
}
