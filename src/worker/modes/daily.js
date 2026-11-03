import * as dns from 'node:dns/promises';
import { createGzip } from 'node:zlib';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createHash } from 'node:crypto';
import { currentConfigHash, assertIdentity } from '../../common/acceptance.js';
import { contactPages, allRecords, updateRecord, updateCampaign, timestamp, conflict } from '../../common/records.js';
import { jstDate } from '../../common/time.js';
import { reconcileImport } from '../../common/import-job.js';
import { createMonitoring } from '../../common/monitoring.js';
import { addressHash } from '../../common/log.js';
import { AppError } from '../../common/http.js';
import { ensureContactMetadata, applyContactMetadata } from '../../common/contact-metadata.js';
import { marshall, unmarshall } from '../../common/ddb.js';
import { eraseMatch } from '../../common/erase.js';
import { reviewUnsupportedSchema } from '../../common/schema.js';
import { normalizeEmail } from '../../common/email.js';

function safeSesSpf(record) {
  const terms = record.toLowerCase().split(/\s+/).slice(1);
  const all = terms.filter((term) => /^[+?~-]?all(?:$|[:/=])/.test(term));
  const broad = terms.some((term) => {
    if (/^[?~-]/.test(term)) return false;
    const mechanism = term.replace(/^\+/, '');
    const ip = /^(ip[46]):[^/]+\/(\d+)$/.exec(mechanism);
    if (ip) return Number(ip[2]) < (ip[1] === 'ip4' ? 8 : 16);
    const host = /^(?:a|mx)(?::[^/]+)?(?:\/(\d+))?(?:\/\/(\d+))?$/.exec(mechanism);
    return host && (host[1] !== undefined && Number(host[1]) < 8 || host[2] !== undefined && Number(host[2]) < 16);
  });
  return !broad && terms.includes('include:amazonses.com') && all.length === 1 && ['~all', '-all'].includes(terms.at(-1));
}

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
    } else check(label, selected.length === 1 && safeSesSpf(selected[0]));
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

export async function authentication(runtime) {
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
  return { status: result.status };
}

