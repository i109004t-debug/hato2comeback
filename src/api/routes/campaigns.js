import { createHash } from 'node:crypto';
import { AppError, invalid } from '../../common/http.js';
import { ulid } from '../../common/ids.js';
import { createFooter } from '../../common/footer.js';
import { formatFrom, maskEmail } from '../../common/email.js';
import { addressHash } from '../../common/log.js';
import { assertIndependentApproval, authorize } from '../../common/authz.js';
import { bodyWarnings } from '../../common/validate.js';
import { listRecords, objectText, timestamp, updateCampaign, conflict } from '../../common/records.js';
import { createSender, buildSendInput } from '../../common/sender.js';
import { readChunk } from '../../worker/state.js';

const active = ['APPROVED', 'SCHEDULED', 'QUEUED', 'SENDING', 'PAUSED', 'NEEDS_REVIEW'];
const clean = (campaign) => {
  const { task_token, test_holds, ...value } = campaign;
  return value;
};
const hashContent = (subject, text) => createHash('sha256').update(`${subject}\n\n${text}`).digest('hex');

async function load(ctx) {
  const campaign = await ctx.runtime.store.get('CAMPAIGN', ctx.params.id);
  if (!campaign) throw new AppError('NOT_FOUND', 404, '配信記録がありません。');
  return campaign;
}

function assertStatus(campaign, statuses) {
  if (!statuses.includes(campaign.status)) throw new AppError('STATE_CONFLICT', 409, '配信状態が変更されています。');
}

async function fixed(runtime, campaign) {
  const org = await runtime.store.get('SETTINGS', 'ORG');
  if (!org?.from_local || !org.from_name) throw new AppError('SETTINGS_INCOMPLETE', 422, '差出人と法定表示を設定してください。');
  const footer = createFooter(org, campaign.topic_display);
  return { org, from: formatFrom(org.from_name, org.from_local, runtime.senderDomain), reply_to: org.reply_to ?? '', footer_text: footer, text: campaign.body_text + footer };
}

async function check(ctx, campaign, extra = {}) {
  const result = await ctx.runtime.precheck.run({ campaign, allowedStatuses: [campaign.status], actor_sub: ctx.user.sub, request_id: ctx.requestId, ...extra });
  if (!result.ok) {
    const code = ['EVENTS_MISSING', 'CONTENT_ERROR', 'CAMPAIGN_BOUNCE', 'CAMPAIGN_DELAY'].includes(result.code) ? 'MONITORING_UNAVAILABLE' : result.code;
    throw new AppError(code, result.status, '送信の安全条件を確認できません。');
  }
  return result;
}

async function create({ runtime, body, user, topicDefinitions }) {
  const id = (runtime.id ?? ulid)();
  const campaign = { schema_version: 1, PK: 'CAMPAIGN', SK: id, campaign_id: id, ...body, topic_display: topicDefinitions.find((item) => item.TopicName === body.topic)?.DisplayName ?? body.topic, status: 'DRAFT', version: 0, rev: 0, created_by: user.sub, created_at: timestamp(runtime), updated_at: timestamp(runtime) };
  await runtime.store.put(campaign);
  return { statusCode: 201, data: { ...clean(campaign), warnings: bodyWarnings(body.body_text) } };
}

async function get(ctx) {
  const campaign = await load(ctx);
  const value = clean(campaign);
  if (campaign.status === 'NEEDS_REVIEW' && ctx.user.roles.includes('admin') && campaign.review && campaign.review.phase !== 'prepare' && Number.isSafeInteger(campaign.chunks_total)) {
    const rows = campaign.review.chunk === campaign.chunks_total ? [] : await readChunk(ctx.runtime, campaign, campaign.review.chunk);
    value.review_recipients = rows.slice(campaign.review.index_from, campaign.review.index_to + 1).map((row) => row.e);
    const day = (time) => new Date(time).toISOString().slice(0, 10).replaceAll('-', '/');
    const destinations = value.review_recipients.map((email) => `contains(mail.destination, '${email.replaceAll("'", "''")}')`);
    value.athena_query = `SELECT * FROM ht2_events.ses_events WHERE dt BETWEEN '${day(campaign.started_at ?? campaign.created_at)}' AND '${day(ctx.runtime.now())}' AND element_at(mail.tags, 'campaign')[1] = '${campaign.campaign_id}' AND eventtype = 'Send'${destinations.length ? ` AND (${destinations.join(' OR ')})` : ''} ORDER BY mail.timestamp`;
  }
  return value;
}

