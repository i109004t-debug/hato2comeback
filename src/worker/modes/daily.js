import { createGzip } from 'node:zlib';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { checkDns } from '../../common/dns-auth.js';
import { createHash } from 'node:crypto';
export { checkDns } from '../../common/dns-auth.js';
import { currentConfigHash, assertIdentity, notifyAcceptanceExpiry } from '../../common/acceptance.js';
import { contactPages, allRecords, updateRecord, updateCampaign, timestamp, conflict } from '../../common/records.js';
import { jstDate } from '../../common/time.js';
import { reconcileImport } from '../../common/import-job.js';
import { createMonitoring } from '../../common/monitoring.js';
import { expireCampaign, notifyScheduleDelay, unknownReviewFields, deleteSnapshot } from '../../common/campaign-lifecycle.js';
import { addressHash } from '../../common/log.js';
import { AppError } from '../../common/http.js';
import { ensureContactMetadata, applyContactMetadata } from '../../common/contact-metadata.js';
import { marshall, unmarshall } from '../../common/ddb.js';
import { eraseMatch } from '../../common/erase.js';
import { reviewUnsupportedSchema } from '../../common/schema.js';
import { normalizeEmail } from '../../common/email.js';

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
    const reason = result.status === 'FAIL' ? 'AUTH_CHECK_FAILED' : org.delivery_check.config_hash !== hash ? 'CONFIG_CHANGED' : 'DNS_CHANGED';
    const details = Object.keys(result.dns_item_hashes ?? {}).filter((key) => org.delivery_check.dns_item_hashes?.[key] !== result.dns_item_hashes[key]);
    await updateRecord(runtime, 'SETTINGS', 'ORG', org, { delivery_check: { ...org.delivery_check, status: 'FAIL', invalidated_at: timestamp(runtime), invalidation_reason: reason, invalidation_details: reason === 'DNS_CHANGED' ? details : [] } });
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
  for await (let campaign of allRecords(runtime, 'CAMPAIGN')) {
    try {
      if (await reviewUnsupportedSchema(runtime, campaign)) continue;
      if (['COMPLETED', 'CANCELLED'].includes(campaign.status) && campaign.unknown_review?.status !== 'OPEN' && !campaign.snapshot_deleted_at) {
        await deleteSnapshot(runtime, campaign);
        campaign = await updateCampaign(runtime, campaign, [campaign.status], { snapshot_deleted_at: timestamp(runtime) });
      }
      campaign = await expireCampaign(runtime, campaign, config);
      campaign = await notifyScheduleDelay(runtime, campaign);
      if (campaign.unknown_review?.status === 'OPEN' && runtime.now() - Date.parse(campaign.unknown_review.opened_at) > 3 * 86400000 && (!campaign.unknown_review.notified_at || runtime.now() - Date.parse(campaign.unknown_review.notified_at) >= 7 * 86400000)) {
        campaign = await updateCampaign(runtime, campaign, [campaign.status], { unknown_review: { ...campaign.unknown_review, notified_at: timestamp(runtime) } });
        await runtime.notify('UNKNOWN_REVIEW_OPEN', campaign.campaign_id);
      }
      if (['QUEUED', 'SCHEDULED'].includes(campaign.status) && runtime.now() - Date.parse(campaign.start_requested_at ?? campaign.updated_at ?? campaign.created_at) >= 900000) await checkStartResources(runtime, campaign);
      if (campaign.status === 'PAUSED' && runtime.now() - Date.parse(campaign.paused_at ?? campaign.updated_at) >= config.pause_timeout_days * 86400000) {
        campaign = await updateCampaign(runtime, campaign, [campaign.status], { status: 'CANCELLED', cancel_reason: 'PAUSE_TIMEOUT', completed_at: timestamp(runtime), ...unknownReviewFields(campaign, runtime.now()) });
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
    if (record.status === 'PREVIEW' && Date.parse(record.preview_expires_at) <= runtime.now()) {
      await updateRecord(runtime, 'IMPORT', record.import_id, record, { status: 'EXPIRED' });
      await runtime.s3.deleteObject({ Bucket: runtime.dataBucket, Key: `imports/staging/${record.import_id}.csv` });
    } else if (['DISCARDED', 'EXPIRED'].includes(record.status)) await runtime.s3.deleteObject({ Bucket: runtime.dataBucket, Key: `imports/staging/${record.import_id}.csv` });
    else if (record.status === 'IMPORTING' || lock?.owner === record.import_id && ['DONE', 'FAILED'].includes(record.status)) await reconcileImport(runtime, record);
    else if (lock?.owner === record.import_id && lock.job_id && ['SUBMITTING', 'NEEDS_REVIEW'].includes(record.status)) {
      const repaired = await updateRecord(runtime, 'IMPORT', record.import_id, record, { status: 'IMPORTING', job_id: lock.job_id });
      await runtime.record(record.import_id, 'IMPORT_JOB_RECOVERED', 'IMPORTING');
      await reconcileImport(runtime, repaired);
    } else if (['RECEIVED', 'VALIDATING', 'SUBMITTING', 'APPLYING', 'NEEDS_REVIEW'].includes(record.status)) await runtime.notify('IMPORT_NEEDS_REVIEW', record.import_id);
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
  }, backup, authentication, account, campaigns, locks: locksAndImports, acceptance: notifyAcceptanceExpiry, evidence: async (services) => {
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