async function backup(runtime) {
  const definition = await runtime.ses.getContactList({ ContactListName: runtime.contactList });
  const topics = definition.Topics ?? [];
  const counts = Object.fromEntries(topics.map((topic) => [topic.TopicName, 0]));
  const hmacKey = (await runtime.secrets.get('address-hmac')).key;
  let backfilled = 0;
  let missing = 0;
  let total = 0;
  async function* rows() {
    for await (const contacts of contactPages(runtime)) {
      // 属性はSESの1ページ分だけ保持し、全会員分のMapを作らない。
      const metadata = new Map();
      const erased = new Set();
      const matches = new Map();
      for (const contact of contacts) matches.set(contact.EmailAddress, await eraseMatch(runtime, contact.EmailAddress));
      const hashes = [...new Set(contacts.map((contact) => addressHash(normalizeEmail(contact.EmailAddress).email, hmacKey)))];
      const eraseKeys = [...new Set(matches.values())];
      for (let offset = 0; offset < hashes.length; offset += 50) {
        const keys = [...hashes.slice(offset, offset + 50).map((SK) => marshall({ PK: 'CONTACT_META', SK })), ...eraseKeys.slice(offset, offset + 50).map((SK) => marshall({ PK: 'ERASED', SK }))];
        const response = await runtime.ddb.batchGetItem({ RequestItems: { [runtime.tableName]: { Keys: keys, ConsistentRead: true } } });
        if (Object.values(response.UnprocessedKeys ?? {}).some((item) => item.Keys?.length)) throw new Error('Unprocessed backup metadata keys');
        for (const item of response.Responses?.[runtime.tableName] ?? []) {
          const value = unmarshall(item);
          if (value.PK === 'ERASED' || value.erased) erased.add(value.SK);
          else metadata.set(value.SK, value);
        }
      }
      for (const contact of contacts) {
        const hash = addressHash(normalizeEmail(contact.EmailAddress).email, hmacKey);
        if (erased.has(hash) || erased.has(matches.get(contact.EmailAddress))) {
          // 送信確認後の完全削除とSESの自動登録が競合した場合も、宛先は保存しない。
          try { await runtime.ses.deleteContact({ ContactListName: runtime.contactList, EmailAddress: contact.EmailAddress }); } catch (error) {
            if (error.name !== 'NotFoundException') throw error;
          }
          continue;
        }
        let saved = metadata.get(hash);
        if (!saved && backfilled < 100) {
          backfilled += 1;
          try {
            const full = await runtime.ses.getContact({ ContactListName: runtime.contactList, EmailAddress: contact.EmailAddress });
            saved = await ensureContactMetadata(runtime, { ...full, EmailAddress: contact.EmailAddress });
          } catch (error) {
            if (error.code === 'ERASED_ADDRESS' || error.name === 'NotFoundException') continue;
            // 属性の取得不能でも購読状態は残し、不完全として通知する。
          }
        }
        const effective = applyContactMetadata(contact, saved);
        const complete = saved && saved.registration_state !== 'PENDING';
        if (!complete) missing += 1;
        const row = { EmailAddress: effective.EmailAddress, TopicPreferences: effective.TopicPreferences ?? [], UnsubscribeAll: effective.UnsubscribeAll === true, LastUpdatedTimestamp: contact.LastUpdatedTimestamp ?? null, ...(complete ? { AttributesData: effective.AttributesData } : { HT2MetadataStatus: 'MISSING' }) };
        total += 1;
        const preferences = new Map(row.TopicPreferences.map((item) => [item.TopicName, item.SubscriptionStatus]));
        if (!row.UnsubscribeAll) for (const topic of topics) if ((preferences.get(topic.TopicName) ?? topic.DefaultSubscriptionStatus) === 'OPT_IN') counts[topic.TopicName] += 1;
        yield JSON.stringify(row) + '\n';
      }
    }
  }
  const compressed = [];
  await pipeline(Readable.from(rows()), createGzip(), async (source) => { for await (const chunk of source) compressed.push(chunk); });
  const body = Buffer.concat(compressed);
  const prefix = `backups/contacts/${jstDate(runtime.now())}`;
  const backupStatus = { complete: missing === 0, total, attributes_missing: missing, backfilled, backed_up_at: timestamp(runtime), sha256: createHash('sha256').update(body).digest('hex'), bytes: body.length };
  // 同日の再実行中は、前回のcomplete:trueを新しいデータに適用させない。
  await runtime.s3.putObject({ Bucket: runtime.dataBucket, Key: `${prefix}.manifest.json`, ContentType: 'application/json', Body: JSON.stringify({ complete: false, status: 'WRITING' }) });
  await runtime.s3.putObject({ Bucket: runtime.dataBucket, Key: `${prefix}.jsonl.gz`, ContentType: 'application/gzip', Body: body });
  await runtime.s3.putObject({ Bucket: runtime.dataBucket, Key: `${prefix}.manifest.json`, ContentType: 'application/json', Body: JSON.stringify(backupStatus) });
  const previousBackup = await runtime.store.get('SETTINGS', 'CONTACT_BACKUP');
  await updateRecord(runtime, 'SETTINGS', 'CONTACT_BACKUP', previousBackup, backupStatus);
  const current = await runtime.store.get('SETTINGS', 'TOPIC_COUNTS');
  await updateRecord(runtime, 'SETTINGS', 'TOPIC_COUNTS', current, { counts, counted_at: timestamp(runtime), total });
  if (missing) throw new AppError('BACKUP_ATTRIBUTES_MISSING', 503, '既存連絡先の属性保存を完了してください。');
  await runtime.record('contacts', 'BACKUP', 'DONE');
}

async function account(runtime) {
  const value = await runtime.ses.getAccount({});
  const healthy = value.SendingEnabled === true && value.EnforcementStatus === 'HEALTHY' && (runtime.env !== 'prod' || value.ProductionAccessEnabled === true);
  runtime.metrics.emit('SesSendingEnabled', healthy ? 1 : 0);
  for (const [key, name] of [['Max24HourSend', 'SesMax24HourSend'], ['SentLast24Hours', 'SesSentLast24Hours'], ['MaxSendRate', 'SesMaxSendRate']]) {
    if (!Number.isFinite(value.SendQuota?.[key])) throw new Error('Missing SES quota');
    if (key === 'Max24HourSend' && value.SendQuota[key] === -1) continue;
    runtime.metrics.emit(name, value.SendQuota[key]);
  }
  if (!healthy) await runtime.notify('SES_PAUSED', 'daily');
  if (!['BOUNCE', 'COMPLAINT'].every((reason) => value.SuppressionAttributes?.SuppressedReasons?.includes(reason))) await runtime.notify('SUPPRESSION_MISCONFIGURED', 'daily');
}