async function update(ctx) {
  const campaign = await load(ctx);
  assertStatus(campaign, ['DRAFT']);
  if (campaign.version !== ctx.body.version) throw new AppError('VERSION_CONFLICT', 409, '下書きが変更されています。');
  const { version, ...fields } = ctx.body;
  if (fields.topic) fields.topic_display = ctx.topicDefinitions.find((item) => item.TopicName === fields.topic)?.DisplayName ?? fields.topic;
  return clean(await updateCampaign(ctx.runtime, campaign, ['DRAFT'], fields));
}

async function submit(ctx) {
  const { runtime, user } = ctx;
  const campaign = await load(ctx);
  assertStatus(campaign, ['DRAFT']);
  const f = await fixed(runtime, campaign);
  const rev = (campaign.rev ?? 0) + 1;
  const template_name = `ht2-c-${campaign.campaign_id}-${rev}`;
  const content = { Subject: campaign.subject, Text: f.text };
  try { await runtime.ses.createEmailTemplate({ TemplateName: template_name, TemplateContent: content }); } catch (error) {
    if (error.name !== 'AlreadyExistsException') throw error;
    const stored = (await runtime.ses.getEmailTemplate({ TemplateName: template_name })).TemplateContent;
    if (stored?.Subject !== content.Subject || stored.Text !== content.Text || stored.Html) throw new AppError('HASH_MISMATCH', 409, '固定テンプレートの内容が一致しません。');
  }
  const auto = f.org.approval_required === false;
  const saved = await updateCampaign(runtime, campaign, ['DRAFT'], {
    status: auto ? 'APPROVED' : 'PENDING_APPROVAL', rev, template_name, content_sha256: hashContent(content.Subject, content.Text),
    from: f.from, reply_to: f.reply_to, footer_text: f.footer_text, submitted_by: user.sub, submitted_at: timestamp(runtime),
    approved_by: auto ? 'AUTO' : '', approved_at: auto ? timestamp(runtime) : '',
  });
  if (auto) await ctx.audit('APPROVE', campaign.campaign_id, { approved_by: 'AUTO' });
  return clean(saved);
}

async function approve(ctx) {
  const campaign = await load(ctx);
  assertStatus(campaign, ['PENDING_APPROVAL']);
  assertIndependentApproval(ctx.user, campaign.submitted_by);
  if (ctx.body.content_sha256 !== campaign.content_sha256) throw new AppError('HASH_MISMATCH', 409, '承認する内容が一致しません。');
  return clean(await updateCampaign(ctx.runtime, campaign, ['PENDING_APPROVAL'], { status: 'APPROVED', approved_by: ctx.user.sub, approved_at: timestamp(ctx.runtime) }));
}

async function reject(ctx) {
  const campaign = await load(ctx);
  return clean(await updateCampaign(ctx.runtime, campaign, ['PENDING_APPROVAL'], { status: 'DRAFT', reject_reason: ctx.body.reason }));
}

