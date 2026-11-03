import { createSender, buildSendInput } from '../../common/sender.js';
import { pauseReason } from '../../common/precheck.js';
import { change, currentAction, flush, output, pause, readChunk } from '../state.js';

export async function send(event, runtime, context) {
  const { campaign_id: id, execution_arn: executionArn } = event;
  let campaign = await runtime.store.get('CAMPAIGN', id);
  const stopped = currentAction(campaign, executionArn);
  if (stopped) {
    if (campaign?.execution_arn === executionArn) await runtime.lock.release(id);
    return stopped;
  }
  if (campaign.status !== 'SENDING' || campaign.review) return output('REVIEW', { reason: campaign.review ? 'UNRESOLVED_REVIEW' : 'UNEXPECTED_STATUS' });
  if (campaign.progress.chunk >= campaign.chunks_total) return output('DONE');
  const config = await runtime.config.get();
  if (runtime.now() - Date.parse(campaign.started_at) > config.max_pending_days * 86400000) {
    await change(runtime, id, executionArn, ['SENDING'], { status: 'CANCELLED', cancel_reason: 'MAX_PENDING_DAYS' });
    await runtime.lock.release(id);
    return output('CANCELLED');
  }
  const health = await runtime.precheck.run({ campaign, allowedStatuses: ['SENDING'], force: true, checkRatios: campaign.progress.chunk % 5 === 0, recent: true, remaining: 1 });
  if (!health.ok) return pause(runtime, id, executionArn, pauseReason(health.code), health.code);
  const held = await runtime.lock.acquire(id, config.lock_ttl_seconds);
  if (!held) return output('WAIT_LOCK', { phase: 'send' });
  const lines = await readChunk(runtime, campaign);
  let i = campaign.progress.index;
  if (!Number.isSafeInteger(i) || i < 0 || i > lines.length) return output('REVIEW', { reason: 'INVALID_PROGRESS' });
  const chunk = campaign.progress.chunk;
  const start = i;
  const limiter = { interval: 1000 / Math.min(campaign.rate_per_sec, health.rate), next: Math.max(runtime.now(), held.next_send_at_ms ?? 0), ...(Number.isFinite(held.last_send_at_ms) ? { lastStart: held.last_send_at_ms } : {}) };
  const pending = { accepted: 0, failed: 0, unknown: 0 };
  const results = [];
  let unknownRun = 0;
  let lastSendAt;
  const sender = createSender({ ...runtime, health, senderState: campaign.sender_state });
  const sendContext = { owner: id, campaignId: id, executionArn, rate: campaign.rate_per_sec, remaining: 1, checkRatios: chunk % 5 === 0, remainingTime: () => context.getRemainingTimeInMillis() };
  const checkpoint = async (nextChunk, index, extra = {}) => {
    // 結果を先に保存する。S3障害時は未保存の進捗を要確認範囲に含める。
    if (results.length) await runtime.s3.putObject({ Bucket: runtime.dataBucket, Key: `results/${id}/${String(chunk).padStart(5, '0')}-${String(start).padStart(3, '0')}.jsonl`, ContentType: 'application/x-ndjson', Body: results.map((item) => JSON.stringify(item)).join('\n') + '\n' });
    campaign = await flush(runtime, id, executionArn, { chunk: nextChunk, index }, pending, limiter, lastSendAt, { ...extra, sender_state: sender.getState() });
    return currentAction(campaign, executionArn);
  };
  const release = async (action) => {
    if (campaign?.execution_arn === executionArn) await runtime.lock.release(id, limiter);
    return action;
  };
  while (i < lines.length) {
    if (context.getRemainingTimeInMillis() < 15000) {
      const latest = await checkpoint(chunk, i);
      return latest ? release(latest) : output('SEND');
    }
    const input = buildSendInput(campaign, lines[i].e, runtime);
    const result = await sender.trySend(input, limiter, sendContext);
    if (['ACCEPTED', 'FAILED', 'UNKNOWN'].includes(result.type)) {
      pending[result.type.toLowerCase()] += 1;
      runtime.metrics.emit({ ACCEPTED: 'Accepted', FAILED: 'Failed', UNKNOWN: 'Unknown' }[result.type], 1);
      if (result.type !== 'ACCEPTED') results.push({ e: lines[i].e, r: result.type, c: result.code, t: new Date(runtime.now()).toISOString() });
      if (result.type === 'ACCEPTED' || result.type === 'UNKNOWN') lastSendAt = new Date(limiter.lastStart).toISOString();
      if (result.type === 'UNKNOWN') unknownRun += 1;
      if (result.type === 'ACCEPTED') unknownRun = 0;
      i += 1;
      if (unknownRun >= 5) {
        const latest = await checkpoint(chunk, i);
        if (latest) return release(latest);
        return pause(runtime, id, executionArn, 'SES_UNSTABLE', 'SES_UNSTABLE', limiter);
      }
    } else {
      const latest = await checkpoint(chunk, i, result.type === 'WAIT_DAY' ? { next_attempt_at: result.next_attempt_at } : {});
      if (latest) return release(latest);
      if (result.type === 'PAUSE') return pause(runtime, id, executionArn, result.reason, result.code, limiter);
      if (result.type === 'WAIT_DAY') return release(output('WAIT_DAY', { wait_seconds: result.wait_seconds, next_attempt_at: result.next_attempt_at }));
      if (result.type === 'THROTTLED') return output('THROTTLED');
      if (result.type === 'YIELD') return output('SEND');
      if (result.type === 'QUOTA' || result.type === 'SES_PAUSED') return pause(runtime, id, executionArn, result.type, result.code, limiter);
      if (result.type === 'EXPIRED') {
        await change(runtime, id, executionArn, ['SENDING'], { status: 'CANCELLED', cancel_reason: 'MAX_PENDING_DAYS' });
        return release(output('CANCELLED'));
      }
      return output('REVIEW', { reason: result.code });
    }
    if ((i - start) % config.progress_every === 0) {
      const latest = await checkpoint(chunk, i);
      if (latest) return release(latest);
    }
  }
  const latest = await checkpoint(chunk + 1, 0, { next_attempt_at: '' });
  return latest ? release(latest) : output('SEND');
}
