export function clone(templateId, doc = document) {
  return doc.getElementById(templateId).content.firstElementChild.cloneNode(true);
}

export function setText(el, selector, text) {
  el.querySelector(selector).textContent = text ?? '';
}

export function on(el, selector, event, fn) {
  el.querySelector(selector).addEventListener(event, fn);
}

export function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

export function fillSelect(select, options, emptyLabel) {
  select.replaceChildren();
  if (emptyLabel !== undefined) select.append(new Option(emptyLabel, ''));
  for (const [value, label] of options) select.append(new Option(label, value));
}

export function tableRows(body, rows, empty = '該当する記録はありません。') {
  body.replaceChildren();
  for (const cells of rows) {
    const tr = element('tr');
    for (const cell of cells) {
      const td = element('td');
      if (cell && typeof cell === 'object' && cell.nodeType) td.append(cell);
      else td.textContent = cell ?? '—';
      tr.append(td);
    }
    body.append(tr);
  }
  if (!rows.length) {
    const td = element('td', empty);
    td.colSpan = body.closest('table').querySelectorAll('thead th').length;
    const tr = element('tr');
    tr.append(td);
    body.append(tr);
  }
}

export function showMessage(root, message, error = false) {
  const node = root.querySelector('[data-message]');
  node.textContent = message ?? '';
  node.classList.toggle('error', error);
  node.setAttribute('role', error ? 'alert' : 'status');
}

export function previewDialog(subject, text, hash = '') {
  const dialog = clone('preview-template');
  setText(dialog, '[data-subject]', subject);
  setText(dialog, '[data-text]', text);
  setText(dialog, '[data-hash]', hash ? `内容のハッシュ：${hash.slice(0, 12)}` : '下書きのプレビュー');
  on(dialog, '[data-close]', 'click', () => dialog.close());
  dialog.addEventListener('close', () => dialog.remove(), { once: true });
  document.body.append(dialog);
  dialog.showModal();
}

export function confirmDialog(message) {
  return new Promise((resolve) => {
    const dialog = clone('confirm-template');
    setText(dialog, '[data-text]', message);
    on(dialog, '[data-confirm]', 'click', () => dialog.close('confirm'));
    on(dialog, '[data-close]', 'click', () => dialog.close('cancel'));
    dialog.addEventListener('close', () => { resolve(dialog.returnValue === 'confirm'); dialog.remove(); }, { once: true });
    document.body.append(dialog);
    dialog.showModal();
  });
}

export function hasRole(user, ...roles) {
  return roles.some((role) => user?.roles?.includes(role));
}

export const isMasked = (user) => !hasRole(user, 'admin', 'sender', 'approver');

export function maskAddress(email) {
  if (typeof email !== 'string') return '—';
  const at = email.lastIndexOf('@');
  if (at < 1 || at === email.length - 1) return '***';
  if (email.slice(0, at).includes('*')) return email;
  const local = email.slice(0, at);
  return `${local[0]}***${local.length > 1 ? local.at(-1) : ''}${email.slice(at)}`;
}

export const visibleAddress = (email, user) => isMasked(user) ? maskAddress(email) : email ?? '—';
export const formatCount = (value) => Number.isFinite(value) && value >= 0 ? new Intl.NumberFormat('ja-JP').format(value) : '—';

export function formatTime(value) {
  if (!value || !Number.isFinite(Date.parse(value))) return '—';
  return new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(new Date(value)) + '（日本時間）';
}

export function jstInput(value) {
  const time = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(time) ? new Date(time + 9 * 3600000).toISOString().slice(0, 16) : '';
}

export function fromJstInput(value) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null;
  const iso = `${value}:00+09:00`;
  return Number.isFinite(Date.parse(iso)) && jstInput(iso) === value ? iso : null;
}

export const STATUS_LABELS = Object.freeze({ DRAFT: '下書き', PENDING_APPROVAL: '承認待ち', APPROVED: '承認済み', SCHEDULED: '予約済み', QUEUED: '開始待ち', SENDING: '送信中', PAUSED: '一時停止中', NEEDS_REVIEW: '要確認', COMPLETED: '完了', CANCELLED: '中止' });
export const statusLabel = (status) => STATUS_LABELS[status] ?? '状態を確認できません';
export const resultLabel = (result) => ({ ACCEPTED: '送信受付', FAILED: '失敗', UNKNOWN: '不明', SKIPPED: '停止済みのため送らなかった', NOT_ATTEMPTED: '未試行' })[result] ?? '要確認';

export const PAUSE_LABELS = Object.freeze({ USER: '運営スタッフの操作で停止しました。', OPERATOR_SWITCH: '全体の停止スイッチが入っています。', REPUTATION_ALARM: 'バウンス率や苦情率の警報が出ています。', CAMPAIGN_BOUNCE: 'この配信のバウンス率が高くなっています。', CAMPAIGN_DELAY: 'この配信の配送遅延率が高くなっています。', EVENTS_MISSING: '配送の記録が届いていません。', EVENT_LOG_STALE: '配送の記録が遅れています。', MONITORING_UNAVAILABLE: '監視の状態を確認できません。', CONTENT_ERROR: '固定した本文の処理に異常があります。', AUTH_CHECK: '送信元ドメインの認証を確認できません。', SES_PAUSED: 'SESが送信を止めています。', SES_UNSTABLE: 'SESの応答が不安定です。', QUOTA: 'SESの24時間の送信枠が足りません。' });

export function progressLines(campaign, stats = {}) {
  const counts = stats.counts ?? campaign.counts ?? {};
  const metrics = stats.metrics ?? {};
  return [
    ['送信済み（SES受付・送信処理の集計）／総数', `${formatCount(counts.accepted)} ／ ${formatCount(campaign.recipients_total)}`],
    ['失敗', formatCount(counts.failed)], ['不明', formatCount(counts.unknown)],
    ['停止済みのため送らなかった', formatCount(counts.skipped_blocked)],
    ['許可リストによる除外', formatCount(counts.excluded_allowlist)],
    ['SES受付（イベントの集計）', formatCount(metrics.Send)],
    ...[['配送', 'Delivery'], ['配送遅延', 'DeliveryDelay'], ['バウンス', 'Bounce'], ['苦情', 'Complaint'], ['購読設定の変更', 'Subscription'], ['SES内部の拒否', 'Reject'], ['テンプレートの失敗', 'RenderingFailure']].map(([label, key]) => [label, formatCount(metrics[key])]),
  ];
}

// 二度押しと、ポーリングの重複を同期的に抑える。
export function createActionGate() {
  let busy = false;
  return { get busy() { return busy; }, async run(fn) {
    if (busy) return false;
    busy = true;
    try { await fn(); return true; } finally { busy = false; }
  } };
}

export function startPolling(fn, { setTimer = setTimeout, clearTimer = clearTimeout, interval = 10000, onError = () => {} } = {}) {
  let stopped = false;
  let timer;
  const tick = async () => {
    try { await fn(); } catch (error) { if (!stopped) onError(error); }
    if (!stopped) timer = setTimer(tick, interval);
  };
  timer = setTimer(tick, interval);
  return () => { stopped = true; clearTimer(timer); };
}
