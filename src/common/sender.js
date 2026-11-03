import { createDdb, marshall, key } from './ddb.js';
import { createTime, jstDate, nextJstDayAt0005, unixSeconds } from './time.js';
import { normalizeEmail } from './email.js';
import { pauseReason } from './precheck.js';
import { contactMetadataKey, contactBlocked } from './contact-metadata.js';

export function classifySendError(error) {
  const status = error.$metadata?.httpStatusCode;
  const name = error.name;
  const code = /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name ?? '') ? name : 'SES_ERROR';
  if (!Number.isInteger(status) || status >= 500) return { type: 'UNKNOWN', code };
  if (status < 400 || status >= 500) return { type: 'UNKNOWN', code };
  if (/daily.{0,30}(?:message.{0,10})?quota|24.{0,10}hour.{0,30}(?:quota|limit)/i.test(error.message ?? '')) return { type: 'QUOTA', code: 'QUOTA' };
  if (['SendingPausedException', 'AccountSuspendedException'].includes(name)) return { type: 'SES_PAUSED', code };
  if (name === 'TooManyRequestsException' || name === 'ThrottlingException' && /Maximum sending rate exceeded/i.test(error.message ?? '')) return { type: 'RATE_LIMIT', code };
  if (name === 'BadRequestException' && /(?:email|e-mail|recipient|address).{0,50}(?:invalid|malformed|format|syntax)|(?:invalid|malformed).{0,50}(?:email|e-mail|recipient|address)/i.test(error.message ?? '')) return { type: 'FAILED', code };
  return { type: 'CONFIG_ERROR', code };
}

export function buildSendInput(campaign, email, { contactList, configSet, test = false, simple } = {}) {
  if (normalizeEmail(email).email !== email || !contactList || !configSet || !campaign.from || /[\r\n]/.test(campaign.from)) throw new TypeError('Invalid send input');
  return {
    FromEmailAddress: campaign.from, Destination: { ToAddresses: [email] },
    ...(campaign.reply_to ? { ReplyToAddresses: [campaign.reply_to] } : {}),
    Content: simple ? { Simple: { Subject: { Data: simple.subject, Charset: 'UTF-8' }, Body: { Text: { Data: simple.text, Charset: 'UTF-8' } } } } : { Template: { TemplateName: campaign.template_name, TemplateData: '{}' } },
    ListManagementOptions: { ContactListName: contactList, TopicName: campaign.topic },
    ConfigurationSetName: configSet, EmailTags: [{ Name: 'campaign', Value: test ? 'test' : campaign.campaign_id }],
  };
}