function decodeTextMime(mime) {
  const normalized = mime.replace(/\r\n/g, '\n');
  const separator = normalized.indexOf('\n\n');
  if (separator < 0) throw new Error('Rendered MIME headers missing');
  const headers = normalized.slice(0, separator).replace(/\n[ \t]+/g, ' ');
  const type = /^Content-Type:\s*([^\n]+)/im.exec(headers)?.[1] ?? 'text/plain';
  let text = normalized.slice(separator + 2);
  if (/^multipart\//i.test(type)) {
    const boundary = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(type);
    if (!boundary) throw new Error('Rendered MIME boundary missing');
    for (const part of text.split(`--${boundary[1] ?? boundary[2]}`).slice(1)) {
      if (part.startsWith('--')) break;
      try { return decodeTextMime(part.replace(/^\n/, '').replace(/\n$/, '')); } catch { /* text/plainを持つパートを探す。 */ }
    }
    throw new Error('Rendered text part missing');
  }
  if (!/^text\/plain(?:;|$)/i.test(type)) throw new Error('Rendered text part missing');
  if (/Content-Transfer-Encoding:\s*base64/i.test(headers)) text = Buffer.from(text.replace(/\s/g, ''), 'base64').toString('utf8');
  else if (/Content-Transfer-Encoding:\s*quoted-printable/i.test(headers)) {
    const raw = text.replace(/=\n/g, '');
    text = Buffer.from(raw.replace(/=([a-f0-9]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16))), 'binary').toString('utf8');
  }
  return text;
}

async function preview(ctx) {
  const campaign = await load(ctx);
  if (campaign.status === 'DRAFT') {
    const f = await fixed(ctx.runtime, campaign);
    return { subject: campaign.subject, text: f.text, warnings: bodyWarnings(campaign.body_text) };
  }
  const result = await ctx.runtime.ses.testRenderEmailTemplate({ TemplateName: campaign.template_name, TemplateData: JSON.stringify({ amazonSESUnsubscribeUrl: '（配信停止のURLがここに入ります）' }) });
  return { subject: campaign.subject, text: decodeTextMime(result.RenderedTemplate), content_sha256: campaign.content_sha256 };
}

async function startExecution(runtime, campaign, name, resume) {
  const input = { campaign_id: campaign.campaign_id, ...(resume === undefined ? {} : { resume }) };
  try { return await runtime.sfn.startExecution({ stateMachineArn: runtime.stateMachineArn, name, input: JSON.stringify(input) }); } catch (error) {
    if (error.name !== 'ExecutionAlreadyExists') throw error;
    throw new AppError('STATE_CONFLICT', 409, '同名の実行が存在するため開始できません。実行結果を確認してください。');
  }
}

function executionArn(runtime, name) {
  return `${runtime.stateMachineArn.replace(':stateMachine:', ':execution:')}:${name}`;
}

async function describeStart(runtime, campaign) {
  try {
    const execution = await runtime.sfn.describeExecution({ executionArn: executionArn(runtime, campaign.start_execution_name ?? campaign.campaign_id) });
    if (!execution || typeof execution.status !== 'string') throw new Error('Invalid execution response');
    return execution;
  } catch (error) {
    if (error.name === 'ExecutionDoesNotExist') return null;
    throw error;
  }
}

async function getStartSchedule(runtime, campaign) {
  try {
    const schedule = await runtime.scheduler.getSchedule({ Name: campaign.schedule_name ?? `ht2-${campaign.start_execution_name ?? campaign.campaign_id}`, GroupName: runtime.scheduleGroup });
    if (!schedule || typeof schedule !== 'object') throw new Error('Invalid schedule response');
    return schedule;
  } catch (error) {
    if (error.name === 'ResourceNotFoundException') return null;
    throw error;
  }
}

async function startFailure(runtime, campaign, code, absent) {
  try {
    await updateCampaign(runtime, campaign, [campaign.status], { status: absent ? 'APPROVED' : campaign.status, start_error: code }, absent ? ['execution_arn', 'schedule_name', 'scheduled_at'] : []);
  } catch (error) { if (!conflict(error)) throw error; }
  throw new AppError('MONITORING_UNAVAILABLE', 503, absent ? '開始処理を作成できませんでした。配信状態を読み込み直してください。' : '開始処理の有無を確認できません。再投入せず管理者が確認してください。');
}

