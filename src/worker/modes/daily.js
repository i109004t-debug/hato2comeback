import * as dns from 'node:dns/promises';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { currentConfigHash, assertIdentity } from '../../common/acceptance.js';
import { contactPages, allRecords, updateRecord, updateCampaign, timestamp, conflict } from '../../common/records.js';
import { jstDate } from '../../common/time.js';
import { reconcileImport } from '../../common/import-job.js';
import { createMonitoring } from '../../common/monitoring.js';

export async function checkDns(runtime, identity) {
  const resolver = runtime.dns ?? dns;
  const domain = runtime.senderDomain;
  const mail = `bounce.${domain}`;
  const checks = {};
  const observed = {};
  const reasons = new Set();
  let unknown = false;
  const canonical = (value) => value.toLowerCase().replace(/\.$/, '');
  const read = async (method, name) => {
    try { return await resolver[method](name); } catch (error) {
      if (['ENODATA', 'ENOTFOUND', 'NXDOMAIN'].includes(error.code)) return [];
      unknown = true;
      reasons.add('DNS_UNAVAILABLE');
      return [];
    }
  };
  const check = (name, ok) => { checks[name] = ok; if (!ok) reasons.add(name); };
  for (const [label, name] of [['FROM_SPF', domain], ['MAIL_FROM_SPF', mail], ['DMARC', `_dmarc.${domain}`]]) {
    const records = (await read('resolveTxt', name)).map((parts) => parts.join('').trim().replace(/\s+/g, ' ')).sort();
    const selected = records.filter((record) => label === 'DMARC' ? /^v=DMARC1(?:;|\s|$)/i.test(record) : /^v=spf1(?:\s|$)/i.test(record));
    observed[label] = selected;
    if (label === 'DMARC') {
      const fields = Object.fromEntries((selected[0] ?? '').split(';').map((part) => part.trim().split(/\s*=\s*/)));
      check(label, selected.length === 1 && ['none', 'quarantine', 'reject'].includes(fields.p) && fields.aspf !== 's');
    } else check(label, selected.length === 1 && /(?:^|\s)include:amazonses\.com(?:\s|$)/i.test(selected[0]) && /(?:^|\s)[~?-]?all$/i.test(selected[0]));
  }
  const mx = (await read('resolveMx', mail)).map((item) => `${item.priority} ${canonical(item.exchange)}`).sort();
  observed.MAIL_FROM_MX = mx;
  check('MAIL_FROM_MX', mx.length === 1 && mx[0] === '10 feedback-smtp.ap-northeast-1.amazonses.com');
  const a = (await read('resolve4', domain)).sort();
  const fromMx = (await read('resolveMx', domain)).map((item) => `${item.priority} ${canonical(item.exchange)}`).sort();
  observed.FROM_A = a; observed.FROM_MX = fromMx;
  check('FROM_A_OR_MX', a.length > 0 || fromMx.length > 0);
  const tokens = identity?.DkimAttributes?.Tokens ?? [];
  const zone = identity?.DkimAttributes?.SigningHostedZone;
  check('DKIM_RECORDS', tokens.length === 3 && typeof zone === 'string' && zone.length > 0);
  observed.DKIM = [];
  for (const token of [...tokens].sort()) {
    if (!/^[a-z0-9]+$/i.test(token) || !zone) { check('DKIM_RECORDS', false); continue; }
    const values = (await read('resolveCname', `${token}._domainkey.${domain}`)).map(canonical).sort();
    observed.DKIM.push([token, values]);
    if (values.length !== 1 || values[0] !== canonical(`${token}.${zone}`)) check('DKIM_RECORDS', false);
  }
  return {
    status: unknown ? 'UNKNOWN' : reasons.size ? 'FAIL' : 'PASS', checks, reason_codes: [...reasons].sort(),
    dns_config_hash: unknown ? '' : createHash('sha256').update(JSON.stringify(observed)).digest('hex'),
  };
}