export function createSender(deps) {
  const { ses, lock, precheck, config, tableName, ddb } = deps;
  const store = deps.store ?? createDdb(deps);
  const { now, sleep } = createTime(deps);
  const random = deps.random ?? Math.random;
  let health = deps.health;
  let fingerprint = health?.ok ? JSON.stringify(health.config) : undefined;
  let badCode = deps.senderState?.bad_code;
  let badRun = deps.senderState?.bad_run ?? 0;
  const waitDay = () => {
    const next_attempt_at = nextJstDayAt0005(now());
    return { type: 'WAIT_DAY', next_attempt_at, wait_seconds: Math.max(1, Math.ceil((Date.parse(next_attempt_at) - now()) / 1000)) };
  };
  const pause = (code) => ({ type: 'PAUSE', reason: pauseReason(code), code });
  const guard = async (context, limiter) => {
    if (context.remainingTime && context.remainingTime() < 15000) return { type: 'YIELD' };
    const configReadAt = now();
    const currentConfig = await config.get();
    const campaign = context.test ? undefined : await store.get('CAMPAIGN', context.campaignId);
    if (!context.test) {
      if (!campaign || campaign.execution_arn !== context.executionArn) return pause('EXECUTION_CHANGED');
      if (campaign.schema_version !== 1) return { type: 'CONFIG_ERROR', code: 'UNSUPPORTED_SCHEMA' };
      if (campaign.status !== 'SENDING') return pause(campaign.status === 'PAUSED' ? campaign.pause_reason : 'STATE_CHANGED');
      if (campaign.review) return { type: 'CONFIG_ERROR', code: 'UNRESOLVED_REVIEW' };
      if (!Number.isFinite(Date.parse(campaign.started_at)) || Date.parse(campaign.started_at) > now()) return { type: 'CONFIG_ERROR', code: 'INVALID_START' };
      if (now() - Date.parse(campaign.started_at) > currentConfig.max_pending_days * 86400000) return { type: 'EXPIRED' };
    }
    if (!currentConfig.sending_enabled) return pause('SENDING_DISABLED');
    if (deps.env !== 'prod' && !currentConfig.nonprod_allowlist.includes(context.address)) return { type: 'CONFIG_ERROR', code: 'RECIPIENT_NOT_ALLOWED_IN_ENV' };
    const held = await lock.get();
    // 10秒のAPI応答待ちの間も、別所有者に期限切れロックを取らせない。
    if (!held || held.owner !== context.owner || !(held.expires_at_ms > now() + 10000)) return pause('LOCK_LOST');
    const changed = JSON.stringify(currentConfig);
    if (!health || fingerprint !== changed || now() - health.checkedAt >= Math.min(60, currentConfig.health_check_seconds) * 1000) {
      health = await precheck.run({ campaign, allowedStatuses: ['SENDING'], test: context.test, remaining: context.remaining ?? 1, force: true, recent: false, checkRatios: context.checkRatios });
      fingerprint = changed;
    }
    if (!health.ok) return pause(health.code);
    if (!(held.expires_at_ms > now() + 10000)) return pause('LOCK_LOST');
    if (!(health.quotaRemaining >= 1)) return { type: 'QUOTA', code: 'QUOTA_INSUFFICIENT' };
    const interval = 1000 / Math.min(health.rate, currentConfig.max_rate_per_sec, context.rate ?? Infinity);
    if (!Number.isFinite(interval) || interval <= 0) return pause('CONFIGURATION_INVALID');
    limiter.interval = interval;
    if (Number.isFinite(limiter.lastStart)) limiter.next = Math.max(limiter.next, limiter.lastStart + interval);
    return { config: currentConfig, campaign, held, checkedAt: configReadAt };
  };
  const reserve = async (cap) => {
    for (;;) {
      const day = jstDate(now());
      try {
        await ddb.updateItem({
          TableName: tableName, Key: key('DAILY', day),
          UpdateExpression: 'SET #ttl = :ttl ADD #reserved :one',
          ConditionExpression: 'attribute_not_exists(#reserved) OR #reserved < :cap',
          ExpressionAttributeNames: { '#reserved': 'reserved_attempts', '#ttl': 'expires_at' },
          ExpressionAttributeValues: marshall({ ':one': 1, ':cap': cap, ':ttl': unixSeconds(Date.parse(`${day}T00:00:00+09:00`)) + 8 * 86400 }),
        });
      } catch (error) {
        if (error.name === 'ConditionalCheckFailedException') return waitDay();
        // 障害と上限到達を混同しない。呼出元を異常終了させて要確認にする。
        throw error;
      }
      if (jstDate(now()) === day) return { day };
    }
  };
  const beforeAttempt = async (context, limiter) => {
    let reservation;
    for (;;) {
      const checked = await guard(context, limiter);
      if (checked.type) return checked;
      const wait = Math.max(0, limiter.next - now());
      if (wait > 0) {
        if (context.remainingTime && context.remainingTime() - wait < 15000) return { type: 'YIELD' };
        await sleep(Math.min(wait, 10000));
        continue;
      }
      if (!reservation || reservation.day !== jstDate(now())) {
        reservation = await reserve(checked.config.daily_send_cap);
        if (reservation.type) return reservation;
        continue;
      }
      // 予約中の停止・監視期限超過・日次上限引下げもAPI開始前に反映する。
      const daily = await store.get('DAILY', reservation.day);
      if (!Number.isSafeInteger(daily?.reserved_attempts)) return pause('MONITORING_UNAVAILABLE');
      if (daily.reserved_attempts > checked.config.daily_send_cap) return waitDay();
      const final = await guard(context, limiter);
      if (final.type) return final;
      if (await contactBlocked({ ...deps, store }, context.address, context.topic)) return { type: 'SKIPPED', code: 'CONTACT_BLOCKED' };
      // 設定取得から5秒以上かかった場合は、許可を使い回さず検査をやり直す。
      if (now() >= (config.validUntil?.() ?? final.checkedAt + 5000)) continue;
      // 連絡先の読取が遅れても、送信開始時点のロック余裕と健康検査の期限を守る。
      if (!(final.held.expires_at_ms > now() + 10000)) return pause('LOCK_LOST');
      if (now() - health.checkedAt >= Math.min(60, final.config.health_check_seconds) * 1000) continue;
      if (daily.reserved_attempts > final.config.daily_send_cap) return waitDay();
      if (reservation.day !== jstDate(now()) || now() < limiter.next) continue;
      if (context.remainingTime && context.remainingTime() < 15000) return { type: 'YIELD' };
      return {};
    }
  };
  return {
    getState: () => ({ bad_code: badCode ?? '', bad_run: badRun }),
    async trySend(input, limiter, context) {
      if (!context?.owner || (context.test ? !/^test:.+/.test(context.owner) : context.owner !== context.campaignId) || !Number.isFinite(limiter.next) || !Number.isFinite(limiter.interval)) throw new TypeError('Invalid send context');
      if (input.Destination?.ToAddresses?.length !== 1 || input.Destination.CcAddresses?.length || input.Destination.BccAddresses?.length || input.ListManagementOptions?.ContactListName !== deps.contactList || input.ConfigurationSetName !== deps.configSet || !input.ListManagementOptions.TopicName) throw new TypeError('Invalid single-recipient send request');
      context = { ...context, address: input.Destination.ToAddresses[0], topic: input.ListManagementOptions.TopicName };
      if (normalizeEmail(context.address).email !== context.address) throw new TypeError('Noncanonical send address');
      if (await contactBlocked({ ...deps, store }, context.address, context.topic)) return { type: 'SKIPPED', code: 'CONTACT_BLOCKED' };
      if (context.test) {
        const address = input.Destination?.ToAddresses?.[0];
        const org = await store.get('SETTINGS', 'ORG');
        const settings = await config.get();
        if (!org?.test_recipients?.includes(address) || org.test_recipients.length > 5 || deps.env !== 'prod' && !settings.nonprod_allowlist.includes(address)) return { type: 'CONFIG_ERROR', code: 'RECIPIENT_NOT_ALLOWED_IN_ENV' };
        let contact;
        try { contact = await ses.getContact({ ContactListName: deps.contactList, EmailAddress: address }); } catch (error) {
          if (error.name === 'NotFoundException') return { type: 'CONFIG_ERROR', code: 'TEST_RECIPIENT_NOT_REGISTERED' };
          throw error;
        }
        if (contact.UnsubscribeAll || !contact.TopicPreferences?.some((entry) => entry.TopicName === input.ListManagementOptions?.TopicName && entry.SubscriptionStatus === 'OPT_IN')) return { type: 'CONFIG_ERROR', code: 'TEST_RECIPIENT_NOT_REGISTERED' };
      }
      const rid = await contactMetadataKey(deps, context.address);
      input = { ...input, EmailTags: [...(input.EmailTags ?? []).filter((tag) => tag.Name !== 'rid'), { Name: 'rid', Value: rid }] };
      for (let attempt = 0; ; attempt += 1) {
        const stopped = await beforeAttempt(context, limiter);
        if (stopped.type) return stopped;
        // この代入とSendEmailの間にI/Oを置かない。
        limiter.lastStart = now();
        limiter.next = limiter.lastStart + limiter.interval;
        let result;
        try {
          const response = await ses.sendEmail(input);
          result = typeof response?.MessageId === 'string' && response.MessageId ? { type: 'ACCEPTED' } : { type: 'UNKNOWN', code: 'MISSING_MESSAGE_ID' };
        } catch (error) { result = classifySendError(error); }
        if (result.type === 'ACCEPTED' || result.type === 'UNKNOWN') {
          health.quotaRemaining -= 1;
          precheck.consume();
        }
        if (result.type !== 'FAILED') { badRun = 0; badCode = undefined; }
        if (result.type === 'FAILED') {
          badRun = badCode === result.code ? badRun + 1 : 1;
          badCode = result.code;
          if (badRun >= 5) return { type: 'CONFIG_ERROR', code: result.code };
        }
        if (result.type !== 'RATE_LIMIT') return result;
        if (attempt === 3) {
          deps.metrics?.emit('Throttled', 1);
          return { type: 'THROTTLED', code: result.code };
        }
        const delay = 1000 * 2 ** attempt * (1 + Math.max(0, Math.min(1, random())) * 0.2);
        if (context.remainingTime && context.remainingTime() - delay < 15000) return { type: 'YIELD' };
        await sleep(delay);
      }
    },
  };
}
