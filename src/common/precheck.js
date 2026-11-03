import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createDdb } from './ddb.js';
import { AppError } from './http.js';
import { createTime, jstDate } from './time.js';
import { createMonitoring, assertHealthy, monitoringAlarmNames } from './monitoring.js';

export const REQUIRED_EVENTS = ['SEND', 'REJECT', 'BOUNCE', 'COMPLAINT', 'DELIVERY', 'DELIVERY_DELAY', 'SUBSCRIPTION', 'RENDERING_FAILURE'];
export const DELIVERY_CASES = ['T-25', 'T-26', 'T-27', 'T-28', 'T-30', 'T-31', 'T-32', 'T-33', 'T-34', 'T-36', 'T-38', 'T-39', 'T-40', 'T-41', 'T-43', 'T-44', 'T-45', 'T-46', 'T-47', 'T-48', 'T-49', 'T-50', 'T-51'];

const stable = (value) => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map((name) => [name, item[name]])) : item);
let codeHash;
export function sendingConfigHash(settings) {
  codeHash ??= createHash('sha256').update(['aws.js', 'config.js', 'contact-metadata.js', 'email.js', 'footer.js', 'sender.js', 'precheck.js', 'acceptance.js', '../api/routes/campaigns.js', '../worker/modes/prepare.js', '../worker/modes/daily.js'].map((file) => readFileSync(new URL(file, import.meta.url), 'utf8')).join('\n')).digest('hex');
  return createHash('sha256').update(stable({ ...settings, codeHash })).digest('hex');
}

export function pauseReason(code) {
  if (['AUTH_CHECK_STALE', 'LOCK_WAIT_TIMEOUT'].includes(code)) return code;
  if (['AUTH_CHECK_FAILED', 'SUPPRESSION_MISCONFIGURED', 'CONFIGURATION_INVALID', 'DELIVERY_CHECK_REQUIRED'].includes(code)) return 'AUTH_CHECK';
  if (['MONITORING_UNAVAILABLE', 'EVENT_DESTINATION_DISABLED'].includes(code)) return 'MONITORING_UNAVAILABLE';
  if (code === 'QUOTA_INSUFFICIENT') return 'QUOTA';
  if (code === 'SENDING_DISABLED') return 'OPERATOR_SWITCH';
  return ['USER', 'OPERATOR_SWITCH', 'REPUTATION_ALARM', 'CAMPAIGN_BOUNCE', 'CAMPAIGN_DELAY', 'EVENTS_MISSING', 'EVENT_LOG_STALE', 'CONTENT_ERROR', 'SES_PAUSED', 'SES_UNSTABLE', 'QUOTA'].includes(code) ? code : 'MONITORING_UNAVAILABLE';
}

