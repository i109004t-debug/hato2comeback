import { AppError } from './http.js';
import { normalizeEmail } from './email.js';
import { now as defaultNow } from './time.js';

export function configDefaults(env) {
  if (!['dev', 'stg', 'prod'].includes(env)) throw new TypeError('Invalid environment');
  return {
    sending_enabled: false, max_rate_per_sec: 10, ses_rate_safety_factor: 0.8,
    batch_size: 200, progress_every: 20, max_recipients_per_campaign: 100000,
    lock_ttl_seconds: 7200, pause_timeout_days: 7,
    reputation_alarms: [`postline-${env}-ses-bounce-rate`, `postline-${env}-ses-complaint-rate`],
    campaign_bounce_pause_ratio: 0.05, campaign_min_sample: 200,
    campaign_delay_pause_ratio: 0.10, daily_send_cap: 1000,
    delivery_check_required: env === 'prod', nonprod_allowlist: [],
    health_check_seconds: 60, auth_status_max_age_hours: 26,
    delivery_check_max_age_days: 90, max_pending_days: 7, event_log_stale_seconds: 900,
  };
}

export function validateConfig(input, env) {
  const fail = () => { throw new AppError('CONFIGURATION_INVALID', 503, '設定JSONを確認してください。'); };
  const defaults = configDefaults(env);
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((name) => !Object.hasOwn(defaults, name))) fail();
  const value = { ...defaults, ...input };
  for (const name of ['sending_enabled', 'delivery_check_required']) if (typeof value[name] !== 'boolean') fail();
  for (const name of ['max_rate_per_sec', 'ses_rate_safety_factor', 'campaign_bounce_pause_ratio', 'campaign_delay_pause_ratio', 'auth_status_max_age_hours', 'delivery_check_max_age_days']) {
    if (!Number.isFinite(value[name]) || value[name] <= 0) fail();
  }
  for (const name of ['batch_size', 'progress_every', 'max_recipients_per_campaign', 'lock_ttl_seconds', 'pause_timeout_days', 'campaign_min_sample', 'daily_send_cap', 'health_check_seconds', 'max_pending_days', 'event_log_stale_seconds']) {
    if (!Number.isSafeInteger(value[name]) || value[name] < 1) fail();
  }
  if (value.ses_rate_safety_factor > 1 || value.campaign_bounce_pause_ratio > 1 || value.campaign_delay_pause_ratio > 1 || value.batch_size > 200 || value.progress_every > 20 || value.progress_every > value.batch_size || value.pause_timeout_days > 7 || value.max_pending_days > 7 || value.health_check_seconds > 60 || value.auth_status_max_age_hours > 26 || value.delivery_check_max_age_days > 90 || (env === 'prod' && !value.delivery_check_required)) fail();
  if (!Array.isArray(value.reputation_alarms) || value.reputation_alarms.length < 2 || value.reputation_alarms.some((name) => typeof name !== 'string' || !/^[A-Za-z0-9_.-]{1,255}$/.test(name)) || new Set(value.reputation_alarms).size !== value.reputation_alarms.length) fail();
  if (!Array.isArray(value.nonprod_allowlist)) fail();
  try { value.nonprod_allowlist = [...new Set(value.nonprod_allowlist.map((email) => normalizeEmail(email).email))]; } catch { fail(); }
  return value;
}

export function createConfig({ ssm, env, now = defaultNow }) {
  configDefaults(env);
  let cache;
  let pending;
  return {
    async get() {
      if (cache && now() < cache.expires) return structuredClone(cache.value);
      if (!pending) {
        const started = now();
        pending = (async () => {
          const response = await ssm.getParameter({ Name: `/postline/${env}/config` });
          let input;
          try { input = JSON.parse(response.Parameter?.Value); } catch { throw new AppError('CONFIGURATION_INVALID', 503, '設定JSONを確認してください。'); }
          const value = validateConfig(input, env);
          cache = { value, expires: started + 30000 };
          return value;
        })();
      }
      try { return structuredClone(await pending); } finally { pending = undefined; }
    },
  };
}
