import { buildUpdate, campaignUpdate, createExpressions } from '../common/ddb.js';
import { normalizeEmail } from '../common/email.js';
import { AppError } from '../common/http.js';
import { assertSupportedSchema } from '../common/schema.js';
import { unknownReviewFields } from '../common/campaign-lifecycle.js';

export const isConflict = (error) => ['STATE_CONFLICT', 'VERSION_CONFLICT'].includes(error.code) || error.name === 'ConditionalCheckFailedException';
export const output = (action, fields = {}) => ({ action, ...fields });

export async function change(runtime, id, executionArn, statuses, set, match = () => true, remove = []) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const campaign = await runtime.store.get('CAMPAIGN', id);
    assertSupportedSchema(campaign);
    if (!campaign || executionArn && campaign.execution_arn !== executionArn || !statuses.includes(campaign.status) || !match(campaign)) return campaign;
    try {
      return await runtime.store.update('CAMPAIGN', id, campaignUpdate({
        version: campaign.version, from: statuses,
        set: { ...(typeof set === 'function' ? set(campaign) : set), updated_at: new Date(runtime.now()).toISOString() }, remove,
      }));
    } catch (error) { if (!isConflict(error)) throw error; }
  }
  throw new AppError('STATE_CONFLICT', 409, '配信記録が変更されています。');
}

export async function readChunk(runtime, campaign, chunk = campaign.progress.chunk) {
  const response = await runtime.s3.getObject({ Bucket: runtime.dataBucket, Key: `recipients/${campaign.campaign_id}/${String(chunk).padStart(5, '0')}.jsonl` });
  let text;
  if (typeof response.Body === 'string') text = response.Body;
  else if (response.Body?.transformToString) text = await response.Body.transformToString('utf-8');
  else if (response.Body instanceof Uint8Array) text = new TextDecoder('utf-8', { fatal: true }).decode(response.Body);
  else {
    const parts = [];
    for await (const part of response.Body) parts.push(Buffer.from(part));
    text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts));
  }
  const lines = text.trimEnd().split('\n').map((line) => {
    const item = JSON.parse(line);
    if (!item || Object.keys(item).length !== 1 || normalizeEmail(item.e).email !== item.e) throw new Error('Invalid recipient snapshot');
    return item;
  });
  if (lines.length < 1 || lines.length > 200) throw new Error('Invalid snapshot size');
  return lines;
}

export async function flush(runtime, campaignId, executionArn, progress, pending, limiter, lastSendAt, extra = {}, pendingBuckets = {}) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const current = await runtime.store.get('CAMPAIGN', campaignId);
    assertSupportedSchema(current);
    if (!current || current.execution_arn !== executionArn) return current;
    const expressions = createExpressions();
    // 状態条件は付けない。停止・中止後も、受付済みの件数を失わない。
    const ConditionExpression = `${expressions.equals('execution_arn', executionArn)} AND ${expressions.equals('version', current.version)} AND ${expressions.equals('schema_version', 1)}`;
    const counts = { ...current.counts };
    for (const field of ['accepted', 'failed', 'unknown', 'skipped_blocked']) counts[field] = (counts[field] ?? 0) + (pending[field] ?? 0);
    const accepted_buckets = { ...current.accepted_buckets };
    for (const [bucket, count] of Object.entries(pendingBuckets)) accepted_buckets[bucket] = (accepted_buckets[bucket] ?? 0) + count;
    try {
      if (extra.result_keys) extra.result_keys = [...new Set([...(current.result_keys ?? []), ...extra.result_keys])];
      const saved = await runtime.store.update('CAMPAIGN', campaignId, {
        ConditionExpression,
        ...buildUpdate({ set: { ...extra, progress, counts, accepted_buckets, ...(['COMPLETED', 'CANCELLED'].includes(current.status) ? { ...unknownReviewFields({ ...current, counts }, runtime.now()), unsent_count: Math.max(0, (current.recipients_total ?? 0) - ['accepted', 'failed', 'unknown', 'skipped_blocked'].reduce((sum, field) => sum + (counts[field] ?? 0), 0)) } : {}), version: current.version + 1, updated_at: new Date(runtime.now()).toISOString(), ...(lastSendAt ? { last_send_at: lastSendAt } : {}) } }, expressions),
      });
      pending.accepted = 0; pending.failed = 0; pending.unknown = 0; pending.skipped_blocked = 0;
      for (const bucket of Object.keys(pendingBuckets)) delete pendingBuckets[bucket];
      await runtime.lock.save(campaignId, limiter);
      return saved;
    } catch (error) { if (!isConflict(error)) throw error; }
  }
  throw new AppError('STATE_CONFLICT', 409, '進捗を保存できません。');
}

