import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { forecastCompletion, campaignDeadline } from '../../src/common/forecast.js';
import { acceptedBucket, evaluateMissing, createMonitoring } from '../../src/common/monitoring.js';
import { configDefaults, validateConfig } from '../../src/common/config.js';
import { campaignUpdate } from '../../src/common/ddb.js';
import { CAMPAIGN_TRANSITIONS, canTransition } from '../../src/common/campaign-transitions.js';
import { fixture } from '../helpers/sending.js';

const now = Date.parse('2026-11-02T15:00:00Z');
const forecast = (options = {}) => forecastCompletion({ recipients: 10000, now, deadline_at: new Date(now + 7 * 86400000).toISOString(), daily_send_cap: 1000, Max24HourSend: -1, SentLast24Hours: 0, ses_rate_safety_factor: 0.8, rate_per_sec: 10, ...options });

test('T-57 JSTの7日・日次1000件では1万件に足りない', () => {
  const value = forecast();
  assert.deepEqual([value.completes, value.capacity_until_deadline, value.shortfall, value.finish_estimate], [false, 7000, 3000, null]);
});

test('7.10 今日の残枠・SES安全率・翌日の満枠・先行配信を差し引く', () => {
  const value = forecast({ recipients: 100, deadline_at: new Date(now + 2 * 86400000).toISOString(), reserved_attempts: 950, Max24HourSend: 1000, SentLast24Hours: 900, ahead: 25 });
  assert.equal(value.capacity_until_deadline, 825);
  assert.equal(value.finish_estimate, new Date(now + 86400000 + 7500).toISOString());
  assert.equal(value.completes, true);
  assert.equal(forecast({ recipients: 100, ahead: 9000 }).capacity_until_deadline, 0);
});

test('7.10 日付境界と期限までの秒数、送信速度、開始待ちを上限にする', () => {
  const at = now + 86400000 - 1000;
  const value = forecast({ recipients: 30, now: at, deadline_at: new Date(at + 2000).toISOString() });
  assert.equal(value.capacity_until_deadline, 20);
  assert.equal(value.shortfall, 10);
  assert.equal(forecast({ recipients: 10, now: at, deadline_at: new Date(at + 2000).toISOString(), send_after: new Date(at + 1500).toISOString() }).capacity_until_deadline, 5);
  assert.equal(forecast({ recipients: 10, deadline_at: new Date(now).toISOString() }).completes, false);
});

test('7.10 SES上限なし・ゼロ枠・不正入力と期限の最小値', () => {
  assert.equal(forecast({ Max24HourSend: -1, SentLast24Hours: 1000000 }).capacity_until_deadline, 7000);
  assert.equal(forecast({ Max24HourSend: 0 }).capacity_until_deadline, 0);
  for (const options of [{ rate_per_sec: 0 }, { recipients: null }, { recipients: -1 }, { Max24HourSend: -2 }, { SentLast24Hours: NaN }, { reserved_attempts: -1 }, { ses_rate_safety_factor: 2 }, { send_after: 'bad' }]) assert.throws(() => forecast(options), { code: 'MONITORING_UNAVAILABLE' });
  const campaign = { started_at: new Date(now).toISOString(), approval_scope: { send_by: new Date(now + 10 * 86400000).toISOString() } };
  assert.equal(campaignDeadline(campaign, { max_pending_days: 7 }), new Date(now + 7 * 86400000).toISOString());
});

const config = configDefaults('stg');
const points = (send = [], incoming = []) => ({ send: new Map(send), incoming: new Map(incoming) });
const missing = (count, send, incoming = send, at = now - 7200000, options = {}) => evaluateMissing({ accepted_buckets: { [acceptedBucket(at)]: count } }, points([[at, send]], [[at, incoming]]), { ...config, ...options }, now);

test('T-56 累計の1区間だけにSendがあっても、その後の欠測を検出する', () => {
  const buckets = Object.fromEntries([120, 110, 100].map((minutes) => [acceptedBucket(now - minutes * 60000), 100]));
  const result = evaluateMissing({ accepted_buckets: buckets }, points([[now - 120 * 60000, 100]], [[now - 120 * 60000, 1000]]), config, now);
  assert.equal(result.events_status, 'MISSING');
  assert.equal(result.events_missing, 200);
  assert.equal(result.events_last_seen_at, acceptedBucket(now - 120 * 60000));
});

test('7.8 累計の差20件・比率2%の境界、Firehoseは下限、低件数は未判定', () => {
  assert.equal(missing(100, 80).events_status, 'OK');
  assert.equal(missing(100, 79).events_status, 'MISSING');
  assert.equal(missing(10000, 9800).events_status, 'OK');
  assert.equal(missing(10000, 9799).events_status, 'MISSING');
  assert.equal(missing(100, 100, 79).events_status, 'MISSING');
  assert.equal(missing(100, 0, 10000).events_status, 'MISSING');
  assert.equal(missing(19, 0).events_status, 'INSUFFICIENT_DATA');
});

