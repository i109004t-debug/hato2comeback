import { shuffleRecipients } from '../../common/shuffle.js';
import { normalizeEmail } from '../../common/email.js';
import { change, output, currentAction, readChunk } from '../state.js';

export async function prepare(event, runtime) {
  const { campaign_id: id, execution_arn: executionArn } = event;
  const resume = event.resume === true || event.input?.resume === true;
  const started = runtime.now();
  let campaign = await runtime.store.get('CAMPAIGN', id);
  if (campaign?.status === 'CANCELLED') return output('CANCELLED');
  if (!campaign || !['QUEUED', 'SCHEDULED'].includes(campaign.status)) return output('REVIEW', { reason: 'UNEXPECTED_STATUS' });
  if (campaign.execution_arn && campaign.execution_arn !== executionArn && !resume) return output('CANCELLED');
  const previousExecution = campaign.execution_arn;
  campaign = await change(runtime, id, undefined, [campaign.status], { status: 'QUEUED', execution_arn: executionArn }, (current) => current.execution_arn === previousExecution);
  if (campaign?.execution_arn !== executionArn || campaign.status !== 'QUEUED') return currentAction(campaign, executionArn) ?? output('REVIEW', { reason: 'UNEXPECTED_STATUS' });
  const config = await runtime.config.get();
  if (!await runtime.lock.acquire(id, config.lock_ttl_seconds)) return output('WAIT_LOCK', { phase: 'prepare' });
  const fail = async (code) => {
    const saved = await change(runtime, id, executionArn, ['QUEUED'], { status: 'APPROVED', start_error: code, execution_arn: '' });
    await runtime.lock.release(id);
    runtime.metrics.emit('StartFailed', 1);
    await runtime.record(id, 'START_FAILED', code);
    return saved?.status === 'CANCELLED' ? output('CANCELLED') : output('START_FAILED');
  };
  let health = await runtime.precheck.run({ campaign, allowedStatuses: ['QUEUED'], force: true });
  if (!health.ok) return fail(health.code);
  let recipientsTotal;
  let chunksTotal;
  let progress;
  let counts;
  if (resume) {
    if (!Number.isSafeInteger(campaign.chunks_total) || !Number.isSafeInteger(campaign.recipients_total) || !campaign.progress || campaign.progress.chunk < 0 || campaign.progress.index < 0 || campaign.progress.chunk > campaign.chunks_total || campaign.review) return output('REVIEW', { reason: 'INVALID_RESUME' });
    if (campaign.progress.chunk < campaign.chunks_total) {
      const lines = await readChunk(runtime, campaign);
      if (campaign.progress.index > lines.length) return output('REVIEW', { reason: 'INVALID_RESUME' });
    }
    recipientsTotal = campaign.recipients_total; chunksTotal = campaign.chunks_total;
    progress = campaign.progress; counts = campaign.counts;
  } else {
    const recipients = [];
    const seenAddresses = new Set();
    const seenTokens = new Set();
    let excluded = 0;
    let token;
    do {
      const page = await runtime.ses.listContacts({
        ContactListName: runtime.contactList, PageSize: 1000,
        Filter: { FilteredStatus: 'OPT_IN', TopicFilter: { TopicName: campaign.topic, UseDefaultIfPreferenceUnavailable: true } },
        ...(token ? { NextToken: token } : {}),
      });
      if (!Array.isArray(page.Contacts)) throw new Error('Invalid contacts response');
      for (const contact of page.Contacts) {
        if (contact.UnsubscribeAll === true) continue;
        if (contact.TopicPreferences?.some((preference) => preference.TopicName === campaign.topic && preference.SubscriptionStatus !== 'OPT_IN')) continue;
        const email = normalizeEmail(contact.EmailAddress).email;
        if (email !== contact.EmailAddress) return fail('CONFIGURATION_INVALID');
        if (seenAddresses.has(email)) continue;
        seenAddresses.add(email);
        if (runtime.env !== 'prod' && !health.config.nonprod_allowlist.includes(email)) { excluded += 1; continue; }
        recipients.push({ e: email });
        if (recipients.length > health.config.max_recipients_per_campaign) return fail('TOO_MANY_RECIPIENTS');
      }
      token = page.NextToken;
      if (token && seenTokens.has(token)) throw new Error('Repeated contacts cursor');
      if (token) seenTokens.add(token);
      const current = await runtime.store.get('CAMPAIGN', id);
      if (current?.execution_arn !== executionArn || current.status !== 'QUEUED') {
        await runtime.lock.release(id);
        return currentAction(current, executionArn) ?? output('REVIEW', { reason: 'UNEXPECTED_STATUS' });
      }
    } while (token);
    const secret = await runtime.secrets.get('erase-hmac');
    const shuffled = shuffleRecipients(recipients, id, Buffer.from(secret.key, 'base64'));
    recipientsTotal = shuffled.length;
    chunksTotal = Math.ceil(recipientsTotal / health.config.batch_size);
    for (let chunk = 0; chunk < chunksTotal; chunk += 1) {
      await runtime.s3.putObject({ Bucket: runtime.dataBucket, Key: `recipients/${id}/${String(chunk).padStart(5, '0')}.jsonl`, ContentType: 'application/x-ndjson', Body: shuffled.slice(chunk * health.config.batch_size, (chunk + 1) * health.config.batch_size).map((item) => JSON.stringify(item)).join('\n') + '\n' });
    }
    progress = { chunk: 0, index: 0 };
    counts = { accepted: 0, failed: 0, unknown: 0, excluded_allowlist: excluded };
  }
  // 長いスナップショット作成後に期限切れの検査結果で送信を許可しない。
  health = await runtime.precheck.run({ campaign, allowedStatuses: ['QUEUED'], remaining: recipientsTotal, recent: false });
  if (!health.ok) return fail(health.code);
  const saved = await change(runtime, id, executionArn, ['QUEUED'], {
    status: 'SENDING', recipients_total: recipientsTotal, chunks_total: chunksTotal,
    snapshot_batch_size: campaign.snapshot_batch_size ?? health.config.batch_size,
    progress, counts, rate_per_sec: health.rate, started_at: resume ? campaign.started_at : new Date(runtime.now()).toISOString(),
  });
  const stopped = currentAction(saved, executionArn);
  if (stopped) { await runtime.lock.release(id); return stopped; }
  runtime.metrics.emit('PrepareRecipients', recipientsTotal);
  runtime.metrics.emit('PrepareSeconds', (runtime.now() - started) / 1000);
  return output(recipientsTotal === 0 || progress.chunk >= chunksTotal ? 'DONE' : 'SEND');
}