async function checkStartResources(runtime, campaign) {
  let warning;
  try {
    const name = campaign.resume_count ? `${campaign.campaign_id}-r${campaign.resume_count}` : campaign.start_execution_name ?? campaign.campaign_id;
    if (campaign.status === 'SCHEDULED') {
      try {
        const schedule = await runtime.scheduler.getSchedule({ Name: campaign.schedule_name ?? `ht2-${name}`, GroupName: runtime.scheduleGroup });
        if (!schedule || typeof schedule !== 'object') throw new Error('Invalid schedule response');
        return;
      } catch (error) { if (error.name !== 'ResourceNotFoundException') throw error; }
    }
    // 発火後に自動削除された予約と、作成されなかった予約を区別する。
    const executionArn = campaign.execution_arn || `${runtime.stateMachineArn.replace(':stateMachine:', ':execution:')}:${name}`;
    try {
      const execution = await runtime.sfn.describeExecution({ executionArn });
      if (!execution || typeof execution.status !== 'string') throw new Error('Invalid execution response');
    } catch (error) {
      if (error.name !== 'ExecutionDoesNotExist') throw error;
      warning = campaign.status === 'QUEUED' ? 'QUEUED_EXECUTION_MISSING' : 'SCHEDULED_SCHEDULE_MISSING';
    }
  } catch { warning = 'START_CHECK_UNAVAILABLE'; }
  if (warning) await runtime.notify(warning, campaign.campaign_id);
}

async function campaigns(runtime) {
  const config = await runtime.config.get();
  for await (const campaign of allRecords(runtime, 'CAMPAIGN')) {
    try {
      if (await reviewUnsupportedSchema(runtime, campaign)) continue;
      if (['QUEUED', 'SCHEDULED'].includes(campaign.status) && runtime.now() - Date.parse(campaign.start_requested_at ?? campaign.updated_at ?? campaign.created_at) >= 900000) await checkStartResources(runtime, campaign);
      if (campaign.status === 'PAUSED' && runtime.now() - Date.parse(campaign.paused_at ?? campaign.updated_at) >= config.pause_timeout_days * 86400000 || ['QUEUED', 'SENDING'].includes(campaign.status) && runtime.now() - Date.parse(campaign.started_at) > config.max_pending_days * 86400000) {
        await updateCampaign(runtime, campaign, [campaign.status], { status: 'CANCELLED', cancel_reason: campaign.status === 'PAUSED' ? 'PAUSE_TIMEOUT' : 'MAX_PENDING_DAYS', completed_at: timestamp(runtime) });
        await runtime.record(campaign.campaign_id, 'CANCEL', 'EXPIRED');
        // workerが動いている可能性があるため、送信ロックは奪わない。
      }
      if (!['COMPLETED', 'CANCELLED'].includes(campaign.status) || campaign.content_erased || !(Date.parse(campaign.completed_at) <= runtime.now() - 365 * 86400000)) continue;
      for (let rev = 1; rev <= (campaign.rev ?? 0); rev += 1) {
        try { await runtime.ses.deleteEmailTemplate({ TemplateName: `ht2-c-${campaign.campaign_id}-${rev}` }); } catch (error) { if (error.name !== 'NotFoundException') throw error; }
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
    if (await reviewUnsupportedSchema(runtime, record)) continue;
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
  for (const [name, run] of Object.entries({ eraseKey: async (services) => {
    let enabled = false;
    try { enabled = (await services.kms.describeKey({ KeyId: services.eraseMacKeyId })).KeyMetadata?.KeyState === 'Enabled'; } catch { /* 取得不能も安全側へ倒す。 */ }
    if (!enabled) throw new AppError('ERASE_KEY_UNAVAILABLE', 503, '完全削除の鍵を確認してください。');
  }, backup, authentication, account, campaigns, locks: locksAndImports, evidence: async (services) => {
    const monitor = services.monitoring ?? createMonitoring(services);
    await monitor.check({ config: await services.config.get(), recent: true, daily: true });
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
