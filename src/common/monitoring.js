import { AppError } from './http.js';
import { createTime } from './time.js';
import { updateCampaign, conflict } from './records.js';

const PERIOD = 300000;
export const acceptedBucket = (time) => new Date(Math.floor(time / PERIOD) * PERIOD).toISOString().slice(0, 16) + 'Z';

export function evaluateMissing(campaign, points, config, now) {
  const cutoff = Math.floor((now - config.event_log_stale_seconds * 1000) / PERIOD) * PERIOD;
  const buckets = Object.entries(campaign.accepted_buckets ?? {}).map(([key, count]) => {
    const time = Date.parse(key);
    assertHealthy(Number.isSafeInteger(count) && count >= 0 && Number.isFinite(time) && acceptedBucket(time) === key, 'MONITORING_UNAVAILABLE');
    return { time, count };
  }).filter(({ time }) => time + PERIOD <= cutoff);
  const eligible = buckets.filter(({ count }) => count >= 20);
  const times = new Set(eligible.flatMap(({ time }) => [time, time + PERIOD]));
  const sum = (id, intervals) => [...intervals].reduce((total, time) => total + (points[id].get(time) ?? 0), 0);
  const accepted = eligible.reduce((total, { count }) => total + count, 0);
  const send = sum('send', times);
  const incoming = sum('incoming', times);
  const recent = buckets.filter(({ time }) => time >= cutoff - 3 * PERIOD);
  const recentAccepted = recent.reduce((total, { count }) => total + count, 0);
  const recentSend = sum('send', new Set(recent.map(({ time }) => time)));
  const missing = Math.max(0, accepted - send, accepted - incoming, recentAccepted >= 20 ? recentAccepted - recentSend : 0);
  const failed = accepted - send > Math.max(20, accepted * config.event_missing_ratio) || accepted - incoming > Math.max(20, accepted * config.event_missing_ratio) || recentAccepted >= 20 && recentSend < recentAccepted * 0.5;
  const last = [...points.send].filter(([, value]) => value > 0).map(([time]) => time).sort((a, b) => b - a)[0];
  return { events_checked_at: new Date(now).toISOString(), events_last_seen_at: last === undefined ? campaign.events_last_seen_at ?? null : acceptedBucket(last), events_missing: missing, events_status: accepted >= 20 || recentAccepted >= 20 ? failed ? 'MISSING' : 'OK' : 'INSUFFICIENT_DATA' };
}

export function monitoringAlarmNames(env) {
  return ['firehose-delivery', 'firehose-freshness', 'rendering-or-reject'].map((name) => `ht2-${env}-${name}`);
}

export function assertHealthy(condition, code) {
  if (!condition) throw new AppError(code, ['QUOTA_INSUFFICIENT', 'DELIVERY_CHECK_REQUIRED'].includes(code) ? 422 : 503, '送信の安全条件を確認できません。');
}

const metricNames = { send: 'Send', delivery: 'Delivery', bounce: 'Bounce', delay: 'DeliveryDelay', subscription: 'Subscription', rendering: 'RenderingFailure', reject: 'Reject' };