async function nextStart(runtime, campaign) {
  const previous = campaign.start_attempt ?? 0;
  if (!Number.isSafeInteger(previous) || previous < 0 || previous >= Number.MAX_SAFE_INTEGER) throw new AppError('STATE_CONFLICT', 409, '開始回数を確認できません。');
  if (campaign.started_at || Object.values(campaign.counts ?? {}).some((count) => count > 0) || campaign.progress?.chunk > 0 || campaign.progress?.index > 0) throw new AppError('STATE_CONFLICT', 409, '送信履歴があるため新しい配信として開始できません。');
  if (campaign.start_error) {
    let completed;
    const creationFailed = ['START_EXECUTION_FAILED', 'CREATE_SCHEDULE_FAILED'].includes(campaign.start_error);
    try {
      if (campaign.start_error === 'CREATE_SCHEDULE_FAILED' && await getStartSchedule(runtime, campaign)) throw new Error('Schedule exists');
      completed = await describeStart(runtime, campaign);
    } catch {
      throw new AppError('STATE_CONFLICT', 409, '前回の開始処理の終了を確認できません。');
    }
    if (!creationFailed || completed) {
      let input;
      let output;
      try { input = JSON.parse(completed?.input); output = JSON.parse(completed?.output); } catch { /* 終了と未送信を確認できなければ再投入しない。 */ }
      if (completed?.status !== 'SUCCEEDED' || input?.campaign_id !== campaign.campaign_id || output?.campaign_id !== campaign.campaign_id || output?.result?.action !== 'START_FAILED') throw new AppError('STATE_CONFLICT', 409, '前回の開始処理の終了と未送信を確認できません。');
    }
  }
  const start_attempt = Math.max(previous, campaign.start_error || campaign.start_mode ? 1 : 0) + 1;
  const start_execution_name = start_attempt === 1 ? campaign.campaign_id : `${campaign.campaign_id}-s${start_attempt}`;
  return { start_attempt, start_execution_name, execution_arn: executionArn(runtime, start_execution_name) };
}

async function start(ctx) {
  const { runtime, body, user } = ctx;
  let campaign = await load(ctx);
  assertStatus(campaign, ['APPROVED']);
  const health = await check(ctx, campaign, { scheduling: body.mode === 'SCHEDULED' });
  const attempt = await nextStart(runtime, campaign);
  if (body.mode === 'NOW') {
    campaign = await updateCampaign(runtime, campaign, ['APPROVED'], { ...attempt, status: 'QUEUED', start_mode: 'NOW', started_by: user.sub, start_requested_at: timestamp(runtime), start_error: '' });
    try { await startExecution(runtime, campaign, campaign.start_execution_name); } catch (error) {
      if (error.code === 'STATE_CONFLICT') throw error;
      let execution;
      try { execution = await describeStart(runtime, campaign); } catch { return startFailure(runtime, campaign, 'START_EXECUTION_UNCONFIRMED', false); }
      if (execution === null) return startFailure(runtime, campaign, 'START_EXECUTION_FAILED', true);
    }
    return clean(campaign);
  }
  const schedule_name = `ht2-${attempt.start_execution_name}`;
  campaign = await updateCampaign(runtime, campaign, ['APPROVED'], { ...attempt, status: 'SCHEDULED', start_mode: 'SCHEDULED', scheduled_at: new Date(body.at).toISOString(), schedule_name, started_by: user.sub, start_requested_at: timestamp(runtime), start_error: '' });
  const local = new Date(Date.parse(body.at) + 9 * 3600000).toISOString().slice(0, 19);
  const input = {
    Name: schedule_name, GroupName: runtime.scheduleGroup, ScheduleExpression: `at(${local})`, ScheduleExpressionTimezone: 'Asia/Tokyo',
    FlexibleTimeWindow: { Mode: 'OFF' }, ActionAfterCompletion: 'DELETE',
    Target: { Arn: 'arn:aws:scheduler:::aws-sdk:sfn:startExecution', RoleArn: runtime.schedulerRoleArn, RetryPolicy: { MaximumRetryAttempts: 0 }, Input: JSON.stringify({ StateMachineArn: runtime.stateMachineArn, Name: campaign.start_execution_name, Input: JSON.stringify({ campaign_id: campaign.campaign_id }) }) },
  };
  try { await runtime.scheduler.createSchedule(input); } catch (error) {
    let schedule;
    try { schedule = await getStartSchedule(runtime, campaign); } catch { return startFailure(runtime, campaign, 'CREATE_SCHEDULE_UNCONFIRMED', false); }
    if (schedule === null) {
      // 自動削除された予約から既に実行が始まっている可能性も確認する。
      let execution;
      try { execution = await describeStart(runtime, campaign); } catch { return startFailure(runtime, campaign, 'CREATE_SCHEDULE_UNCONFIRMED', false); }
      if (execution !== null) return clean(await load(ctx));
      return startFailure(runtime, campaign, 'CREATE_SCHEDULE_FAILED', true);
    }
    if (schedule.ScheduleExpression !== input.ScheduleExpression || schedule.Target?.Input !== input.Target.Input || schedule.ScheduleExpressionTimezone !== 'Asia/Tokyo') throw new AppError('STATE_CONFLICT', 409, '予約内容が一致しません。');
  }
  return { ...clean(campaign), warnings: [...health.warnings, ...(local.slice(14, 16) === '00' ? ['ON_THE_HOUR'] : [])] };
}

