import { AppError } from './http.js';
import { jstDate } from './time.js';

export const remainingRecipients = (campaign) => Math.max(0, (campaign.recipients_total ?? campaign.audience_estimate ?? campaign.approval_scope?.max_recipients ?? 0) - ['accepted', 'failed', 'unknown', 'skipped_blocked'].reduce((sum, name) => sum + (campaign.counts?.[name] ?? 0), 0));

export function campaignDeadline(campaign, config) {
  const approved = Date.parse(campaign.approval_scope?.send_by);
  const pending = Date.parse(campaign.started_at) + config.max_pending_days * 86400000;
  const deadline = Math.min(approved, Number.isFinite(pending) ? pending : Infinity, campaign.deadline_at ? Date.parse(campaign.deadline_at) : Infinity);
  return Number.isFinite(deadline) ? new Date(deadline).toISOString() : null;
}

export function forecastCompletion({ recipients, now, deadline_at, daily_send_cap, reserved_attempts = 0, Max24HourSend, SentLast24Hours, ses_rate_safety_factor, rate_per_sec, ahead = 0, send_after }) {
  const deadline = Date.parse(deadline_at);
  const start = Math.max(now, send_after ? Date.parse(send_after) : now);
  if (![recipients, reserved_attempts, ahead].every((n) => Number.isSafeInteger(n) && n >= 0) || !Number.isSafeInteger(daily_send_cap) || daily_send_cap < 1 || !Number.isFinite(now) || !Number.isFinite(start) || !Number.isFinite(deadline) || deadline > now + 91 * 86400000 || !(Max24HourSend === -1 || Number.isFinite(Max24HourSend) && Max24HourSend >= 0) || !Number.isFinite(SentLast24Hours) || SentLast24Hours < 0 || !(ses_rate_safety_factor > 0 && ses_rate_safety_factor <= 1) || !Number.isFinite(rate_per_sec) || rate_per_sec <= 0) throw new AppError('MONITORING_UNAVAILABLE', 503, '完了見込みを計算できません。');
  let capacity = 0;
  let finish = recipients === 0 ? new Date(start).toISOString() : null;
  let waiting = ahead;
  for (let cursor = start; cursor < deadline;) {
    const day = jstDate(cursor);
    const next = Date.parse(`${day}T00:00:00+09:00`) + 86400000;
    const end = Math.min(next, deadline);
    const today = day === jstDate(now);
    const org = Math.max(0, daily_send_cap - (today ? reserved_attempts : 0));
    const ses = Max24HourSend === -1 ? Infinity : Math.max(0, Max24HourSend - (today ? SentLast24Hours : 0)) * ses_rate_safety_factor;
    const available = Math.floor(Math.min(org, ses, (end - cursor) / 1000 * rate_per_sec));
    const before = Math.min(waiting, available);
    waiting -= before;
    const own = available - before;
    if (!finish && capacity + own >= recipients) finish = new Date(cursor + (before + recipients - capacity) / rate_per_sec * 1000).toISOString();
    capacity += own;
    cursor = end;
  }
  return {
    completes: start < deadline && capacity >= recipients, finish_estimate: finish, capacity_until_deadline: capacity, shortfall: Math.max(0, recipients - capacity),
    assumptions: { recipients, ahead, daily_send_cap, reserved_attempts, Max24HourSend, SentLast24Hours, ses_rate_safety_factor, rate_per_sec, now: new Date(now).toISOString(), deadline_at, send_after: new Date(start).toISOString(), quota_reset: 'JST_DAY_APPROXIMATION' },
  };
}

export async function completionForecast(runtime, campaign, { recipients, deadline_at, send_after, health } = {}) {
  const config = health?.config ?? await runtime.config.get();
  const org = health?.org ?? await runtime.store.get('SETTINGS', 'ORG');
  const quota = health?.quota ?? (await runtime.ses.getAccount({})).SendQuota;
  const daily = await runtime.store.get('DAILY', jstDate(runtime.now()));
  const estimate = await runtime.store.get('SETTINGS', 'TOPIC_COUNTS');
  let ahead = 0;
  for await (const page of runtime.store.queryPages({ KeyConditionExpression: 'PK = :pk', ExpressionAttributeValues: { ':pk': { S: 'CAMPAIGN' } }, ConsistentRead: true })) {
    for (const item of page.items) {
      if (item.campaign_id === campaign.campaign_id || !['QUEUED', 'SENDING', 'PAUSED'].includes(item.status)) continue;
      if (campaign.start_requested_at && item.status === 'QUEUED' && item.start_requested_at > campaign.start_requested_at) continue;
      ahead += remainingRecipients(item);
    }
  }
  const count = recipients ?? (campaign.started_at ? remainingRecipients(campaign) : campaign.audience_estimate ?? estimate?.counts?.[campaign.topic]);
  const scope = campaign.approval_scope ?? campaign.proposed_scope;
  const deadline = deadline_at ?? campaignDeadline(campaign, config) ?? scope?.send_by ?? new Date(runtime.now() + config.max_pending_days * 86400000).toISOString();
  return forecastCompletion({ recipients: count, now: runtime.now(), deadline_at: deadline, send_after: send_after ?? campaign.scheduled_at ?? scope?.send_after, daily_send_cap: config.daily_send_cap, reserved_attempts: daily?.reserved_attempts ?? 0, ...quota, ses_rate_safety_factor: config.ses_rate_safety_factor, rate_per_sec: health?.rate ?? Math.min(org?.max_rate_per_sec, config.max_rate_per_sec, quota?.MaxSendRate * Math.min(0.8, config.ses_rate_safety_factor)), ahead });
}
