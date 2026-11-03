import { ApiError, errorText, isUncertainMutation } from '../api.js';
import { clone, setText, on, element, fillSelect, tableRows, showMessage, confirmDialog, hasRole, isMasked, visibleAddress, formatCount, formatTime, fromJstInput, createActionGate, startPolling } from '../dom.js';

export function consentInput(at, source, version, now = Date.now()) {
  const iso = fromJstInput(at);
  if (!iso || Date.parse(iso) > now || !source?.trim()) throw new ApiError('INVALID_REQUEST', 400, '', ['同意の日時・取得経路']);
  return { at: iso, source: source.trim(), ...(version ? { version } : {}) };
}

export function contactInput(input, selected, now = Date.now()) {
  const email = input.email?.trim();
  if (!email || !email.includes('@')) throw new ApiError('INVALID_ADDRESS');
  if (input.operation === 'create') {
    if (!selected.length) throw new ApiError('INVALID_REQUEST', 400, '', ['配信リスト']);
    return { path: '/contacts', body: { email, name: input.name ?? '', topics: selected, consent: consentInput(input.consent_at, input.consent_source, input.consent_version, now) } };
  }
  if (input.operation === 'update') return { path: '/contacts/update', body: { email, name: input.name ?? '', ...(selected.length ? { topics: Object.fromEntries(selected.map((topic) => [topic, 'OPT_IN'])), consent: consentInput(input.consent_at, input.consent_source, input.consent_version, now) } : {}) } };
  if (input.operation === 'unsubscribe-all') return { path: '/contacts/unsubscribe', body: { email, scope: 'ALL' } };
  if (input.operation === 'unsubscribe') {
    if (selected.length !== 1) throw new ApiError('INVALID_REQUEST', 400, '', ['停止する配信リストを1つ選択']);
    return { path: '/contacts/unsubscribe', body: { email, scope: selected[0] } };
  }
  if (input.operation === 'reconsent' || input.operation === 'erase') {
    if (!input.note?.trim()) throw new ApiError('INVALID_REQUEST', 400, '', ['理由']);
    if (input.operation === 'erase') return { path: '/contacts/erase', body: { email, note: input.note.trim() } };
    if (!selected.length) throw new ApiError('INVALID_REQUEST', 400, '', ['配信リスト']);
    const { at, source } = consentInput(input.consent_at, input.consent_source, undefined, now);
    return { path: '/contacts/reconsent', body: { email, topics: selected, reconsent: { at, source }, note: input.note.trim() } };
  }
  throw new ApiError('INVALID_REQUEST');
}

export function topicSummary(contact, topics) {
  const preferences = new Map((contact.TopicPreferences ?? []).map((item) => [item.TopicName, item.SubscriptionStatus]));
  return topics.map((topic) => {
    const state = contact.UnsubscribeAll ? 'OPT_OUT' : preferences.get(topic.TopicName) ?? topic.DefaultSubscriptionStatus;
    return `${topic.DisplayName}：${state === 'OPT_IN' ? '購読' : '停止'}`;
  }).join('、');
}

export const IMPORT_STATUSES = Object.freeze({ RECEIVED: '受付済み', VALIDATING: '検証中', PREVIEW: '確認待ち（24時間以内に反映してください）', APPLYING: '更新を反映中', DISCARDED: '取りやめ', EXPIRED: '確認の期限切れ', SUBMITTING: '登録の受付を確認中', IMPORTING: '取込中', DONE: '完了', FAILED: '失敗', NEEDS_REVIEW: '要確認（管理者が確認してください）' });
const ROW_REASONS = Object.freeze({ DUPLICATE_IN_FILE: 'ファイル内の重複', EXISTING_SKIPPED: '登録済みのため変更しません', ERASED_SKIPPED: '完全削除済みのため登録しません', NOT_ALLOWED_IN_ENV: 'この環境で許可されていない宛先', INVALID_ADDRESS: 'メールアドレスの形式が不正', NONSTANDARD_ADDRESS: '登録できない形式のメールアドレス', INVALID_REQUEST: '入力の形式が不正', ATTRIBUTES_TOO_LARGE: '同意などの情報が大きすぎます' });
export const importReason = (code) => ({ UPDATED: '名前か停止を更新', UNCHANGED: '変更なし', NOT_FOUND: '登録されていないため変更しません', ERASED: '完全削除済み', INVALID: '形式または確認後の状態変更のため反映しません', READY: '新規登録の対象', PREVIEW_CHANGED: '確認後に状態が変わったため反映しません' }[code] ?? ROW_REASONS[code] ?? '行の形式・同意の記録・配信リストを確認してください。');