export function createMonitoring(deps) {
  const { cloudwatch, store, env } = deps;
  const { now } = createTime(deps);
  const totals = async (campaign) => {
    const queries = Object.entries(metricNames).map(([Id, MetricName]) => ({
      Id, MetricStat: { Metric: { Namespace: 'AWS/SES', MetricName, Dimensions: [{ Name: 'campaign', Value: campaign.campaign_id }] }, Period: 3600, Stat: 'Sum' },
      ReturnData: true,
    }));
    const values = Object.fromEntries(Object.keys(metricNames).map((id) => [id, []]));
    const seen = new Set();
    let token;
    do {
      const page = await cloudwatch.getMetricData({
        StartTime: new Date(campaign.started_at), EndTime: new Date(now()), MetricDataQueries: queries,
        ...(token ? { NextToken: token } : {}),
      });
      assertHealthy(Array.isArray(page.MetricDataResults) && !page.Messages?.length, 'MONITORING_UNAVAILABLE');
      for (const id of Object.keys(metricNames)) {
        const result = page.MetricDataResults.find((entry) => entry.Id === id);
        assertHealthy((result?.StatusCode === 'Complete' || page.NextToken && result?.StatusCode === 'PartialData') && Array.isArray(result.Values) && result.Values.every((value) => Number.isFinite(value) && value >= 0), 'MONITORING_UNAVAILABLE');
        values[id].push(...result.Values);
      }
      token = page.NextToken;
      assertHealthy(!token || !seen.has(token), 'MONITORING_UNAVAILABLE');
      if (token) seen.add(token);
    } while (token);
    return Object.fromEntries(Object.entries(values).map(([id, points]) => [id, points.length ? points.reduce((a, b) => a + b, 0) : null]));
  };
  const checkEvidence = async (campaign, config) => {
    const checked = now();
    const start = Math.floor(Date.parse(campaign.started_at) / PERIOD) * PERIOD;
    const cutoff = Math.floor((checked - config.event_log_stale_seconds * 1000) / PERIOD) * PERIOD;
    const points = { send: new Map(), incoming: new Map() };
    if (cutoff > start) {
      const stream = deps.eventStreamArn?.split(':deliverystream/')[1];
      assertHealthy(typeof stream === 'string' && stream.length > 0, 'MONITORING_UNAVAILABLE');
      const queries = [
        { Id: 'send', MetricStat: { Metric: { Namespace: 'AWS/SES', MetricName: 'Send', Dimensions: [{ Name: 'campaign', Value: campaign.campaign_id }] }, Period: 300, Stat: 'Sum' }, ReturnData: true },
        { Id: 'incoming', MetricStat: { Metric: { Namespace: 'AWS/Firehose', MetricName: 'IncomingRecords', Dimensions: [{ Name: 'DeliveryStreamName', Value: stream }] }, Period: 300, Stat: 'Sum' }, ReturnData: true },
      ];
      let token;
      const seen = new Set();
      do {
        const page = await cloudwatch.getMetricData({ StartTime: new Date(start), EndTime: new Date(cutoff + PERIOD), MetricDataQueries: queries, ScanBy: 'TimestampAscending', ...(token ? { NextToken: token } : {}) });
        assertHealthy(!page.Messages?.length, 'MONITORING_UNAVAILABLE');
        for (const id of Object.keys(points)) {
          const result = page.MetricDataResults?.find((item) => item.Id === id);
          assertHealthy((result?.StatusCode === 'Complete' || page.NextToken && result?.StatusCode === 'PartialData') && !result.Messages?.length && Array.isArray(result.Values) && Array.isArray(result.Timestamps) && result.Values.length === result.Timestamps.length, 'MONITORING_UNAVAILABLE');
          for (let i = 0; i < result.Values.length; i += 1) {
            const time = new Date(result.Timestamps[i]).getTime();
            const value = result.Values[i];
            assertHealthy(Number.isFinite(time) && time % PERIOD === 0 && time >= start && time < cutoff + PERIOD && Number.isFinite(value) && value >= 0, 'MONITORING_UNAVAILABLE');
            points[id].set(time, (points[id].get(time) ?? 0) + value);
          }
        }
        token = page.NextToken;
        assertHealthy(!token || !seen.has(token), 'MONITORING_UNAVAILABLE');
        if (token) seen.add(token);
      } while (token);
    }
    const fields = evaluateMissing(campaign, points, config, checked);
    let saved = false;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const current = await store.get('CAMPAIGN', campaign.campaign_id);
      if (!current || Date.parse(current.events_checked_at) > checked) { saved = true; break; }
      try { await updateCampaign({ ...deps, store, now }, current, [current.status], fields); saved = true; break; } catch (error) { if (!conflict(error)) throw error; }
    }
    assertHealthy(saved, 'MONITORING_UNAVAILABLE');
    assertHealthy(fields.events_status !== 'MISSING', 'EVENTS_MISSING');
    return fields;
  };
  return {
    async check({ campaign, config, test = false, deliveryValid = false, checkRatios = false, recent = false, daily = false }) {
      try {
        const names = [...config.reputation_alarms, ...(deps.monitoringAlarms ?? monitoringAlarmNames(env))];
        const response = await cloudwatch.describeAlarms({ AlarmNames: names });
        const alarms = [...(response.MetricAlarms ?? []), ...(response.CompositeAlarms ?? [])];
        for (const name of names) {
          const alarm = alarms.find((entry) => entry.AlarmName === name);
          assertHealthy(alarm && ['OK', 'ALARM', 'INSUFFICIENT_DATA'].includes(alarm.StateValue), 'MONITORING_UNAVAILABLE');
          if (alarm.StateValue === 'ALARM') {
            assertHealthy(false, config.reputation_alarms.includes(name) ? 'REPUTATION_ALARM' : name.endsWith('rendering-or-reject') ? 'CONTENT_ERROR' : 'EVENT_LOG_STALE');
          }
          // 本番の観測不足は受入記録で判断し、検証環境では初回の一般配信も許可する。
          if (!daily && config.reputation_alarms.includes(name) && alarm.StateValue === 'INSUFFICIENT_DATA') assertHealthy(env !== 'prod' || test || deliveryValid, 'MONITORING_UNAVAILABLE');
        }
        if (campaign?.started_at) {
          const metrics = await totals(campaign);
          assertHealthy(!(metrics.rendering > 0 || metrics.reject > 0), 'CONTENT_ERROR');
          if (checkRatios || daily) await checkEvidence(campaign, config);
          if (checkRatios) {
            const denominator = (metrics.bounce ?? 0) + (metrics.delivery ?? 0);
            assertHealthy(!(denominator >= config.campaign_min_sample && metrics.bounce / denominator > config.campaign_bounce_pause_ratio), 'CAMPAIGN_BOUNCE');
            assertHealthy(!(metrics.send >= config.campaign_min_sample && metrics.delay / metrics.send > config.campaign_delay_pause_ratio), 'CAMPAIGN_DELAY');
            if (metrics.send >= config.campaign_min_sample && metrics.delay / metrics.send > 0.05) await deps.notify?.('CAMPAIGN_DELAY_WARNING', campaign.campaign_id);
            if (metrics.delivery >= 500 && metrics.subscription / metrics.delivery > 0.02) await deps.notify?.('SUBSCRIPTION_WARNING', campaign.campaign_id);
          }
        }
        if (recent) {
          let failure;
          for await (const page of store.queryPages({ KeyConditionExpression: 'PK = :pk', ExpressionAttributeValues: { ':pk': { S: 'CAMPAIGN' } } })) {
            for (const item of page.items) {
              if (!['COMPLETED', 'CANCELLED'].includes(item.status) || !item.started_at || !(Date.parse(item.completed_at) >= now() - 7 * 86400000)) continue;
              try {
                const metrics = await totals(item);
                await checkEvidence(item, config);
                assertHealthy(!(metrics.rendering > 0 || metrics.reject > 0), 'CONTENT_ERROR');
              } catch (error) { failure ??= error; }
            }
          }
          if (failure) throw failure;
        }
        return { checkedAt: now() };
      } catch (error) {
        if (error instanceof AppError) throw error;
        throw new AppError('MONITORING_UNAVAILABLE', 503, '監視状態を取得できません。');
      }
    },
  };
}