async function authentication(runtime) {
  const org = await runtime.store.get('SETTINGS', 'ORG');
  const previous = await runtime.store.get('SETTINGS', 'AUTH_STATUS');
  let identity;
  let result;
  try {
    identity = await runtime.ses.getEmailIdentity({ EmailIdentity: runtime.senderDomain });
    result = await checkDns(runtime, identity);
    try { assertIdentity(identity, runtime.senderDomain); } catch { result.status = result.status === 'UNKNOWN' ? 'UNKNOWN' : 'FAIL'; result.reason_codes.push('AUTH_CHECK_FAILED'); }
  } catch {
    result = { status: 'UNKNOWN', checks: {}, reason_codes: ['AUTH_CHECK_UNAVAILABLE'], dns_config_hash: '' };
  }
  const hash = currentConfigHash(runtime, org ?? {});
  const checked_at = result.status === 'UNKNOWN' ? previous?.checked_at ?? '' : timestamp(runtime);
  await updateRecord(runtime, 'SETTINGS', 'AUTH_STATUS', previous, { ...result, checked_at, attempted_at: timestamp(runtime), domain: runtime.senderDomain, config_hash: hash });
  if (result.status !== 'PASS') await runtime.notify(result.status === 'UNKNOWN' ? 'AUTH_CHECK_UNKNOWN' : 'AUTH_CHECK_FAILED', 'daily');
  if (org?.delivery_check?.status === 'PASS' && (result.status === 'FAIL' || org.delivery_check.config_hash !== hash || result.dns_config_hash && org.delivery_check.dns_config_hash !== result.dns_config_hash)) {
    const reason = result.status === 'FAIL' ? 'AUTH_CHECK_FAILED' : 'CONFIG_CHANGED';
    await updateRecord(runtime, 'SETTINGS', 'ORG', org, { delivery_check: { ...org.delivery_check, status: 'FAIL', invalidated_at: timestamp(runtime), invalidation_reason: reason } });
    await runtime.record('ORG', 'DELIVERY_CHECK_INVALIDATED', reason);
    await runtime.notify('DELIVERY_CHECK_REQUIRED', 'daily');
  }
  runtime.precheck.invalidate();
}

async function backup(runtime) {
  const definition = await runtime.ses.getContactList({ ContactListName: runtime.contactList });
  const topics = definition.Topics ?? [];
  const counts = Object.fromEntries(topics.map((topic) => [topic.TopicName, 0]));
  const lines = [];
  for await (const contacts of contactPages(runtime)) {
    for (const contact of contacts) {
      const row = { EmailAddress: contact.EmailAddress, TopicPreferences: contact.TopicPreferences ?? [], UnsubscribeAll: contact.UnsubscribeAll === true, LastUpdatedTimestamp: contact.LastUpdatedTimestamp ?? null };
      lines.push(JSON.stringify(row));
      const preferences = new Map(row.TopicPreferences.map((item) => [item.TopicName, item.SubscriptionStatus]));
      if (!row.UnsubscribeAll) for (const topic of topics) if ((preferences.get(topic.TopicName) ?? topic.DefaultSubscriptionStatus) === 'OPT_IN') counts[topic.TopicName] += 1;
    }
  }
  await runtime.s3.putObject({ Bucket: runtime.dataBucket, Key: `backups/contacts/${jstDate(runtime.now())}.jsonl.gz`, ContentType: 'application/gzip', Body: gzipSync(lines.length ? lines.join('\n') + '\n' : '') });
  const current = await runtime.store.get('SETTINGS', 'TOPIC_COUNTS');
  await updateRecord(runtime, 'SETTINGS', 'TOPIC_COUNTS', current, { counts, counted_at: timestamp(runtime), total: lines.length });
  await runtime.record('contacts', 'BACKUP', 'DONE');
}

async function account(runtime) {
  const value = await runtime.ses.getAccount({});
  const healthy = value.SendingEnabled === true && value.EnforcementStatus === 'HEALTHY' && (runtime.env !== 'prod' || value.ProductionAccessEnabled === true);
  runtime.metrics.emit('SesSendingEnabled', healthy ? 1 : 0);
  for (const [key, name] of [['Max24HourSend', 'SesMax24HourSend'], ['SentLast24Hours', 'SesSentLast24Hours'], ['MaxSendRate', 'SesMaxSendRate']]) {
    if (!Number.isFinite(value.SendQuota?.[key])) throw new Error('Missing SES quota');
    runtime.metrics.emit(name, value.SendQuota[key]);
  }
  if (!healthy) await runtime.notify('SES_PAUSED', 'daily');
  if (!['BOUNCE', 'COMPLAINT'].every((reason) => value.SuppressionAttributes?.SuppressedReasons?.includes(reason))) await runtime.notify('SUPPRESSION_MISCONFIGURED', 'daily');
}