test('7.8 観測猶予を区間末から取り、直後のSend区間を重複せず合算する', () => {
  const at = now - 1200000;
  assert.equal(missing(100, 0, 0, at + 300000).events_status, 'INSUFFICIENT_DATA');
  const result = evaluateMissing({ accepted_buckets: { [acceptedBucket(at - 300000)]: 100, [acceptedBucket(at)]: 100 } }, points([[at, 100]], [[at, 1000]]), config, now);
  assert.equal(result.events_missing, 100);
  const next = evaluateMissing({ accepted_buckets: { [acceptedBucket(at)]: 100 } }, points([[at + 300000, 100]], [[at + 300000, 100]]), config, now);
  assert.equal(next.events_missing, 100);
  assert.equal(next.events_status, 'MISSING'); // 直近15分は同じ3区間のSendだけを比較する。
});

test('7.8 直近15分の受付20件・Send50%を境界どおりに判定する', () => {
  assert.equal(missing(20, 9, 100, now - 1200000).events_status, 'MISSING');
  assert.equal(missing(20, 10, 100, now - 1200000).events_status, 'OK');
  assert.equal(missing(19, 0, 0, now - 1200000).events_status, 'INSUFFICIENT_DATA');
});

test('12.7 event_missing_ratioは既定0.02、0より大きく1以下', () => {
  assert.equal(validateConfig({}, 'stg').event_missing_ratio, 0.02);
  assert.equal(validateConfig({ event_missing_ratio: 1 }, 'stg').event_missing_ratio, 1);
  for (const value of [0, -1, 1.01, NaN, '0.02']) assert.throws(() => validateConfig({ event_missing_ratio: value }, 'stg'), { code: 'CONFIGURATION_INVALID' });
});

for (const mode of ['paged', 'partial-last', 'repeat', 'bad-value', 'bad-time', 'failed']) test(`7.8 5分メトリクスのページ検査 ${mode}`, async () => {
  const f = fixture();
  const start = f.deps.now() - 7200000;
  f.setCampaign({ status: 'COMPLETED', started_at: new Date(start).toISOString(), completed_at: new Date(f.deps.now()).toISOString(), accepted_buckets: { [acceptedBucket(start)]: 100 } });
  let calls = 0;
  f.deps.cloudwatch.getMetricData = async (input) => {
    if (input.MetricDataQueries[0].MetricStat.Period !== 300) return { MetricDataResults: input.MetricDataQueries.map(({ Id }) => ({ Id, StatusCode: 'Complete', Values: [] })) };
    calls += 1;
    assert.equal(input.MetricDataQueries[1].MetricStat.Metric.Namespace, 'AWS/Firehose');
    assert.deepEqual(input.MetricDataQueries[1].MetricStat.Metric.Dimensions, [{ Name: 'DeliveryStreamName', Value: 'ht2' }]);
    if (mode === 'failed') throw new Error('private@example.com');
    return { ...(calls === 1 || mode === 'repeat' ? { NextToken: 'page' } : {}), MetricDataResults: ['send', 'incoming'].map((Id) => ({ Id, StatusCode: calls === 1 || mode === 'partial-last' || mode === 'repeat' ? 'PartialData' : 'Complete', Values: [mode === 'bad-value' ? -1 : 50], Timestamps: [new Date(mode === 'bad-time' ? start + 1 : start)] })) };
  };
  const monitor = createMonitoring({ ...f.deps, store: f.store });
  if (mode === 'paged') {
    await monitor.check({ config: f.settings, recent: true, daily: true });
    assert.equal(f.getCampaign().events_status, 'OK');
    assert.equal(f.getCampaign().events_missing, 0);
    assert.ok(f.getCampaign().events_checked_at);
  } else await assert.rejects(monitor.check({ config: f.settings, recent: true, daily: true }), { code: 'MONITORING_UNAVAILABLE' });
});

test('6.1・6.2 設計書の全矢印と実装の遷移表が一致し、禁止遷移を拒否する', () => {
  const design = readFileSync(new URL('../../docs/詳細設計書.md', import.meta.url), 'utf8').split('### 6.1 ')[1].split('### 6.2 ')[0];
  const expected = [...design.matchAll(/^\s+([A-Z_]+) --> ([A-Z_]+):/gm)].map(([, from, to]) => `${from}>${to}`).filter((edge) => !edge.startsWith('APPROVED>APPROVED'));
  const actual = Object.entries(CAMPAIGN_TRANSITIONS).flatMap(([from, targets]) => targets.map((to) => `${from}>${to}`));
  assert.deepEqual(actual.sort(), expected.sort());
  for (const from of Object.keys(CAMPAIGN_TRANSITIONS)) for (const to of Object.keys(CAMPAIGN_TRANSITIONS)) {
    if (canTransition(from, to)) assert.ok(campaignUpdate({ version: 0, from: [from], set: { status: to } }));
    else assert.throws(() => campaignUpdate({ version: 0, from: [from], set: { status: to } }), { code: 'STATE_CONFLICT' });
  }
  assert.equal(canTransition('UNKNOWN', 'SENDING'), false);
});