export function currentAction(campaign, executionArn) {
  if (!campaign || campaign.execution_arn !== executionArn) return output('CANCELLED');
  if (campaign.status === 'PAUSED') return output('PAUSED', { version: campaign.version });
  if (campaign.status === 'CANCELLED') return output('CANCELLED');
  return undefined;
}

export async function pause(runtime, campaignId, executionArn, reason, code = reason, limiter, phase = 'send') {
  const saved = await change(runtime, campaignId, executionArn, phase === 'prepare' ? ['QUEUED'] : ['SENDING'], { status: 'PAUSED', pause_reason: reason, pause_phase: phase, paused_at: new Date(runtime.now()).toISOString() });
  if (saved?.execution_arn === executionArn) await runtime.lock.release(campaignId, limiter);
  if (saved?.status === 'PAUSED' && saved.pause_reason === reason) {
    runtime.metrics.emit('Paused', 1, { Reason: reason });
    await runtime.record(campaignId, 'PAUSE', code);
    if (reason !== 'USER') await runtime.notify(code, campaignId);
  }
  return currentAction(saved, executionArn) ?? output('REVIEW', { reason: 'UNEXPECTED_STATUS' });
}

// 連続待機に加え、短い待機・再開・時間切れの反復にも実行単位の上限を設ける。
export const WORKFLOW_STEP_LIMIT = 600;
export async function workflowStep(runtime, id, executionArn, phase) {
  const saved = await change(runtime, id, executionArn, [phase === 'prepare' ? 'QUEUED' : 'SENDING', 'PAUSED'], (current) => ({
    workflow_execution_arn: executionArn,
    workflow_steps: (current.workflow_execution_arn === executionArn ? current.workflow_steps ?? 0 : 0) + 1,
    ...(current.workflow_execution_arn !== executionArn ? { wait_lock_run: 0, throttled_run: 0 } : {}),
  }));
  if (saved?.execution_arn === executionArn && saved.workflow_steps >= WORKFLOW_STEP_LIMIT && ['QUEUED', 'SENDING', 'PAUSED'].includes(saved.status)) return output('REVIEW', { reason: 'WORKFLOW_HISTORY_LIMIT' });
  return currentAction(saved, executionArn);
}

export async function boundedWait(runtime, id, executionArn, action, phase, limiter) {
  const field = action === 'WAIT_LOCK' ? 'wait_lock_run' : 'throttled_run';
  const saved = await change(runtime, id, executionArn, [phase === 'prepare' ? 'QUEUED' : 'SENDING'], (current) => ({ [field]: (current[field] ?? 0) + 1 }));
  const stopped = currentAction(saved, executionArn);
  if (stopped) return stopped;
  if (saved[field] >= (action === 'WAIT_LOCK' ? 288 : 30)) return pause(runtime, id, executionArn, action === 'WAIT_LOCK' ? 'LOCK_WAIT_TIMEOUT' : 'SES_UNSTABLE', undefined, limiter, phase);
  return output(action, action === 'WAIT_LOCK' ? { phase } : {});
}