async function campaigns(runtime) {
  const config = await runtime.config.get();
  for await (const campaign of allRecords(runtime, 'CAMPAIGN')) {
    try {
      if (campaign.status === 'PAUSED' && runtime.now() - Date.parse(campaign.paused_at ?? campaign.updated_at) >= config.pause_timeout_days * 86400000 || ['QUEUED', 'SENDING'].includes(campaign.status) && runtime.now() - Date.parse(campaign.started_at) > config.max_pending_days * 86400000) {
        await updateCampaign(runtime, campaign, [campaign.status], { status: 'CANCELLED', cancel_reason: campaign.status === 'PAUSED' ? 'PAUSE_TIMEOUT' : 'MAX_PENDING_DAYS', completed_at: timestamp(runtime) });
        await runtime.record(campaign.campaign_id, 'CANCEL', 'EXPIRED');
        // workerが動いている可能性があるため、送信ロックは奪わない。
      }
      if (!['COMPLETED', 'CANCELLED'].includes(campaign.status) || campaign.content_erased || !(Date.parse(campaign.completed_at) <= runtime.now() - 365 * 86400000)) continue;
      for (let rev = 1; rev <= (campaign.rev ?? 0); rev += 1) {
        try { await runtime.ses.deleteEmailTemplate({ TemplateName: `pl-c-${campaign.campaign_id}-${rev}` }); } catch (error) { if (error.name !== 'NotFoundException') throw error; }
      }
      const remove = ['subject', 'body_text', 'footer_text', 'from', 'reply_to', 'template_name', 'content_sha256', 'reject_reason', 'cancel_reason', 'review', 'task_token', 'test_holds', 'result_keys'].filter((field) => Object.hasOwn(campaign, field));
      await updateCampaign(runtime, campaign, [campaign.status], { content_erased: true }, remove);
      await runtime.record(campaign.campaign_id, 'CONTENT_ERASE', 'DONE');
    } catch (error) { if (!conflict(error)) throw error; }
  }
}

async function locksAndImports(runtime) {
  const lock = await runtime.contactLock.get();
  for await (const record of allRecords(runtime, 'IMPORT')) {
    if (record.status === 'IMPORTING' || lock?.owner === record.import_id && ['DONE', 'FAILED'].includes(record.status)) await reconcileImport(runtime, record);
    else if (lock?.owner === record.import_id && lock.job_id && ['SUBMITTING', 'NEEDS_REVIEW'].includes(record.status)) {
      const repaired = await updateRecord(runtime, 'IMPORT', record.import_id, record, { status: 'IMPORTING', job_id: lock.job_id });
      await runtime.record(record.import_id, 'IMPORT_JOB_RECOVERED', 'IMPORTING');
      await reconcileImport(runtime, repaired);
    } else if (['RECEIVED', 'VALIDATING', 'SUBMITTING', 'NEEDS_REVIEW'].includes(record.status)) await runtime.notify('IMPORT_NEEDS_REVIEW', record.import_id);
  }
  const current = await runtime.contactLock.get();
  if (current?.owner && runtime.now() - Date.parse(current.acquired_at) > 900000) await runtime.notify('CONTACT_LOCK_STALE', current.owner);
  const sendLock = await runtime.lock.get();
  if (sendLock?.owner && sendLock.expires_at_ms <= runtime.now()) await runtime.notify('SEND_LOCK_EXPIRED', sendLock.owner);
}

export async function daily(event, runtime) {
  const results = {};
  for (const [name, run] of Object.entries({ backup, authentication, account, campaigns, locks: locksAndImports, evidence: async (services) => {
    const monitor = services.monitoring ?? createMonitoring(services);
    await monitor.check({ config: await services.config.get(), recent: true, deliveryValid: false });
  } })) {
    try { await run(runtime); results[name] = 'PASS'; } catch (error) {
      results[name] = 'FAIL';
      await runtime.record('daily', `DAILY_${name.toUpperCase()}`, error.code ?? 'INTERNAL');
      await runtime.notify(error.code ?? 'DAILY_FAILED', 'daily');
    }
  }
  await runtime.record('daily', 'DAILY_COMPLETE', Object.values(results).includes('FAIL') ? 'FAIL' : 'PASS');
  return { date: jstDate(runtime.now()), results };
}
