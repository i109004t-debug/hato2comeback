import { AppError } from './http.js';
import { createTime } from './time.js';

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
        assertHealthy(result?.StatusCode === 'Complete' && Array.isArray(result.Values) && result.Values.every((value) => Number.isFinite(value) && value >= 0), 'MONITORING_UNAVAILABLE');
        values[id].push(...result.Values);
      }
      token = page.NextToken;
      assertHealthy(!token || !seen.has(token), 'MONITORING_UNAVAILABLE');
      if (token) seen.add(token);
    } while (token);
    return Object.fromEntries(Object.entries(values).map(([id, points]) => [id, points.length ? points.reduce((a, b) => a + b, 0) : null]));
  };
  const checkEvidence = (campaign, metrics, config) => {
    const last = Date.parse(campaign.last_send_at ?? campaign.updated_at ?? campaign.completed_at ?? campaign.started_at);
    assertHealthy(Number.isFinite(last), 'MONITORING_UNAVAILABLE');
    if ((campaign.counts?.accepted ?? 0) >= config.campaign_min_sample && now() - last > config.event_log_stale_seconds * 1000) {
      assertHealthy(['send', 'delivery', 'bounce', 'delay'].some((name) => metrics[name] > 0), 'EVENTS_MISSING');
    }
    assertHealthy(!(metrics.rendering > 0 || metrics.reject > 0), 'CONTENT_ERROR');
  };
  return {
    async check({ campaign, config, test = false, deliveryValid = false, checkRatios = false, recent = false }) {
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
          // 無履歴を正常率ゼロにはしない。一般配信には受入記録の承認を必要とする。
          if (config.reputation_alarms.includes(name) && alarm.StateValue === 'INSUFFICIENT_DATA') assertHealthy(test || deliveryValid, 'MONITORING_UNAVAILABLE');
        }
        if (campaign?.started_at) {
          const metrics = await totals(campaign);
          checkEvidence(campaign, metrics, config);
          if (checkRatios) {
            const denominator = (metrics.bounce ?? 0) + (metrics.delivery ?? 0);
            assertHealthy(!(denominator >= config.campaign_min_sample && metrics.bounce / denominator > config.campaign_bounce_pause_ratio), 'CAMPAIGN_BOUNCE');
            assertHealthy(!(metrics.send >= config.campaign_min_sample && metrics.delay / metrics.send > config.campaign_delay_pause_ratio), 'CAMPAIGN_DELAY');
            if (metrics.send >= config.campaign_min_sample && metrics.delay / metrics.send > 0.05) await deps.notify?.('CAMPAIGN_DELAY_WARNING', campaign.campaign_id);
            if (metrics.delivery >= 500 && metrics.subscription / metrics.delivery > 0.02) await deps.notify?.('SUBSCRIPTION_WARNING', campaign.campaign_id);
          }
        }
        if (recent) {
          for await (const page of store.queryPages({ KeyConditionExpression: 'PK = :pk', ExpressionAttributeValues: { ':pk': { S: 'CAMPAIGN' } } })) {
            for (const item of page.items) {
              if (!['COMPLETED', 'CANCELLED'].includes(item.status) || !item.started_at || (item.counts?.accepted ?? 0) < config.campaign_min_sample || !(Date.parse(item.completed_at) >= now() - 7 * 86400000)) continue;
              checkEvidence(item, await totals(item), config);
            }
          }
        }
        return { checkedAt: now() };
      } catch (error) {
        if (error instanceof AppError) throw error;
        throw new AppError('MONITORING_UNAVAILABLE', 503, '監視状態を取得できません。');
      }
    },
  };
}