async function deleteSchedule(ctx, campaign) {
  try { await ctx.runtime.scheduler.deleteSchedule({ Name: campaign.schedule_name, GroupName: ctx.runtime.scheduleGroup }); } catch (error) {
    if (error.name !== 'ResourceNotFoundException') throw error;
    const current = await load(ctx);
    if (['QUEUED', 'SENDING', 'PAUSED', 'NEEDS_REVIEW', 'COMPLETED'].includes(current.status)) throw new AppError('ALREADY_STARTED', 409, '配信は既に開始されています。');
  }
}

async function unschedule(ctx) {
  const campaign = await load(ctx);
  if (['QUEUED', 'SENDING', 'PAUSED', 'NEEDS_REVIEW', 'COMPLETED'].includes(campaign.status)) throw new AppError('ALREADY_STARTED', 409, '配信は既に開始されています。');
  assertStatus(campaign, ['SCHEDULED']);
  await deleteSchedule(ctx, campaign);
  return clean(await updateCampaign(ctx.runtime, campaign, ['SCHEDULED'], { status: 'APPROVED' }, ['schedule_name', 'scheduled_at']));
}

async function pause(ctx) {
  return clean(await updateCampaign(ctx.runtime, await load(ctx), ['SENDING'], { status: 'PAUSED', pause_reason: 'USER', paused_at: timestamp(ctx.runtime) }));
}

async function resume(ctx) {
  const campaign = await load(ctx);
  assertStatus(campaign, ['PAUSED']);
  authorize(ctx.user, 'campaigns.resume', campaign);
  const config = await ctx.runtime.config.get();
  if (ctx.runtime.now() - Date.parse(campaign.paused_at ?? campaign.updated_at) >= config.pause_timeout_days * 86400000) throw new AppError('STATE_CONFLICT', 409, '一時停止の期限を過ぎています。');
  if (campaign.pause_reason !== 'USER') {
    if (!ctx.body.note || !ctx.body.evidence_key) throw invalid('note', 'REMEDIATION_REQUIRED');
    try { await ctx.runtime.s3.headObject({ Bucket: ctx.runtime.dataBucket, Key: ctx.body.evidence_key }); } catch { throw invalid('evidence_key', 'NOT_FOUND'); }
  }
  await check(ctx, campaign, { force: true });
  let saved = await updateCampaign(ctx.runtime, campaign, ['PAUSED'], { status: campaign.pause_phase === 'prepare' ? 'QUEUED' : 'SENDING', pause_reason: '', wait_lock_run: 0, throttled_run: 0, resumed_at: timestamp(ctx.runtime) });
  await ctx.audit('RESUME', campaign.campaign_id, { previous_reason: campaign.pause_reason, note: ctx.body.note ?? '', evidence_key: ctx.body.evidence_key ?? '' });
  if (campaign.task_token) {
    await ctx.runtime.sfn.sendTaskSuccess({ taskToken: campaign.task_token, output: '{}' });
    // 新しい停止のトークンを消さず、成功済みの古いトークンだけを除去する。
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const current = await load(ctx);
      if (current.task_token !== campaign.task_token) break;
      try { saved = await updateCampaign(ctx.runtime, current, [current.status], {}, ['task_token']); break; } catch (error) { if (!conflict(error)) throw error; }
    }
  }
  return clean(saved);
}

