import { ApiError, errorText, isUncertainMutation } from '../api.js';
import { clone, setText, on, element, fillSelect, tableRows, showMessage, previewDialog, confirmDialog, hasRole, visibleAddress, formatCount, formatTime, jstInput, fromJstInput, statusLabel, resultLabel, PAUSE_LABELS, progressLines, createActionGate, startPolling } from '../dom.js';

const canSend = (user) => hasRole(user, 'admin', 'sender');
const canOperate = (user) => hasRole(user, 'admin', 'sender', 'approver');

export const canSchedule = (campaign, user, blocked = false) => campaign.status === 'APPROVED' && canSend(user) && !blocked;

export function testSendInput(user, recovery, note = '', check_id) {
  if (!recovery) return {};
  if (!hasRole(user, 'admin')) throw new ApiError('FORBIDDEN', 403);
  if (!note.trim() || [...note].length > 1000 || /[\p{Cc}\p{Cs}\p{Zl}\p{Zp}]/u.test(note)) throw new ApiError('INVALID_REQUEST', 400, '', ['再検証の理由']);
  if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(check_id ?? '')) throw new ApiError('INVALID_REQUEST', 400, '', ['進行中の受入検査']);
  return { purpose: 'ACCEPTANCE_RECOVERY', note: note.trim(), check_id };
}

export function primaryAction(campaign, user, { busy = false, dirty = false, stale = false, uncertain = false, previewHash = '', confirmed = false } = {}) {
  const state = campaign?.status ?? 'DRAFT';
  const action = { DRAFT: ['submit', '承認申請'], PENDING_APPROVAL: ['approve', '承認'], APPROVED: ['start', '配信開始'] }[state];
  let reason = '';
  if (!action) reason = state === 'NEEDS_REVIEW' ? '管理者が配送の記録を確かめて判断してください。' : `現在は「${statusLabel(state)}」です。`;
  else if (busy) reason = '処理中です。お待ちください。';
  else if (uncertain) reason = '操作の結果を確認できません。操作を繰り返さず、画面を読み込み直してください。';
  else if (stale) reason = '他の人が先に操作しました。画面を読み込み直してください。';
  else if (action[0] === 'approve') {
    if (!hasRole(user, 'admin', 'approver')) reason = '承認できるのは管理者・承認者です。';
    else if (campaign.approval_required !== false && (!campaign.submitted_by || campaign.submitted_by === user?.sub)) reason = '申請者とは別の人が承認してください。';
    else if (!/^[a-f0-9]{64}$/.test(campaign.content_sha256 ?? '') || previewHash !== campaign.content_sha256 || !confirmed) reason = '固定した内容とハッシュを確認してください。';
  } else if (!canSend(user)) reason = 'この操作は管理者・配信担当が行います。';
  else if (!campaign?.campaign_id || dirty) reason = '先に下書きを保存してください。';
  return { action: action?.[0] ?? null, label: action?.[1] ?? '操作できません', enabled: !!action && !reason, reason };
}

export function controlPolicy(campaign, user, blocked = false) {
  const state = campaign?.status;
  const operator = canOperate(user);
  const enable = (condition, reason) => ({ enabled: !blocked && condition, reason: blocked ? '処理中、または操作結果の確認が必要です。' : condition ? '' : reason });
  return {
    pause: enable(operator && ['SENDING', 'QUEUED'].includes(state), operator ? '一時停止できるのは準備中・送信中の配信です。' : '一時停止は管理者・配信担当・承認者が行います。'),
    resume: enable(state === 'PAUSED' && (campaign.pause_reason === 'USER' ? operator : hasRole(user, 'admin')), state === 'PAUSED' && campaign.pause_reason !== 'USER' ? 'システムが止めた配信は、管理者が原因を直して再開してください。' : '再開できるのは一時停止中の配信です。'),
    cancel: enable(operator && ['APPROVED', 'SCHEDULED', 'QUEUED', 'SENDING', 'PAUSED', 'NEEDS_REVIEW'].includes(state), operator ? '現在の状態では中止できません。' : '中止は管理者・配信担当・承認者が行います。'),
    unschedule: enable(canSend(user) && state === 'SCHEDULED', '予約の取消は予約済みの配信を管理者・配信担当が操作します。'),
    reject: enable(hasRole(user, 'admin', 'approver') && state === 'PENDING_APPROVAL', '差戻しは承認待ちの配信を管理者・承認者が操作します。'),
  };
}

