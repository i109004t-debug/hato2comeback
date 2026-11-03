import { change, currentAction, output, readChunk } from '../state.js';

export async function finish(event, runtime) {
  const { campaign_id: id, execution_arn: executionArn } = event;
  let campaign = await runtime.store.get('CAMPAIGN', id);
  if (event.outcome === 'START_FAILED' && campaign?.status === 'APPROVED' && campaign.start_error) return output('START_FAILED');
  if (!campaign || campaign.execution_arn !== executionArn) return output('CANCELLED');
  const outcome = event.outcome ?? event.result?.action;
  try {
    if (campaign.status === 'CANCELLED') {
      if (!campaign.completed_at) campaign = await change(runtime, id, executionArn, ['CANCELLED'], { completed_at: new Date(runtime.now()).toISOString() });
      return output('CANCELLED');
    }
    if (outcome === 'START_FAILED') return output('START_FAILED');
    if (outcome === 'CANCELLED') {
      campaign = await change(runtime, id, executionArn, ['PAUSED', 'SENDING', 'QUEUED'], { status: 'CANCELLED', cancel_reason: 'WORKFLOW_CANCELLED', completed_at: new Date(runtime.now()).toISOString() });
      return currentAction(campaign, executionArn) ?? output('REVIEW', { reason: 'UNEXPECTED_STATUS' });
    }
    if (outcome === 'DONE') {
      if (!(campaign.progress?.chunk >= campaign.chunks_total)) return output('REVIEW', { reason: 'INCOMPLETE_PROGRESS' });
      campaign = await change(runtime, id, executionArn, ['SENDING'], { status: 'COMPLETED', completed_at: new Date(runtime.now()).toISOString() });
      return currentAction(campaign, executionArn) ?? output(campaign.status === 'COMPLETED' ? 'DONE' : 'REVIEW');
    }
    const rawReason = event.reason ?? event.result?.reason ?? 'WORKER_FAILED';
    const reason = /^[A-Z][A-Z0-9_]{0,63}$/.test(rawReason) || ['AccessDeniedException', 'MessageRejected', 'MailFromDomainNotVerifiedException', 'NotFoundException', 'BadRequestException'].includes(rawReason) ? rawReason : 'WORKER_FAILED';
    let review = { reason, phase: 'prepare' };
    if (Number.isSafeInteger(campaign.chunks_total) && campaign.progress.chunk < campaign.chunks_total) {
      let size;
      try { size = (await readChunk(runtime, campaign)).length; } catch {
        const batchSize = campaign.snapshot_batch_size ?? 200;
        size = Math.min(batchSize, campaign.recipients_total - campaign.progress.chunk * batchSize);
      }
      review = { chunk: campaign.progress.chunk, index_from: campaign.progress.index, index_to: Math.min(campaign.progress.index + 20, size) - 1, reason };
    } else if (Number.isSafeInteger(campaign.chunks_total)) {
      review = { chunk: campaign.progress.chunk, index_from: campaign.progress.index, index_to: campaign.progress.index - 1, reason };
    }
    // 停止中の異常も記録する。再開時はreviewが残っていれば投入させない。
    campaign = await change(runtime, id, executionArn, ['QUEUED', 'SENDING', 'PAUSED'], { status: 'NEEDS_REVIEW', review });
    if (campaign.status === 'NEEDS_REVIEW') {
      runtime.metrics.emit('NeedsReview', 1);
      await runtime.record(id, 'NEEDS_REVIEW', reason);
      await runtime.notify(reason, id);
      return output('REVIEW');
    }
    return currentAction(campaign, executionArn) ?? output('REVIEW');
  } finally {
    // 新しい実行のロックを古いFinishから解放しない。
    const latest = await runtime.store.get('CAMPAIGN', id);
    if (latest?.execution_arn === executionArn) {
      if (outcome === 'REVIEW' && Number.isFinite(campaign.rate_per_sec) && campaign.rate_per_sec > 0) {
        const held = await runtime.lock.get();
        await runtime.lock.save(id, { next: Math.max(held?.next_send_at_ms ?? 0, runtime.now() + 1000 / campaign.rate_per_sec) });
      }
      await runtime.lock.release(id);
    }
  }
}