async function cancel(ctx) {
  const campaign = await load(ctx);
  assertStatus(campaign, active);
  if (campaign.status === 'SCHEDULED') await deleteSchedule(ctx, campaign);
  const saved = await updateCampaign(ctx.runtime, campaign, [campaign.status], { status: 'CANCELLED', cancel_reason: ctx.body.reason ?? 'USER', completed_at: timestamp(ctx.runtime) }, ['task_token']);
  if (campaign.task_token) await ctx.runtime.sfn.sendTaskFailure({ taskToken: campaign.task_token, error: 'Cancelled' });
  return clean(saved);
}

async function review(ctx) {
  const { runtime, body } = ctx;
  let campaign = await load(ctx);
  assertStatus(campaign, ['NEEDS_REVIEW']);
  if (body.decision === 'CANCEL') return cancel({ ...ctx, body: { reason: body.note } });
  const preparing = campaign.review?.phase === 'prepare' || !Number.isSafeInteger(campaign.chunks_total);
  let progress;
  if (preparing) {
    if (body.resume !== false) throw invalid('resume', 'PREPARE_RESTART_ONLY');
  } else {
    if (body.resume === false) throw invalid('resume', 'SNAPSHOT_REQUIRED');
    const range = campaign.review;
    if (!range || !Number.isSafeInteger(range.chunk) || !Number.isSafeInteger(range.index_from) || !Number.isSafeInteger(range.index_to) || range.chunk < 0 || range.chunk > campaign.chunks_total || range.index_from < 0 || range.index_to < range.index_from - 1 || range.index_to - range.index_from >= 20) throw new AppError('STATE_CONFLICT', 409, '要確認の範囲を確認できません。');
    const rows = range.chunk === campaign.chunks_total ? [] : await readChunk(runtime, campaign, range.chunk);
    if (range.index_from > rows.length || range.index_to >= rows.length) throw new AppError('STATE_CONFLICT', 409, '要確認の範囲が不正です。');
    progress = { chunk: range.chunk, index: body.decision === 'SKIP' ? range.index_to + 1 : range.index_from };
  }
  await check(ctx, campaign, { force: true });
  const n = (campaign.resume_count ?? 0) + 1;
  const previousReview = campaign.review;
  campaign = await updateCampaign(runtime, campaign, ['NEEDS_REVIEW'], { status: 'QUEUED', resume_count: n, ...(progress ? { progress } : {}), execution_arn: '' }, ['review', 'task_token']);
  await ctx.audit('REVIEW_DECISION', campaign.campaign_id, { decision: body.decision, note: body.note, review: previousReview ?? {}, restart_prepare: preparing });
  await startExecution(runtime, campaign, `${campaign.campaign_id}-r${n}`, !preparing);
  return clean(campaign);
}

