import { createAwsAdapters } from '../common/aws.js';
import { createDdb } from '../common/ddb.js';
import { createMetrics } from '../common/metrics.js';

const payloadKeys = Object.freeze({ Send: 'send', Delivery: 'delivery', Bounce: 'bounce', Complaint: 'complaint', DeliveryDelay: 'deliveryDelay', Reject: 'reject', Subscription: 'subscription', 'Rendering Failure': 'failure' });
const safe = (value, max = 100) => typeof value === 'string' ? value.replace(/[^\s@<>]+@[^\s@<>]+/gu, '[address]').replace(/[\p{Cc}\p{Cs}]/gu, '').slice(0, max) : undefined;

export function eventRecord(event, now = Date.now()) {
  const detail = event?.detail;
  const rid = detail?.mail?.tags?.rid;
  const type = detail?.eventType;
  if (event?.source !== 'aws.ses' || !Array.isArray(rid) || rid.length !== 1 || !/^[a-f0-9]{64}$/.test(rid[0]) || !Object.hasOwn(payloadKeys, type) || !/^[a-zA-Z0-9-]{12,128}$/.test(event.id ?? '')) return null;
  const payload = detail[payloadKeys[type]] ?? {};
  const time = payload.timestamp ?? detail.mail.timestamp ?? event.time;
  const occurred = Date.parse(time);
  if (!Number.isFinite(occurred) || occurred > now + 300000 || occurred < now - 180 * 86400000) return null;
  const at = new Date(occurred).toISOString();
  const campaign = detail.mail.tags.campaign?.[0];
  const diagnostics = (payload.bouncedRecipients ?? payload.delayedRecipients ?? []).map((item) => safe(item.diagnosticCode, 300)).filter(Boolean);
  const record = { PK: `ADDR#${rid[0]}`, SK: `${at}#${type}#${event.id.slice(0, 12)}`, type, occurred_at: at, expires_at: Math.floor(occurred / 1000) + 180 * 86400 };
  if (/^(?:test|[0-9A-HJKMNP-TV-Z]{26})$/.test(campaign ?? '')) record.campaign_id = campaign;
  for (const [key, value] of Object.entries({ bounce_type: payload.bounceType, delay_type: payload.delayType, complaint_type: payload.complaintFeedbackType, diagnostic_code: diagnostics.join('; ') || payload.reason || payload.errorMessage })) {
    if (typeof value === 'string') record[key] = safe(value, key === 'diagnostic_code' ? 300 : 100);
  }
  if (type === 'Subscription') record.subscription = {
    unsubscribe_all: payload.newTopicPreferences?.unsubscribeAll === true,
    topics: (payload.newTopicPreferences?.topicSubscriptionStatus ?? []).slice(0, 20).filter((item) => /^[a-z0-9_]{1,20}$/.test(item.topicName) && ['OPT_IN', 'OPT_OUT'].includes(item.subscriptionStatus)).map((item) => ({ topic: item.topicName, status: item.subscriptionStatus })),
  };
  return record;
}

export function createHandler(deps = {}) {
  const environment = deps.environment ?? process.env;
  const runtime = { ...createAwsAdapters({ region: environment.AWS_REGION }), env: environment.ENV, tableName: environment.TABLE_NAME, now: Date.now, ...deps };
  const store = runtime.store ?? createDdb(runtime);
  return async (event) => {
    runtime.metrics ??= createMetrics(runtime);
    const record = eventRecord(event, runtime.now());
    if (!record) {
      runtime.metrics.emit('EventsIgnored', 1);
      if (!event?.detail?.mail?.tags?.rid) runtime.metrics.emit('EventIndexSkipped', 1);
      return { status: 'IGNORED' };
    }
    try { await store.put(record, 'attribute_not_exists(PK)'); } catch (error) {
      if (error.name !== 'ConditionalCheckFailedException') throw error;
      return { status: 'DUPLICATE' };
    }
    return { status: 'RECORDED' };
  };
}

export const handler = createHandler();
