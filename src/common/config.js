import { AppError } from './http.js';
import { normalizeEmail } from './email.js';
import { now as defaultNow } from './time.js';

export function configDefaults(env) {
  if (!['dev', 'stg', 'prod'].includes(env)) throw new TypeError('Invalid environment');
  return {
    sending_enabled: false, max_rate_per_sec: 10, ses_rate_safety_factor: 0.8,
    batch_size: 200, progress_every: 20, max_recipients_per_campaign: 100000,
    lock_ttl_seconds: 7200, pause_timeout_days: 7,
    reputation_alarms: [`ht2-${env}-ses-bounce-rate`, `ht2-${env}-ses-complaint-rate`],
    campaign_bounce_pause_ratio: 0.05, campaign_min_sample: 200,
    campaign_delay_pause_ratio: 0.10, daily_send_cap: 1000,
    delivery_check_required: env === 'prod', nonprod_allowlist: [], nonprod_allowlist_s3_key: '',
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
  if (!Array.isArray(value.nonprod_allowlist) || value.nonprod_allowlist.length > 20000) fail();
  const key = value.nonprod_allowlist_s3_key;
  if (typeof key !== 'string' || (key && (env === 'prod' || value.nonprod_allowlist.length || key.length > 512 || !/^allowlists\/[A-Za-z0-9/_\-.]+\.json$/.test(key) || key.split('/').some((part) => !part || part === '.' || part === '..')))) fail();
  try { value.nonprod_allowlist = [...new Set(value.nonprod_allowlist.map((email) => normalizeEmail(email).email))]; } catch { fail(); }
  return value;
}

const MAX_ALLOWLIST_BYTES = 2 * 1024 * 1024;

async function allowlistText(response) {
  if (response.ContentLength > MAX_ALLOWLIST_BYTES) { response.Body?.destroy?.(); throw new Error('Allowlist too large'); }
  const body = response.Body;
  if (typeof body === 'string' || body instanceof Uint8Array) {
    if (Buffer.byteLength(body) > MAX_ALLOWLIST_BYTES) throw new Error('Allowlist too large');
    return typeof body === 'string' ? body : Buffer.from(body).toString('utf8');
  }
  if (!body?.[Symbol.asyncIterator]) throw new Error('Invalid allowlist body');
  const chunks = [];
  let bytes = 0;
  for await (const chunk of body) {
    const buffer = Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_ALLOWLIST_BYTES) { body.destroy?.(); throw new Error('Allowlist too large'); }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function createConfig({ ssm, s3, dataBucket, env, now = defaultNow }) {
  configDefaults(env);
  let cache;
  let pending;
  return {
    validUntil: () => cache?.expires ?? 0,
    async get() {
      if (cache && now() < cache.expires) return structuredClone(cache.value);
      if (!pending) {
        const started = now();
        pending = (async () => {
          const response = await ssm.getParameter({ Name: `/ht2/${env}/config` });
          let input;
          try {
            const raw = response.Parameter?.Value;
            if (typeof raw !== 'string' || Buffer.byteLength(raw) > 4096) throw new Error('Config too large');
            input = JSON.parse(raw);
          } catch { throw new AppError('CONFIGURATION_INVALID', 503, '設定JSONを確認してください。'); }
          const value = validateConfig(input, env);
          if (value.nonprod_allowlist_s3_key) {
            try {
              const object = await s3.getObject({ Bucket: dataBucket, Key: value.nonprod_allowlist_s3_key });
              const addresses = JSON.parse(await allowlistText(object));
              value.nonprod_allowlist = validateConfig({ nonprod_allowlist: addresses }, env).nonprod_allowlist;
            } catch { throw new AppError('CONFIGURATION_INVALID', 503, '非本番環境の送信許可リストを確認してください。'); }
          }
          cache = { value, expires: started + 5000 };
          return value;
        })();
      }
      try { return structuredClone(await pending); } finally { pending = undefined; }
    },
  };
}