async function testSend(ctx) {
  const { runtime } = ctx;
  const recovery = ctx.body.purpose === 'ACCEPTANCE_RECOVERY';
  if (recovery) {
    if (!ctx.user.roles.includes('admin')) throw new AppError('FORBIDDEN', 403, '受入確認の復旧テストは管理者だけが実行できます。');
    if (!ctx.body.note?.trim()) throw invalid('note', 'REMEDIATION_REQUIRED');
  }
  let campaign = await load(ctx);
  assertStatus(campaign, ['DRAFT', 'PENDING_APPROVAL', 'APPROVED']);
  const org = await runtime.store.get('SETTINGS', 'ORG');
  const recipients = org?.test_recipients ?? [];
  if (!recipients.length || recipients.length > 5) throw new AppError('SETTINGS_INCOMPLETE', 422, 'テスト送信先を設定してください。');
  const config = await runtime.config.get();
  for (const email of recipients) {
    if (runtime.env !== 'prod' && !config.nonprod_allowlist.includes(email)) throw new AppError('RECIPIENT_NOT_ALLOWED_IN_ENV', 422, 'この環境で許可されていない宛先です。');
    let contact;
    try { contact = await runtime.ses.getContact({ ContactListName: runtime.contactList, EmailAddress: email }); } catch (error) { if (error.name !== 'NotFoundException') throw error; }
    if (!contact || contact.UnsubscribeAll || !contact.TopicPreferences?.some((entry) => entry.TopicName === campaign.topic && entry.SubscriptionStatus === 'OPT_IN')) throw new AppError('TEST_RECIPIENT_NOT_REGISTERED', 422, 'テスト送信先の登録と購読を確認してください。');
  }
  if (recovery) await ctx.audit('ACCEPTANCE_RECOVERY_TEST', campaign.campaign_id, { purpose: ctx.body.purpose, note: ctx.body.note });
  const health = await check(ctx, campaign, { test: true, acceptanceRecovery: recovery, remaining: recipients.length });
  const f = campaign.status === 'DRAFT' ? await fixed(runtime, campaign) : undefined;
  const owner = `test:${ctx.requestId}`;
  const held = await runtime.lock.acquire(owner, config.lock_ttl_seconds);
  if (!held) throw new AppError('SENDING_IN_PROGRESS', 409, '別の配信が送信中です。');
  const limiter = { interval: 1000 / health.rate, next: Math.max(runtime.now(), held.next_send_at_ms ?? 0), ...(Number.isFinite(held.last_send_at_ms) ? { lastStart: held.last_send_at_ms } : {}) };
  const precheck = recovery ? { ...runtime.precheck, run: (options) => runtime.precheck.run({ ...options, acceptanceRecovery: options.test === true }) } : runtime.precheck;
  const sender = createSender({ ...runtime, precheck, health });
  const results = [];
  let stop = false;
  try {
    for (const email of recipients) {
      const hash = addressHash(email, runtime.hmacKey);
      if (stop || ctx.context.getRemainingTimeInMillis?.() < 15000 || campaign.test_holds?.includes(hash)) { results.push({ email_masked: maskEmail(email), status: 'NOT_ATTEMPTED', ...(campaign.test_holds?.includes(hash) ? { code: 'PRIOR_UNKNOWN' } : {}) }); continue; }
      campaign = await updateCampaign(runtime, campaign, [campaign.status], { test_holds: [...(campaign.test_holds ?? []), hash] });
      const input = buildSendInput(f ? { ...campaign, from: f.from, reply_to: f.reply_to } : campaign, email, { ...runtime, test: true, ...(f ? { simple: { subject: campaign.subject, text: f.text } } : {}) });
      const result = await sender.trySend(input, limiter, { owner, test: true, remainingTime: () => ctx.context.getRemainingTimeInMillis?.() ?? 29000, rate: health.rate });
      if (result.type !== 'UNKNOWN') campaign = await updateCampaign(runtime, campaign, [campaign.status], { test_holds: campaign.test_holds.filter((item) => item !== hash) });
      results.push({ email_masked: maskEmail(email), status: ['ACCEPTED', 'UNKNOWN', 'FAILED', 'SKIPPED'].includes(result.type) ? result.type : 'NOT_ATTEMPTED', ...(result.code ? { code: result.code } : {}) });
      stop = !['ACCEPTED', 'FAILED', 'SKIPPED'].includes(result.type);
    }
    await ctx.audit('TEST_SEND', campaign.campaign_id, { results, ...(recovery ? { purpose: ctx.body.purpose } : {}) });
    return { results };
  } finally { await runtime.lock.release(owner, limiter); }
}