export function defaultSchedule(now = Date.now()) {
  const date = new Date(now + 300000 + 9 * 3600000);
  if (date.getUTCMinutes() > 5 || date.getUTCMinutes() === 5 && (date.getUTCSeconds() || date.getUTCMilliseconds())) date.setUTCHours(date.getUTCHours() + 1);
  date.setUTCMinutes(5, 0, 0);
  return date.toISOString().slice(0, 16);
}

export function scheduleInput(mode, value, now = Date.now()) {
  if (mode === 'NOW') return { mode: 'NOW' };
  const at = fromJstInput(value);
  if (mode !== 'SCHEDULED' || !at || Date.parse(at) < now + 300000 || Date.parse(at) > now + 90 * 86400000) throw new ApiError('INVALID_REQUEST', 400, '', ['予約日時']);
  return { mode, at };
}

export const isOnTheHour = (value) => !!fromJstInput(value) && value.slice(14, 16) === '00';
export const hasShortUrl = (value) => /https?:\/\/(?:bit\.ly|t\.co|tinyurl\.com|goo\.gl|is\.gd|ow\.ly)(?:[/?#]|$)/i.test(value);

export function scopeDefaults(estimate, now = Date.now()) {
  return { max_recipients: Math.max(100, Math.min(100000, Math.ceil((estimate ?? 0) * 1.2 / 100) * 100)), send_by: new Date(now + 7 * 86400000).toISOString() };
}

export function scopeInput(max, by, after = '', now = Date.now()) {
  const max_recipients = Number(max);
  const send_by = fromJstInput(by);
  const send_after = after ? fromJstInput(after) : undefined;
  if (!Number.isSafeInteger(max_recipients) || max_recipients < 1 || max_recipients > 100000 || !send_by || Date.parse(send_by) < now + 3600000 || Date.parse(send_by) > now + 90 * 86400000 || after && (!send_after || Date.parse(send_after) >= Date.parse(send_by))) throw new ApiError('INVALID_REQUEST', 400, '', ['最大件数・送信期限・開始日時']);
  return { max_recipients, send_by: new Date(send_by).toISOString(), ...(send_after ? { send_after: new Date(send_after).toISOString() } : {}) };
}

export function forecastText(forecast) {
  if (!forecast) return '完了見込みを取得できません。更新して確認してください。';
  return `対象 ${formatCount(forecast.assumptions.recipients)}件・期限までに送れる見込み 約${formatCount(forecast.capacity_until_deadline)}件。${forecast.completes ? `完了見込み：${formatTime(forecast.finish_estimate)}` : `期限までに送り終えられません（不足 約${formatCount(forecast.shortfall)}件）`}。送信枠は日ごとの概算で、実際の完了を保証しません。`;
}

export function validateDraft(input) {
  const body = input.body_text.replace(/\r\n?/g, '\n');
  if (!/^[a-z0-9_]{1,20}$/.test(input.topic) || !input.subject.trim() || [...input.subject].length > 200 || /[\p{Cc}\p{Cs}\p{Zl}\p{Zp}]/u.test(input.subject) || /\p{Cs}/u.test(body) || [input.subject, body].some((text) => text.includes('{{') || text.includes('}}'))) throw new ApiError('INVALID_REQUEST', 400, '', ['配信リスト・件名・本文']);
  if (new TextEncoder().encode(body).length > 50 * 1024) throw new ApiError('PAYLOAD_TOO_LARGE');
  return { topic: input.topic, subject: input.subject, body_text: body };
}

export function draftFooter(settings, display) {
  const legal = settings?.legal;
  if (![legal?.sender_name, legal?.address, legal?.contact, display].every((value) => typeof value === 'string' && value.trim())) return '法定表示が未設定です。管理者が設定してください。';
  return `\n----\nこのメールは${legal.sender_name}の「${display}」にご登録いただいた方にお送りしています。\n配信停止・配信設定の変更は、次のURLから手続きできます（このメール上部の「登録解除」からも停止できます）。\n{{amazonSESUnsubscribeUrl}}\n\n発行：${legal.sender_name}\n所在地：${legal.address}\nお問い合わせ：${legal.contact}\n`;
}

export function reviewInput(campaign, decision, note) {
  if (!note.trim() || [...note].length > 1000 || !['SKIP', 'RESEND', 'CANCEL', 'RESTART'].includes(decision)) throw new ApiError('INVALID_REQUEST', 400, '', ['確認した内容・判断の理由']);
  if (campaign.review?.reason === 'RESTORED') {
    if (decision !== 'CANCEL') throw new ApiError('STATE_CONFLICT', 409);
    return { decision, note };
  }
  const preparing = campaign.review?.phase === 'prepare' || !Number.isSafeInteger(campaign.chunks_total);
  if (preparing) {
    if (!['RESTART', 'CANCEL'].includes(decision)) throw new ApiError('INVALID_REQUEST');
    return { decision: decision === 'RESTART' ? 'SKIP' : 'CANCEL', note, ...(decision === 'RESTART' ? { resume: false } : {}) };
  }
  if (decision === 'RESTART') throw new ApiError('INVALID_REQUEST');
  if (decision !== 'CANCEL') {
    const range = campaign.review;
    if (!range || ![range.chunk, range.index_from, range.index_to].every(Number.isSafeInteger) || range.chunk < 0 || range.chunk > campaign.chunks_total || range.index_from < 0 || range.index_to < range.index_from - 1 || range.index_to - range.index_from >= 20 || !Array.isArray(campaign.review_recipients) || campaign.review_recipients.length !== range.index_to - range.index_from + 1 || typeof campaign.athena_query !== 'string' || !campaign.athena_query.trim()) throw new ApiError('STATE_CONFLICT', 409);
  }
  return { decision, note };
}

export async function mount(ctx, id) {
  const root = clone('send-template');
  ctx.root.replaceChildren(root);
  const q = (selector) => root.querySelector(selector);
  const readinessPanel = element('section', undefined, 'panel');
  readinessPanel.append(element('h2', '送信の準備状況'));
  const readinessItems = element('ul'); readinessPanel.append(readinessItems); root.prepend(readinessPanel);
  async function readiness() {
    try {
      const response = await ctx.api.request('/readiness');
      const owners = { SENDER: '配信担当', APPROVER: '承認者', ADMIN: '管理者', AWS_ADMIN: 'AWSの管理者' };
      const statuses = { OK: '準備できています', WARN: '確認してください', BLOCKED: '止まっています', UNKNOWN: '取得できません' };
      readinessItems.replaceChildren(...response.items.map((item) => element('li', `${item.title}：${statuses[item.status] ?? statuses.UNKNOWN}${item.detail ? `／${item.detail}` : ''}${item.status !== 'OK' ? `／${owners[item.owner] ?? '管理者'}：${item.action}` : ''}`)));
    } catch { readinessItems.replaceChildren(element('li', '準備状況を取得できません。AWSの管理者がシステムの状態を確認してください。')); }
  }
  await readiness();
  ctx.addCleanup(startPolling(readiness, { interval: 60000 }));
  const checkSelect = element('select'); checkSelect.setAttribute('aria-label', '復旧テストの受入検査');
  q('[data-recovery-note]').parentElement.append(checkSelect);
  if (hasRole(ctx.user, 'admin')) {
    const response = await ctx.api.request('/settings/delivery-check');
    fillSelect(checkSelect, response.checks.map((item) => [item.check_id, `${formatTime(item.started_at)}に始めた検査`]), '設定画面で受入検査を始めてから選択');
  }
  const form = q('[data-draft]');
  const gate = createActionGate();
  let campaign = { status: 'DRAFT', version: 0 };
  let stats = {};
  let dirty = false;
  let stale = false;
  let uncertain = false;
  let renderedHash = '';
  let failureCursor;
  let sesAcceptedCount;
  let failurePageCursor;
  let failuresLoading = false;
  let fixedLoading = false;
  let loading = false;
  let scopeDirty = false;
  let scopeForecast;
  const readScope = () => scopeInput(q('[data-max-recipients]').value, q('[data-send-by]').value, q('[data-send-after]').value);
  const topicOptions = ctx.topics.items.map((topic) => [topic.TopicName, topic.DisplayName]);
  fillSelect(form.elements.topic, topicOptions);
  q('[data-at]').value = defaultSchedule();

  function footer() {
    const topic = ctx.topics.items.find((item) => item.TopicName === form.elements.topic.value);
    setText(root, '[data-subscribers]', `購読者 約${formatCount(topic?.subscribers)}件（前日時点）・集計日時：${formatTime(ctx.topics.counted_at)}`);
    setText(root, '[data-footer]', campaign.status === 'DRAFT' ? draftFooter(ctx.settings, topic?.DisplayName) : campaign.footer_text ?? '—');
    q('[data-short-url]').hidden = !hasShortUrl(form.elements.body_text.value);
  }

  function render() {
    const blocked = gate.busy || loading || uncertain || stale;
    const draft = campaign.status === 'DRAFT';
    setText(root, '[data-status]', statusLabel(campaign.status));
    setText(root, '[data-id]', campaign.campaign_id ? `配信ID：${campaign.campaign_id}` : '新しい下書き');
    setText(root, '[data-from]', draft ? `${ctx.settings.from_name || '未設定'} <${ctx.settings.from_local || '未設定'}@${ctx.config.senderDomain}>` : campaign.from ?? '—');
    setText(root, '[data-reply]', draft ? ctx.settings.reply_to || '指定なし' : campaign.reply_to || '指定なし');
    const notes = [];
    if (campaign.status === 'COMPLETED') notes.push('送信処理が終了しました。失敗・不明・配信停止による除外が含まれる場合があります。下の集計を確認してください。受信トレイへの到達を保証する表示ではありません。');
    if (campaign.pause_reason) notes.push(PAUSE_LABELS[campaign.pause_reason] ?? '停止理由を確認できません。管理者に確認してください。');
    if (campaign.start_error) notes.push({
      START_EXECUTION_FAILED: '開始処理を作成できませんでした。配信は承認済みに戻っています。',
      CREATE_SCHEDULE_FAILED: '予約を作成できませんでした。配信は承認済みに戻っています。',
      START_EXECUTION_UNCONFIRMED: '要確認：開始処理の有無を確認できません。管理者が確認してください。',
      CREATE_SCHEDULE_UNCONFIRMED: '要確認：予約の有無を確認できません。管理者が確認してください。',
    }[campaign.start_error] ?? errorText(new ApiError(campaign.start_error)));
    if (campaign.reject_reason) notes.push(`差戻しの理由：${campaign.reject_reason}`);
    if (campaign.cancel_reason === 'DEADLINE_PASSED') notes.push(`送信期限を過ぎたため中止しました。未送信 ${formatCount(campaign.unsent_count)}件。`);
    if (campaign.schedule_delayed_notified_at) notes.push('予約日時から15分を過ぎても始まらなかったため、管理者へ通知しました。');
    if (campaign.scheduled_at && campaign.status === 'SCHEDULED') notes.push(`予約日時：${formatTime(campaign.scheduled_at)}`);
    if (stale) notes.push('他の人が先に操作しました。入力内容を控えてから画面を読み込み直してください。');
    setText(root, '[data-state-note]', notes.join('\n'));
    for (const name of ['topic', 'subject', 'body_text']) form.elements[name].disabled = !draft || !canSend(ctx.user) || blocked;
    q('[data-save]').disabled = !draft || !canSend(ctx.user) || blocked;
    const primary = primaryAction(campaign, ctx.user, { busy: gate.busy || loading, dirty, stale, uncertain, previewHash: renderedHash, confirmed: q('[data-confirm-content]').checked });
    q('[data-primary]').textContent = primary.action === 'start' && q('[data-mode]').value === 'SCHEDULED' ? '予約する' : primary.label;
    q('[data-primary]').disabled = !primary.enabled;
    setText(root, '[data-primary-reason]', primary.reason);
    const previewAllowed = canOperate(ctx.user) || draft;
    q('[data-preview]').disabled = gate.busy || loading || !previewAllowed;
    const testAllowed = canSend(ctx.user) && ['DRAFT', 'PENDING_APPROVAL', 'APPROVED'].includes(campaign.status) && !!campaign.campaign_id && !dirty && !blocked;
    q('[data-test]').disabled = !testAllowed;
    q('[data-recovery-area]').hidden = !hasRole(ctx.user, 'admin');
    q('[data-recovery]').disabled = !testAllowed || !hasRole(ctx.user, 'admin');
    q('[data-recovery-note]').disabled = q('[data-recovery]').disabled || !q('[data-recovery]').checked;
    setText(root, '[data-test-reason]', testAllowed ? '設定のテスト送信先だけへ送ります。1日の送信件数に数えます。不明分は自動で送り直しません。' : 'テスト送信は管理者・配信担当が、保存済みの下書き・承認待ち・承認済みの配信で行えます。');
    const policy = controlPolicy(campaign, ctx.user, blocked);
    for (const [action, value] of Object.entries(policy)) {
      q(`[data-${action}]`).disabled = !value.enabled;
      q(`[data-${action}]`).title = value.reason;
    }
    q('[data-reject-area]').hidden = campaign.status !== 'PENDING_APPROVAL';
    q('[data-remediation]').hidden = campaign.status !== 'PAUSED' || campaign.pause_reason === 'USER' || !hasRole(ctx.user, 'admin');
    setText(root, '[data-control-reason]', campaign.status === 'PAUSED' ? policy.resume.reason || '再開の前に送信条件を確かめます。一時停止から7日たつと自動で中止します。' : '一時停止・中止をしても、SESがすでに受け付けたメールは取り消せません。');
    q('[data-mode]').disabled = !canSchedule(campaign, ctx.user, blocked);
    q('[data-at]').disabled = q('[data-mode]').disabled || q('[data-mode]').value !== 'SCHEDULED';
    q('[data-hour-warning]').hidden = q('[data-mode]').value !== 'SCHEDULED' || !isOnTheHour(q('[data-at]').value);
    setText(root, '[data-next-at]', campaign.next_attempt_at ? `1日の送信上限で待機中です。再開予定：${formatTime(campaign.next_attempt_at)}。条件を確かめ直してから続きを送ります。` : '');
    setText(root, '[data-updated]', `画面更新：${formatTime(new Date().toISOString())}・配送の集計：${formatTime(stats.observed_at)}`);
    q('[data-progress]').replaceChildren(...progressLines(campaign, stats).flatMap(([label, value]) => [element('dt', label), element('dd', value)]));
    q('[data-review]').hidden = campaign.status !== 'NEEDS_REVIEW' || !hasRole(ctx.user, 'admin');
    q('[data-review-submit]').disabled = blocked || !hasRole(ctx.user, 'admin');
    const editableScope = draft && canSend(ctx.user) || ['PENDING_APPROVAL', 'APPROVED'].includes(campaign.status) && hasRole(ctx.user, 'admin', 'approver');
    q('[data-scope]').disabled = blocked || !editableScope;
    q('[data-forecast-update]').disabled = blocked || !campaign.campaign_id;
    q('[data-reapprove]').hidden = campaign.status !== 'APPROVED' || !hasRole(ctx.user, 'admin', 'approver');
    q('[data-reapprove]').disabled = blocked || renderedHash !== campaign.content_sha256 || !q('[data-confirm-content]').checked || campaign.approval_required !== false && campaign.submitted_by === ctx.user.sub;
    const scope = campaign.approval_scope ?? campaign.proposed_scope;
    setText(root, '[data-approved-scope]', scope ? `${campaign.approval_scope ? '承認済み' : '提案'}：最大${formatCount(scope.max_recipients)}件・${formatTime(scope.send_after)}から${formatTime(scope.send_by)}まで` : '申請時に最大件数と送信期間を提案します。');
    setText(root, '[data-forecast]', `${campaign.started_at ? '残り件数の見込み' : '前日時点の購読者数による概算'}：${scopeDirty && !scopeForecast ? '入力を変更しました。「完了見込みを更新」で確認してください。' : forecastText(scopeForecast ?? campaign.forecast)}`);
    setText(root, '[data-deadline]', campaign.deadline_at ? `送信期限：${formatTime(campaign.deadline_at)}・未送信 ${formatCount(campaign.unsent_count)}件` : '');
    const events = stats.events_status ?? campaign.events_status;
    setText(root, '[data-events]', `配送記録：${events === 'MISSING' ? `欠測の疑い（推定${formatCount(stats.events_missing ?? campaign.events_missing)}件）` : events === 'OK' ? '欠測の判定で問題は見つかっていません' : '件数が少ないため判定していません'}。点検：${formatTime(stats.events_checked_at ?? campaign.events_checked_at)}・最後のSend区間：${formatTime(stats.events_last_seen_at ?? campaign.events_last_seen_at)}`);
    const review = campaign.unknown_review;
    q('[data-unknown-review]').hidden = !review;
    q('[data-unknown-admin]').hidden = review?.status !== 'OPEN' || !hasRole(ctx.user, 'admin');
    q('[data-unknown-submit]').disabled = blocked;
    setText(root, '[data-unknown-status]', review ? `${review.status === 'OPEN' ? '調査中' : '調査終了'}：${formatCount(review.count)}件・開始 ${formatTime(review.opened_at)}／SES の受付を確認：${formatCount(sesAcceptedCount)}件。索引に見つからないことは未受付・未配送の証拠ではありません。` : '');
    q('[data-unknown-decisions]').replaceChildren(...(review?.decisions ?? []).map((d) => element('li', `${formatTime(d.at)}・${d.by}・${d.decision === 'NO_RESEND' ? '送り直さず終了' : '継続'}・SES受付確認 ${formatCount(d.ses_accepted_count)}件・${d.note}`)));
    footer();
  }

  async function fixedPreview() {
    if (!canOperate(ctx.user) || campaign.status === 'DRAFT' || renderedHash === campaign.content_sha256 && renderedHash || fixedLoading) return;
    fixedLoading = true;
    const expected = campaign.content_sha256;
    const expectedVersion = campaign.version;
    try {
      const value = await ctx.api.request(`/campaigns/${campaign.campaign_id}/preview`, { method: 'POST', body: {} });
      if (campaign.version !== expectedVersion || value.content_sha256 !== expected || !/^[a-f0-9]{64}$/.test(expected ?? '')) throw new ApiError('HASH_MISMATCH', 409);
      renderedHash = value.content_sha256;
      q('[data-fixed]').hidden = false;
      setText(root, '[data-fixed-subject]', value.subject);
      setText(root, '[data-fixed-text]', value.text);
      setText(root, '[data-hash]', `内容のハッシュ：${renderedHash.slice(0, 12)}`);
    } finally { fixedLoading = false; }
  }

  function reviewDetails() {
    if (campaign.status !== 'NEEDS_REVIEW' || !hasRole(ctx.user, 'admin')) return;
    if (campaign.review?.reason === 'RESTORED') {
      fillSelect(q('[data-decision]'), [['CANCEL', '中止']]);
      setText(root, '[data-review-range]', '復元の点検で要確認になった配信です。中止だけを選べます。送り直す場合は新しい配信として作り直してください。二重に届く可能性があります。');
      setText(root, '[data-review-recipients]', '復元した進捗からは再開できません。');
      setText(root, '[data-query]', campaign.athena_query ?? '配送の記録を確認してください。');
      reviewRisk();
      return;
    }
    const preparing = campaign.review?.phase === 'prepare' || !Number.isSafeInteger(campaign.chunks_total);
    const old = q('[data-decision]').value;
    fillSelect(q('[data-decision]'), preparing ? [['CANCEL', '中止'], ['RESTART', '最初からやり直す']] : [['CANCEL', '中止'], ['SKIP', '飛ばして再開'], ['RESEND', '送り直して再開']]);
    if ([...q('[data-decision]').options].some((option) => option.value === old)) q('[data-decision]').value = old;
    setText(root, '[data-review-range]', preparing ? '宛先を確定する途中で止まりました。まだ送信は始まっていません。最初からやり直すか、中止してください。' : `対象：バッチ ${campaign.review?.chunk}、位置 ${campaign.review?.index_from}〜${campaign.review?.index_to}（0始まり・最大20件）`);
    setText(root, '[data-review-recipients]', campaign.review_recipients?.join('\n') ?? '対象の宛先はありません。');
    setText(root, '[data-query]', campaign.athena_query ?? '宛先確定前のため、送信の確認は不要です。');
    reviewRisk();
  }

  function reviewRisk() {
    const text = { CANCEL: '残りは送りません。中止した配信は再開できません。', SKIP: '該当の宛先に届かない可能性があります（最大20件）。', RESEND: '該当の宛先に二重に届く可能性があります（最大20件）。配送の記録を確認してください。', RESTART: '宛先の確定からやり直します。' };
    setText(root, '[data-review-risk]', text[q('[data-decision]').value]);
  }

  async function loadFailures(cursor) {
    if (!campaign.campaign_id || failuresLoading) return;
    failuresLoading = true;
    q('[data-failures-next]').disabled = true;
    try {
      const page = await ctx.api.request(`/campaigns/${campaign.campaign_id}/failures`, { query: { limit: 50, cursor } });
      sesAcceptedCount = page.ses_accepted_count;
      render();
      tableRows(q('[data-failures]'), page.items.map((item) => [hasRole(ctx.user, 'admin') ? item.email ?? item.m : item.m, resultLabel(item.r), item.c, formatTime(item.t)]));
      failureCursor = page.cursor;
      failurePageCursor = cursor;
      q('[data-failures-section]').hidden = false;
    } finally { failuresLoading = false; q('[data-failures-next]').disabled = !failureCursor; }
  }

  function populate() {
    for (const name of ['topic', 'subject', 'body_text']) if (campaign[name] !== undefined) form.elements[name].value = campaign[name];
    if (campaign.scheduled_at) { q('[data-mode]').value = 'SCHEDULED'; q('[data-at]').value = jstInput(campaign.scheduled_at); }
    if (!scopeDirty) {
      const scope = campaign.approval_scope ?? campaign.proposed_scope ?? scopeDefaults(campaign.audience_estimate ?? ctx.topics.items.find((t) => t.TopicName === campaign.topic)?.subscribers);
      q('[data-max-recipients]').value = scope.max_recipients;
      q('[data-send-by]').value = jstInput(scope.send_by);
      q('[data-send-after]').value = scope.send_after ? jstInput(scope.send_after) : '';
    }
  }

  async function load(initial = false) {
    if (!id || gate.busy || loading) return;
    loading = true;
    render();
    try {
      await ctx.refreshUser();
      const next = await ctx.api.request(`/campaigns/${id}`);
      if (campaign.campaign_id && next.version !== campaign.version) {
        if (dirty) stale = true;
        if (next.content_sha256 !== campaign.content_sha256 || next.status !== campaign.status) {
          renderedHash = '';
          q('[data-confirm-content]').checked = false;
          q('[data-fixed]').hidden = true;
        }
      }
      campaign = next;
      if (initial || !dirty) populate();
      render();
      try {
        stats = await ctx.api.request(`/campaigns/${id}/stats`);
      } catch (error) { stats = { counts: campaign.counts, metrics: null }; showMessage(root, errorText(error), true); }
      render();
      reviewDetails();
      try { await fixedPreview(); } catch (error) { renderedHash = ''; showMessage(root, errorText(error), true); }
      render();
      await loadFailures(initial ? undefined : failurePageCursor);
    } finally { loading = false; render(); }
  }

  async function perform(fn, { mutation = false } = {}) {
    if (loading) return false;
    return gate.run(async () => {
      render();
      showMessage(root, '');
      try { await fn(); }
      catch (error) {
        if (mutation && isUncertainMutation(error)) uncertain = true;
        if (['STATE_CONFLICT', 'VERSION_CONFLICT', 'HASH_MISMATCH'].includes(error.code)) stale = true;
        showMessage(root, errorText(error), true);
      }
    }).finally(() => render());
  }

  async function action(name, body = {}) {
    const result = await ctx.api.request(`/campaigns/${campaign.campaign_id}/${name}`, { method: 'POST', body });
    campaign = result;
    scopeDirty = false; scopeForecast = undefined;
    stats = { counts: campaign.counts, metrics: null };
    dirty = false;
    renderedHash = '';
    q('[data-confirm-content]').checked = false;
    q('[data-fixed]').hidden = true;
    populate();
    reviewDetails();
    showMessage(root, name === 'start' ? result.status === 'SCHEDULED' ? `予約しました：${formatTime(result.scheduled_at)}` : '開始の要求を受け付けました。配信状況を確認してください。' : '操作を受け付けました。');
    if (result.warnings?.includes('QUOTA_INSUFFICIENT')) showMessage(root, '予約しました。現在はSESの24時間の送信枠が足りません。予約の開始時に条件を確かめ直します。');
    render();
    try { await fixedPreview(); } catch (error) { showMessage(root, errorText(error), true); }
  }

  form.addEventListener('input', () => { if (campaign.status === 'DRAFT') dirty = true; render(); });
  form.addEventListener('change', () => { if (campaign.status === 'DRAFT') dirty = true; render(); });
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (q('[data-save]').disabled) return;
    perform(async () => {
      const draft = validateDraft(Object.fromEntries(['topic', 'subject', 'body_text'].map((name) => [name, form.elements[name].value])));
      if (!campaign.campaign_id) {
        const created = await ctx.api.request('/campaigns', { method: 'POST', body: draft });
        ctx.navigate(`#/send/${created.campaign_id}`);
      } else {
        campaign = await ctx.api.request(`/campaigns/${campaign.campaign_id}`, { method: 'PATCH', body: { version: campaign.version, ...draft } });
        dirty = false;
        showMessage(root, '下書きを保存しました。');
      }
    }, { mutation: true });
  });
  on(root, '[data-preview]', 'click', () => perform(async () => {
    if (campaign.status === 'DRAFT') previewDialog(form.elements.subject.value, form.elements.body_text.value.replace(/\r\n?/g, '\n') + q('[data-footer]').textContent);
    else {
      await fixedPreview();
      previewDialog(q('[data-fixed-subject]').textContent, q('[data-fixed-text]').textContent, renderedHash);
    }
  }));
  on(root, '[data-test]', 'click', () => {
    if (q('[data-test]').disabled) return;
    perform(async () => {
      const body = testSendInput(ctx.user, q('[data-recovery]').checked, q('[data-recovery-note]').value, checkSelect.value);
      if (body.purpose && !await confirmDialog('受入確認の再検証として、設定のテスト送信先だけに送ります。理由を監査記録に残します。')) return;
      const result = await ctx.api.request(`/campaigns/${campaign.campaign_id}/test-send`, { method: 'POST', body });
      const labels = { UNKNOWN: '不明（送り直しません）' };
      showMessage(root, `テスト送信の結果\n${result.results.map((item) => `${visibleAddress(item.email_masked, ctx.user)}：${labels[item.status] ?? resultLabel(item.status)}${item.code === 'PRIOR_UNKNOWN' ? '（前回の結果が不明のため送り直しません）' : ''}`).join('\n')}`);
    }, { mutation: true });
  });
  on(root, '[data-confirm-content]', 'change', render);
  on(root, '[data-recovery]', 'change', render);
  for (const selector of ['[data-mode]', '[data-at]']) on(root, selector, 'change', render);
  on(root, '[data-primary]', 'click', () => {
    const primary = primaryAction(campaign, ctx.user, { busy: gate.busy || loading, dirty, stale, uncertain, previewHash: renderedHash, confirmed: q('[data-confirm-content]').checked });
    if (!primary.enabled) return;
    perform(() => action(primary.action, primary.action === 'approve' ? { ...readScope(), content_sha256: renderedHash } : primary.action === 'start' ? scheduleInput(q('[data-mode]').value, q('[data-at]').value) : readScope()), { mutation: true });
  });
  for (const name of ['pause', 'unschedule', 'resume', 'cancel', 'reject']) on(root, `[data-${name}]`, 'click', () => {
    if (!controlPolicy(campaign, ctx.user, gate.busy || loading || uncertain || stale)[name].enabled) return;
    perform(async () => {
      let body = {};
      if (name === 'cancel' && !await confirmDialog('この配信を中止します。残りは送らず、中止後は再開できません。SESが受け付けたメールは取り消せません。')) return;
      if (name === 'reject') {
        const reason = q('[data-reject-reason]').value.trim();
        if (!reason) throw new ApiError('INVALID_REQUEST', 400, '', ['差戻しの理由']);
        body = { reason };
      }
      if (name === 'resume' && campaign.pause_reason !== 'USER') {
        body = { note: q('[data-remediation-note]').value.trim(), evidence_key: q('[data-evidence]').value.trim() };
        if (!body.note || !body.evidence_key) throw new ApiError('INVALID_REQUEST', 400, '', ['原因・是正内容・確認の証跡']);
      }
      await action(name, body);
    }, { mutation: true });
  });
  on(root, '[data-decision]', 'change', reviewRisk);
  on(root, '[data-review-submit]', 'click', () => {
    if (!hasRole(ctx.user, 'admin') || campaign.status !== 'NEEDS_REVIEW') return;
    perform(async () => {
      const body = reviewInput(campaign, q('[data-decision]').value, q('[data-review-note]').value.trim());
      if (await confirmDialog(q('[data-review-risk]').textContent + ' この判断を確定しますか。')) await action('review', body);
    }, { mutation: true });
  });
  on(root, '[data-failures-next]', 'click', () => perform(() => loadFailures(failureCursor)));
  for (const selector of ['[data-max-recipients]', '[data-send-by]', '[data-send-after]']) on(root, selector, 'input', () => { scopeDirty = true; scopeForecast = undefined; render(); });
  on(root, '[data-forecast-update]', 'click', () => perform(async () => {
    const scope = ['DRAFT', 'PENDING_APPROVAL', 'APPROVED'].includes(campaign.status) ? readScope() : {};
    const value = await ctx.api.request(`/campaigns/${campaign.campaign_id}`, { query: { send_by: scope.send_by, send_after: scope.send_after } });
    scopeForecast = value.forecast;
    if (!scopeForecast) throw new ApiError('MONITORING_UNAVAILABLE');
  }));
  on(root, '[data-reapprove]', 'click', () => perform(() => action('approve', { ...readScope(), content_sha256: renderedHash }), { mutation: true }));
  on(root, '[data-unknown-submit]', 'click', () => {
    if (!hasRole(ctx.user, 'admin') || campaign.unknown_review?.status !== 'OPEN') return;
    perform(async () => {
      const note = q('[data-unknown-note]').value.trim();
      if (!note || [...note].length > 500) throw new ApiError('INVALID_REQUEST', 400, '', ['判断の根拠']);
      await action('unknowns', { decision: q('[data-unknown-decision]').value, note });
      q('[data-unknown-note]').value = '';
      await loadFailures();
    }, { mutation: true });
  });
  on(root, '[data-reload]', 'click', () => ctx.reload());
  populate(); render();
  if (id) {
    await load(true);
    ctx.addCleanup(startPolling(async () => { if (!gate.busy) await load(); }, { onError: (error) => {
      stale = true;
      render();
      showMessage(root, errorText(error), true);
    } }));
  }
}
