import { updateCampaign, timestamp } from './records.js';
import { campaignDeadline, remainingRecipients } from './forecast.js';

export function unknownReviewFields(campaign, now) {
  const count = campaign.counts?.unknown ?? 0;
  if (count <= 0) return {};
  const previous = campaign.unknown_review;
  if (previous && !(previous.status === 'RESOLVED' && count > previous.count)) return { unknown_review: { ...previous, count } };
  return { unknown_review: { status: 'OPEN', count, opened_at: new Date(now).toISOString(), ...(previous?.decisions ? { decisions: previous.decisions } : {}) } };
}

export async function expireCampaign(runtime, campaign, config, fields = {}) {
  const deadline = campaignDeadline(campaign, config);
  if (!deadline || runtime.now() < Date.parse(deadline) || !['SCHEDULED', 'QUEUED', 'SENDING', 'PAUSED'].includes(campaign.status)) return campaign;
  const saved = await updateCampaign(runtime, campaign, [campaign.status], { ...fields, status: 'CANCELLED', cancel_reason: 'DEADLINE_PASSED', deadline_at: deadline, completed_at: timestamp(runtime), unsent_count: remainingRecipients({ ...campaign, ...fields }), ...unknownReviewFields(campaign, runtime.now()) }, ['task_token']);
  await runtime.notify('DEADLINE_PASSED', campaign.campaign_id);
  if (campaign.task_token) await runtime.sfn.sendTaskFailure({ taskToken: campaign.task_token, error: 'DeadlinePassed' });
  return saved;
}

export async function notifyScheduleDelay(runtime, campaign) {
  if (campaign.started_at || campaign.schedule_delayed_notified_at || !['SCHEDULED', 'QUEUED', 'PAUSED'].includes(campaign.status) || !(runtime.now() - Date.parse(campaign.scheduled_at) >= 900000)) return campaign;
  const saved = await updateCampaign(runtime, campaign, [campaign.status], { schedule_delayed_notified_at: timestamp(runtime) });
  await runtime.notify('SCHEDULE_DELAYED', campaign.campaign_id);
  return saved;
}

export async function deleteSnapshot(runtime, campaign) {
  for (let chunk = 0; chunk < (campaign.chunks_total ?? 0); chunk += 1) await runtime.s3.deleteObject({ Bucket: runtime.dataBucket, Key: `recipients/${campaign.campaign_id}/${String(chunk).padStart(5, '0')}.jsonl` });
}