async function stats(ctx) {
  const campaign = await load(ctx);
  if (!campaign.started_at) return { counts: campaign.counts ?? {}, metrics: null };
  const cached = ctx.runtime.statsCache.get(campaign.campaign_id);
  if (cached && ctx.runtime.now() < cached.expires) return { ...cached.value, counts: campaign.counts };
  const names = ['Send', 'Delivery', 'Bounce', 'Complaint', 'DeliveryDelay', 'Subscription', 'Reject', 'RenderingFailure'];
  const queries = names.map((MetricName, index) => ({ Id: `m${index}`, MetricStat: { Metric: { Namespace: 'AWS/SES', MetricName, Dimensions: [{ Name: 'campaign', Value: campaign.campaign_id }] }, Period: ctx.runtime.now() - Date.parse(campaign.started_at) <= 15 * 86400000 ? 3600 : 86400, Stat: 'Sum' }, ReturnData: true }));
  const points = names.map(() => []);
  let token;
  const seen = new Set();
  const started = ctx.runtime.now();
  do {
    const page = await ctx.runtime.cloudwatch.getMetricData({ StartTime: new Date(campaign.started_at), EndTime: new Date(started), MetricDataQueries: queries, ...(token ? { NextToken: token } : {}) });
    if (page.Messages?.length) throw new AppError('MONITORING_UNAVAILABLE', 503, '結果を取得できません。');
    for (let i = 0; i < names.length; i += 1) {
      const result = page.MetricDataResults?.find((item) => item.Id === `m${i}`);
      if (!(result?.StatusCode === 'Complete' || page.NextToken && result?.StatusCode === 'PartialData') || !Array.isArray(result.Values) || result.Values.some((value) => !Number.isFinite(value) || value < 0)) throw new AppError('MONITORING_UNAVAILABLE', 503, '結果を取得できません。');
      points[i].push(...result.Values);
    }
    token = page.NextToken;
    if (token && seen.has(token)) throw new AppError('MONITORING_UNAVAILABLE', 503, '結果を取得できません。');
    if (token) seen.add(token);
  } while (token);
  const value = { counts: campaign.counts ?? {}, metrics: Object.fromEntries(names.map((name, i) => [name, points[i].length ? points[i].reduce((a, b) => a + b, 0) : null])), observed_at: timestamp(ctx.runtime) };
  ctx.runtime.statsCache.set(campaign.campaign_id, { value, expires: started + 60000 });
  return value;
}

async function failures(ctx) {
  const campaign = await load(ctx);
  let offset = 0;
  if (ctx.query.cursor) {
    const decoded = Buffer.from(ctx.query.cursor, 'base64url').toString('utf8');
    if (!/^\d+$/.test(decoded)) throw invalid('cursor');
    offset = Number(decoded);
    if (!Number.isSafeInteger(offset)) throw invalid('cursor');
  }
  const rows = [];
  for (const key of campaign.result_keys ?? []) {
    if (!new RegExp(`^results/${campaign.campaign_id}/[0-9]{5}-[0-9]{3}\\.jsonl$`).test(key)) throw new Error('Invalid result key');
    let text;
    try { text = await objectText(await ctx.runtime.s3.getObject({ Bucket: ctx.runtime.dataBucket, Key: key })); } catch (error) {
      if (['NoSuchKey', 'NotFound'].includes(error.name)) continue;
      throw error;
    }
    for (const line of text.trimEnd().split('\n').filter(Boolean)) {
      const item = JSON.parse(line);
      rows.push({ a: item.a, m: item.m, r: item.r, c: item.c, t: item.t, ci: item.ci, ix: item.ix });
    }
  }
  const end = offset + ctx.query.limit;
  return { items: rows.slice(offset, end), cursor: end < rows.length ? Buffer.from(String(end)).toString('base64url') : null };
}

export default {
  'campaigns.list': async ({ runtime, query }) => { const page = await listRecords(runtime, 'CAMPAIGN', query); return { ...page, items: page.items.map(clean) }; },
  'campaigns.create': create, 'campaigns.get': get, 'campaigns.update': update, 'campaigns.preview': preview,
  'campaigns.submit': submit, 'campaigns.approve': approve, 'campaigns.reject': reject, 'campaigns.start': start,
  'campaigns.unschedule': unschedule, 'campaigns.pause': pause, 'campaigns.resume': resume, 'campaigns.cancel': cancel,
  'campaigns.review': review, 'campaigns.test-send': testSend, 'campaigns.stats': stats, 'campaigns.failures': failures,
};
