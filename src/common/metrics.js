import { now as defaultNow } from './time.js';
import { API_ROUTES } from './router.js';

export const METRIC_UNITS = Object.freeze({
  Accepted: 'Count', Failed: 'Count', Unknown: 'Count', Throttled: 'Count',
  Paused: 'Count', NeedsReview: 'Count', StartFailed: 'Count', PrepareRecipients: 'Count', PrepareSeconds: 'Seconds',
  SesBusy: 'Count', ImportRows: 'Count', ImportSkipped: 'Count', ImportRejected: 'Count',
  ApiError4xx: 'Count', ApiError5xx: 'Count', ApiLatencyMs: 'Milliseconds',
  SesSendingEnabled: 'None', SesMax24HourSend: 'Count', SesSentLast24Hours: 'Count', SesMaxSendRate: 'Count/Second',
});
const reasons = ['USER', 'OPERATOR_SWITCH', 'REPUTATION_ALARM', 'CAMPAIGN_BOUNCE', 'CAMPAIGN_DELAY', 'EVENTS_MISSING', 'EVENT_LOG_STALE', 'MONITORING_UNAVAILABLE', 'CONTENT_ERROR', 'AUTH_CHECK', 'AUTH_CHECK_STALE', 'LOCK_WAIT_TIMEOUT', 'SES_PAUSED', 'SES_UNSTABLE', 'QUOTA'];

export function createMetrics({ env, now = defaultNow, write = (line) => process.stdout.write(line) }) {
  if (!['dev', 'stg', 'prod'].includes(env)) throw new TypeError('Invalid environment');
  return {
    emit(name, value = 1, dimensions = {}) {
      if (!Object.hasOwn(METRIC_UNITS, name) || !Number.isFinite(value) || value < 0) throw new TypeError('Invalid metric');
      const fields = name.startsWith('Api') ? ['Route'] : name === 'Paused' ? ['Reason'] : [];
      if (Object.keys(dimensions).some((key) => !fields.includes(key)) || fields.some((key) => typeof dimensions[key] !== 'string')) throw new TypeError('Invalid metric dimensions');
      if (dimensions.Reason && !reasons.includes(dimensions.Reason)) throw new TypeError('Invalid pause reason');
      if (dimensions.Route && dimensions.Route !== '$default' && !API_ROUTES.some((route) => dimensions.Route === route.operation || dimensions.Route === route.id)) throw new TypeError('Invalid route dimension');
      const entry = {
        _aws: { Timestamp: now(), CloudWatchMetrics: [{ Namespace: `HT2/${env}`, Dimensions: [fields], Metrics: [{ Name: name, Unit: METRIC_UNITS[name] }] }] },
        ...dimensions,
        [name]: value,
      };
      write(`${JSON.stringify(entry)}\n`);
      return entry;
    },
  };
}