export async function mount(ctx) {
  const root = clone('contacts-template');
  ctx.root.replaceChildren(root);
  const q = (selector) => root.querySelector(selector);
  const gate = createActionGate();
  let cursor;
  let importCursor;
  let importId;
  let previewRecord;
  let importKey;
  let uncertain = false;
  let filters = {};
  const writable = () => hasRole(ctx.user, 'admin', 'sender');
  fillSelect(q('[data-filter]').elements.topic, ctx.topics.items.map((topic) => [topic.TopicName, topic.DisplayName]), 'すべて');
  for (const topic of ctx.topics.items) {
    const label = element('label', undefined, 'check');
    const checkbox = element('input');
    checkbox.type = 'checkbox'; checkbox.name = 'topic_choice'; checkbox.value = topic.TopicName;
    label.append(checkbox, document.createTextNode(topic.DisplayName));
    q('[data-topic-choices]').append(label);
  }

  function renderPermissions() {
    q('[data-write]').hidden = !writable();
    q('[data-import-area]').hidden = !writable();
    for (const option of root.querySelectorAll('[data-admin-option]')) option.disabled = !hasRole(ctx.user, 'admin');
    const operation = q('[data-contact-form]').elements.operation;
    if (!hasRole(ctx.user, 'admin') && ['reconsent', 'erase'].includes(operation.value)) operation.value = 'create';
    for (const button of root.querySelectorAll('button')) button.disabled = gate.busy || button.hasAttribute('data-search-only') && isMasked(ctx.user);
    q('[data-next]').disabled = gate.busy || !cursor;
    q('[data-imports-next]').disabled = gate.busy || !importCursor;
    q('[data-contact-submit]').disabled = gate.busy || uncertain || !writable();
    q('[data-import-submit]').disabled = gate.busy || uncertain || !writable();
    for (const control of q('[data-import-decisions]').querySelectorAll('button')) control.disabled = gate.busy || uncertain || !writable();
    setText(root, '[data-role-note]', isMasked(ctx.user) ? '閲覧者にはアドレスの一部を伏せて表示します。詳細は完全一致検索で確認できます。' : writable() ? '追加購読には同意の記録が必要です。退会の連絡を受けたときは全停止にしてください。' : '宛先の閲覧だけができます。登録・購読の変更は管理者・配信担当が行います。');
    if (uncertain) setText(root, '[data-role-note]', '操作の結果を確認できません。操作を繰り返さず、画面を読み込み直して宛先・取込結果を確認してください。');
  }

  async function perform(fn, mutation = false) {
    return gate.run(async () => {
      renderPermissions(); showMessage(root, '');
      try { await fn(); } catch (error) {
        if (mutation && isUncertainMutation(error)) uncertain = true;
        showMessage(root, errorText(error), true);
      }
    }).finally(renderPermissions);
  }

  async function detail(email) {
    const contact = await ctx.api.request(writable() ? '/contacts/events' : '/contacts/get', { method: 'POST', body: { email } });
    q('[data-contact-detail]').hidden = false;
    q('[data-delivery-events]').hidden = !writable();
    if (writable()) tableRows(q('[data-events-rows]'), (contact.events ?? []).map((item) => [formatTime(item.occurred_at), { Send: 'SESの受付', Delivery: '相手サーバーへ配送', Bounce: 'バウンス', Complaint: '苦情', DeliveryDelay: '配送遅延', Reject: '拒否', Subscription: '購読変更', RenderingFailure: '本文の作成失敗' }[item.type] ?? '要確認', item.campaign_id, [item.bounce_type, item.delay_type, item.complaint_type, item.diagnostic_code, ...(item.subscription?.topics ?? []).map((entry) => `${entry.topic}：${entry.status === 'OPT_OUT' ? '停止' : '購読'}`), ...(item.subscription?.unsubscribe_all ? ['全停止'] : [])].filter(Boolean).join('／')]));
    setText(root, '[data-detail-address]', visibleAddress(contact.EmailAddress, ctx.user));
    let attrs = {};
    if (!isMasked(ctx.user)) { try { attrs = JSON.parse(contact.AttributesData ?? '{}'); } catch { /* 不正な属性は画面へ反射しない。 */ } }
    setText(root, '[data-detail-name]', attrs?.name ? `名前：${attrs.name}` : '');
    setText(root, '[data-detail-topics]', `${contact.UnsubscribeAll ? '全停止中。' : ''}${topicSummary(contact, ctx.topics.items)}`);
    setText(root, '[data-detail-consent]', attrs?.consent ? `同意の日時：${formatTime(attrs.consent.at)}／取得経路：${attrs.consent.source ?? '—'}／版：${attrs.consent.version || '指定なし'}${attrs.reconsent ? `／新しい同意：${formatTime(attrs.reconsent.at)} ${attrs.reconsent.source ?? ''}` : ''}` : '');
    setText(root, '[data-suppression]', contact.suppression ? `配送しない宛先（抑止）：${contact.suppression.reason === 'BOUNCE' ? 'バウンス' : contact.suppression.reason === 'COMPLAINT' ? '苦情' : '要確認'}／${formatTime(contact.suppression.last_update_time)}` : '配送しない宛先（抑止）には登録されていません。');
    if (writable()) {
      const form = q('[data-contact-form]');
      form.elements.email.value = contact.EmailAddress;
      form.elements.name.value = attrs?.name ?? '';
      form.elements.operation.value = 'update';
      for (const checkbox of form.querySelectorAll('[name="topic_choice"]')) checkbox.checked = false;
    }
  }

  async function list(next) {
    const page = await ctx.api.request('/contacts', { query: { ...filters, limit: 50, cursor: next } });
    cursor = page.cursor;
    tableRows(q('[data-contacts]'), page.items.map((contact) => {
      const button = element('button', '詳細');
      button.type = 'button';
      button.disabled = isMasked(ctx.user);
      button.setAttribute('data-search-only', '');
      if (isMasked(ctx.user)) button.title = '完全一致検索で詳細を確認してください。';
      button.addEventListener('click', () => { if (!isMasked(ctx.user)) perform(() => detail(contact.EmailAddress)); });
      return [visibleAddress(contact.EmailAddress, ctx.user), contact.UnsubscribeAll ? '全停止' : '—', topicSummary(contact, ctx.topics.items), button];
    }));
  }

  async function importResult(id) {
    const record = await ctx.api.request(`/imports/${id}`);
    importId = id;
    previewRecord = record.status === 'PREVIEW' ? record : undefined;
    q('[data-import-decisions]').hidden = !previewRecord;
    setText(root, '[data-import-status]', `取込ID：${id}／${IMPORT_STATUSES[record.status] ?? '状態を確認できません'}`);
    const report = record.report ?? record;
    const values = [['全行', report.total], ['登録・更新の対象', report.ready], ['処理済み', record.processed], ['登録失敗', record.failed], ['対象外の行', Math.max(0, (report.total ?? 0) - (report.ready ?? 0))]];
    q('[data-import-counts]').replaceChildren(...values.flatMap(([label, value]) => [element('dt', label), element('dd', formatCount(value))]));
    const summary = Object.entries(report.summary ?? record.summary ?? {}).map(([code, count]) => `${code}：${formatCount(count)}件`).join('／');
    setText(root, '[data-import-changes]', `${summary}${record.mode === 'UPDATE_EXISTING' ? `／変わる項目：名前 ${formatCount(report.changes?.name ?? record.changes?.name)}件・停止 ${formatCount(report.changes?.stop ?? record.changes?.stop)}件` : ''}${record.preview_expires_at ? `／確認期限 ${formatTime(record.preview_expires_at)}` : ''}`);
    tableRows(q('[data-import-rows]'), (report.rows ?? []).map((row) => [row.row, row.code, importReason(row.code)]));
    if (record.error_code) showMessage(root, errorText(new ApiError(record.error_code)), true);
    if (['DONE', 'FAILED', 'NEEDS_REVIEW', 'DISCARDED', 'EXPIRED'].includes(record.status)) importId = undefined;
  }

  async function imports(next) {
    const page = await ctx.api.request('/imports', { query: { limit: 50, cursor: next } });
    importCursor = page.cursor;
    tableRows(q('[data-imports]'), page.items.map((record) => {
      const button = element('button', '結果を表示'); button.type = 'button';
      button.addEventListener('click', () => perform(() => importResult(record.import_id)));
      return [formatTime(record.created_at), IMPORT_STATUSES[record.status] ?? '要確認', button];
    }));
  }

  q('[data-filter]').addEventListener('submit', (event) => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.currentTarget));
    perform(async () => { filters = data; await list(); });
  });
  q('[data-search]').addEventListener('submit', (event) => {
    event.preventDefault();
    const email = event.currentTarget.elements.email.value.trim();
    perform(() => detail(email));
  });
  on(root, '[data-next]', 'click', () => perform(() => list(cursor)));
  on(root, '[data-imports-next]', 'click', () => perform(() => imports(importCursor)));
  q('[data-contact-form]').addEventListener('submit', (event) => {
    event.preventDefault();
    if (!writable() || uncertain) return;
    const form = event.currentTarget;
    const values = Object.fromEntries(new FormData(form));
    const selected = [...form.querySelectorAll('[name="topic_choice"]:checked')].map((input) => input.value);
    perform(async () => {
      if (['reconsent', 'erase'].includes(values.operation) && !hasRole(ctx.user, 'admin')) throw new ApiError('FORBIDDEN');
      const input = contactInput(values, selected);
      if (values.operation === 'erase' && !await confirmDialog('この宛先の個人情報を完全削除します。以後、このアドレスは登録・取込できません。')) return;
      if (values.operation === 'unsubscribe-all' && !await confirmDialog('この会員への配信をすべて停止します。購読の再開には管理者による新しい同意の証跡が必要です。')) return;
      await ctx.api.request(input.path, { method: 'POST', body: input.body });
      showMessage(root, '操作を受け付けました。');
      if (values.operation === 'erase') q('[data-contact-detail]').hidden = true;
      else await detail(input.body.email);
      await list();
    }, true);
  });
  on(root, '[data-import-form] input', 'change', () => { importKey = crypto.randomUUID(); });
  on(root, '[data-import-form] select', 'change', () => { importKey = crypto.randomUUID(); });
  for (const action of ['confirm', 'discard']) on(root, `[data-import-${action}]`, 'click', () => {
    if (!previewRecord || uncertain || !writable()) return;
    const record = previewRecord;
    perform(async () => {
      if (!await confirmDialog(action === 'confirm' ? '件数と変わる項目を確認して反映します。購読の追加や再開は行いません。' : '取込を取りやめ、受け取ったファイルを削除します。')) return;
      await ctx.api.request(`/imports/${record.import_id}/${action}`, { method: 'POST', body: { version: record.version } });
      await importResult(record.import_id); await imports();
    }, true);
  });
  q('[data-import-form]').addEventListener('submit', (event) => {
    event.preventDefault();
    if (!writable() || uncertain) return;
    const file = event.currentTarget.elements.file.files[0];
    const mode = event.currentTarget.elements.mode.value;
    perform(async () => {
      if (!file) throw new ApiError('INVALID_REQUEST');
      if (file.size > 2 * 1024 * 1024) throw new ApiError('PAYLOAD_TOO_LARGE');
      importKey ??= crypto.randomUUID();
      let csv;
      try { csv = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer()); } catch { throw new ApiError('INVALID_REQUEST'); }
      const result = await ctx.api.request('/imports', { method: 'POST', query: { mode }, csv, idempotencyKey: importKey });
      await importResult(result.import_id);
      await imports();
      showMessage(root, 'CSVの検査を受け付けました。確認画面で件数を確かめてから反映してください。');
    }, true);
  });
  renderPermissions();
  await perform(async () => { await list(); if (writable()) await imports(); });
  ctx.addCleanup(startPolling(async () => {
    if (!gate.busy) await perform(async () => { await ctx.refreshUser(); if (importId && writable()) await importResult(importId); });
  }, { onError: (error) => showMessage(root, errorText(error), true) }));
}