export function createPrecheck(deps) {
  const store = deps.store ?? createDdb(deps);
  const { now } = createTime(deps);
  const monitoring = deps.monitoring ?? createMonitoring({ ...deps, store });
  let cache;
  let generation = 0;
  const get = async (method, input, code) => {
    try { return await deps.ses[method](input); } catch { throw new AppError(code, 503, 'SESの安全条件を取得できません。'); }
  };
  const api = {
    invalidate() { cache = undefined; generation += 1; },
    consume() { if (cache) cache.used += 1; },
    async run(options = {}) {
      let result;
      const started = now();
      try {
        const config = await deps.config.get();
        const org = await store.get('SETTINGS', 'ORG');
        assertHealthy(org && Number.isFinite(org.max_rate_per_sec) && org.max_rate_per_sec > 0, 'CONFIGURATION_INVALID');
        if (options.campaign && !(options.allowedStatuses ?? ['APPROVED']).includes(options.campaign.status)) throw new AppError('STATE_CONFLICT', 409, '配信状態が変更されています。');
        assertHealthy(config.sending_enabled, 'SENDING_DISABLED');
        assertHealthy(deps.region === 'ap-northeast-1' && /^\d{12}$/.test(deps.accountId ?? ''), 'AUTH_CHECK_FAILED');
        const settings = {
          env: deps.env, region: deps.region, accountId: deps.accountId, senderDomain: deps.senderDomain,
          contactList: deps.contactList, configSet: deps.configSet, eventStreamArn: deps.eventStreamArn,
          from_local: org.from_local, from_name: org.from_name, reply_to: org.reply_to ?? null, legal: org.legal,
          monitoringAlarms: deps.monitoringAlarms ?? monitoringAlarmNames(deps.env),
        };
        const configHash = sendingConfigHash(settings);
        const fingerprint = stable({ settings, config, version: org.version });
        if (options.force || cache?.fingerprint !== fingerprint || now() >= (cache?.expires ?? 0)) {
          cache = undefined;
          const fetched = now();
          const account = await get('getAccount', {}, 'SES_PAUSED');
          const identity = await get('getEmailIdentity', { EmailIdentity: deps.senderDomain }, 'AUTH_CHECK_FAILED');
          const configuration = await get('getConfigurationSet', { ConfigurationSetName: deps.configSet }, 'CONFIGURATION_INVALID');
          const destinations = await get('getConfigurationSetEventDestinations', { ConfigurationSetName: deps.configSet }, 'EVENT_DESTINATION_DISABLED');
          assertHealthy(now() - fetched < 60000, 'MONITORING_UNAVAILABLE');
          cache = { account, identity, configuration, destinations, fingerprint, expires: fetched + 60000, checkedAt: fetched, used: 0, generation: ++generation };
        }
        const { account, identity, configuration, destinations } = cache;
        assertHealthy(account?.SendingEnabled === true && account.EnforcementStatus === 'HEALTHY' && (deps.env !== 'prod' || account.ProductionAccessEnabled === true), 'SES_PAUSED');
        assertHealthy(['BOUNCE', 'COMPLAINT'].every((reason) => account.SuppressionAttributes?.SuppressedReasons?.includes(reason)), 'SUPPRESSION_MISCONFIGURED');
        assertHealthy(identity?.VerifiedForSendingStatus === true && identity.DkimAttributes?.SigningEnabled === true && identity.DkimAttributes.Status === 'SUCCESS' && identity.DkimAttributes.CurrentSigningKeyLength === 'RSA_2048_BIT', 'AUTH_CHECK_FAILED');
        assertHealthy(identity.MailFromAttributes?.MailFromDomain === `bounce.${deps.senderDomain}` && identity.MailFromAttributes.MailFromDomainStatus === 'SUCCESS' && identity.MailFromAttributes.BehaviorOnMxFailure === 'REJECT_MESSAGE', 'AUTH_CHECK_FAILED');
        const suppressedReasons = configuration?.SuppressionOptions?.SuppressedReasons;
        assertHealthy(configuration?.SendingOptions?.SendingEnabled === true && configuration.DeliveryOptions?.TlsPolicy === 'REQUIRE' && configuration.ReputationOptions?.ReputationMetricsEnabled === true && (suppressedReasons === undefined || Array.isArray(suppressedReasons) && ['BOUNCE', 'COMPLAINT'].every((reason) => suppressedReasons.includes(reason))), 'CONFIGURATION_INVALID');
        const enabled = Array.isArray(destinations?.EventDestinations) ? destinations.EventDestinations.filter((entry) => entry.Enabled === true && REQUIRED_EVENTS.every((event) => entry.MatchingEventTypes?.includes(event))) : [];
        const dimensions = (entry) => entry.CloudWatchDestination?.DimensionConfigurations;
        assertHealthy(enabled.some((entry) => dimensions(entry)?.length === 1 && dimensions(entry)[0].DimensionName === 'campaign' && dimensions(entry)[0].DimensionValueSource === 'MESSAGE_TAG' && dimensions(entry)[0].DefaultDimensionValue === 'none'), 'EVENT_DESTINATION_DISABLED');
        const streamPrefix = `arn:aws:firehose:${deps.region}:${deps.accountId}:deliverystream/`;
        assertHealthy(deps.eventStreamArn?.startsWith(streamPrefix) && enabled.some((entry) => entry.KinesisFirehoseDestination?.DeliveryStreamArn === deps.eventStreamArn && entry.KinesisFirehoseDestination.IamRoleArn?.startsWith(`arn:aws:iam::${deps.accountId}:role/`)), 'EVENT_DESTINATION_DISABLED');
        const auth = await store.get('SETTINGS', 'AUTH_STATUS');
        assertHealthy(auth && auth.config_hash === configHash, auth ? 'AUTH_CHECK_STALE' : 'AUTH_CHECK_FAILED');
        assertHealthy(auth.status === 'PASS' && auth.domain === deps.senderDomain && /^[a-f0-9]{64}$/.test(auth.dns_config_hash ?? '') && now() - Date.parse(auth.checked_at) >= 0 && now() - Date.parse(auth.checked_at) <= config.auth_status_max_age_hours * 3600000, 'AUTH_CHECK_FAILED');
        const delivery = org.delivery_check;
        const deliveryValid = delivery?.status === 'PASS' && typeof delivery.note === 'string' && delivery.note.trim().length > 0 && delivery.config_hash === configHash && delivery.dns_config_hash === auth.dns_config_hash && now() - Date.parse(delivery.passed_at) >= 0 && now() - Date.parse(delivery.passed_at) <= config.delivery_check_max_age_days * 86400000 && DELIVERY_CASES.every((id) => delivery.cases?.[id] === 'PASS');
        const exempt = options.test === true && (delivery === undefined || options.acceptanceRecovery === true);
        if (config.delivery_check_required && !exempt) {
          assertHealthy(deliveryValid, 'DELIVERY_CHECK_REQUIRED');
          assertHealthy(typeof delivery.evidence_key === 'string' && /^delivery-checks\/[^/]+\/.+/.test(delivery.evidence_key) && !delivery.evidence_key.split('/').includes('..'), 'DELIVERY_CHECK_REQUIRED');
          try { await deps.s3.headObject({ Bucket: deps.dataBucket, Key: delivery.evidence_key }); } catch { assertHealthy(false, 'DELIVERY_CHECK_REQUIRED'); }
        }
        const quota = account.SendQuota;
        assertHealthy(Number.isFinite(quota?.Max24HourSend) && Number.isFinite(quota.SentLast24Hours) && (quota.Max24HourSend === -1 || quota.Max24HourSend >= 0) && quota.SentLast24Hours >= 0 && Number.isFinite(quota.MaxSendRate) && quota.MaxSendRate > 0, 'QUOTA_INSUFFICIENT');
        const daily = await store.get('DAILY', jstDate(now()));
        assertHealthy(!daily || Number.isSafeInteger(daily.reserved_attempts) && daily.reserved_attempts >= 0, 'QUOTA_INSUFFICIENT');
        const remaining = options.remaining ?? options.campaign?.recipients_total ?? config.daily_send_cap;
        const required = Math.min(remaining, Math.max(0, config.daily_send_cap - (daily?.reserved_attempts ?? 0)));
        const quotaRemaining = quota.Max24HourSend === -1 ? Infinity : Math.max(0, quota.Max24HourSend - quota.SentLast24Hours - cache.used);
        const warnings = [];
        if (quotaRemaining < required) {
          if (options.scheduling) warnings.push('QUOTA_INSUFFICIENT');
          else assertHealthy(false, 'QUOTA_INSUFFICIENT');
        }
        await monitoring.check({ campaign: options.campaign, config, test: options.test, deliveryValid, checkRatios: options.checkRatios, recent: options.recent !== false });
        assertHealthy(now() < cache.expires, 'MONITORING_UNAVAILABLE');
        result = { ok: true, config, org, rate: Math.min(org.max_rate_per_sec, config.max_rate_per_sec, quota.MaxSendRate * Math.min(0.8, config.ses_rate_safety_factor)), quotaRemaining, sample: cache.generation, checkedAt: Math.min(started, cache.checkedAt), configHash, warnings };
      } catch (error) {
        const known = error instanceof AppError;
        result = { ok: false, code: known ? error.code : 'MONITORING_UNAVAILABLE', status: known ? error.status : 503, checkedAt: started };
      }
      if (deps.audit) await deps.audit.write({ actor_sub: options.actor_sub ?? 'SYSTEM', action: 'PRECHECK', target: options.campaign?.campaign_id ?? 'test', result: result.ok ? 'PASS' : 'FAIL', request_id: options.request_id ?? 'worker', details: { code: result.code ?? 'PASS', warnings: result.warnings ?? [] } });
      return result;
    },
  };
  return api;
}
