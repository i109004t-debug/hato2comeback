import test from 'node:test';
import assert from 'node:assert/strict';
import { createPrecheck, pauseReason } from '../../src/common/precheck.js';
import { createSendLock } from '../../src/common/lock.js';
import { fixture, ID, ID2 } from '../helpers/sending.js';

test('3.10/7.1 開始前検査の正常系、SESの60秒キャッシュと強制再評価', async () => {
  const f = fixture({ env: 'prod' });
  const checker = createPrecheck({ ...f.deps, store: f.store });
  const run = () => checker.run({ campaign: f.getCampaign(), allowedStatuses: ['QUEUED'] });
  assert.equal((await run()).ok, true);
  assert.equal((await run()).ok, true);
  assert.equal(f.controls.length, 1);
  f.advance(60000);
  assert.equal((await run()).ok, true);
  assert.equal(f.controls.length, 2);
  await checker.run({ force: true });
  assert.equal(f.controls.length, 3);
  checker.invalidate(); await run();
  assert.equal(f.controls.length, 4);
});

const failures = [
  ['送信スイッチ', (f) => { f.settings.sending_enabled = false; }, 'SENDING_DISABLED'],
  ['本番利用', (f) => { f.account.ProductionAccessEnabled = false; }, 'SES_PAUSED'],
  ['SES送信停止', (f) => { f.account.SendingEnabled = false; }, 'SES_PAUSED'],
  ['SES強制制限', (f) => { f.account.EnforcementStatus = 'SHUTDOWN'; }, 'SES_PAUSED'],
  ['抑止設定', (f) => { f.account.SuppressionAttributes.SuppressedReasons = ['BOUNCE']; }, 'SUPPRESSION_MISCONFIGURED'],
  ['DKIM', (f) => { f.identity.DkimAttributes.CurrentSigningKeyLength = 'RSA_1024_BIT'; }, 'AUTH_CHECK_FAILED'],
  ['MAIL FROM', (f) => { f.identity.MailFromAttributes.BehaviorOnMxFailure = 'USE_DEFAULT_VALUE'; }, 'AUTH_CHECK_FAILED'],
  ['TLS', (f) => { f.configuration.DeliveryOptions.TlsPolicy = 'OPTIONAL'; }, 'CONFIGURATION_INVALID'],
  ['設定セット抑止上書き', (f) => { f.configuration.SuppressionOptions = { SuppressedReasons: ['BOUNCE'] }; }, 'CONFIGURATION_INVALID'],
  ['イベント無効', (f) => { f.destinations.EventDestinations[1].Enabled = false; }, 'EVENT_DESTINATION_DISABLED'],
  ['イベント不足', (f) => { f.destinations.EventDestinations[0].MatchingEventTypes = ['SEND']; }, 'EVENT_DESTINATION_DISABLED'],
  ['次元違い', (f) => { f.destinations.EventDestinations[0].CloudWatchDestination.DimensionConfigurations[0].DefaultDimensionValue = 'other'; }, 'EVENT_DESTINATION_DISABLED'],
  ['DNS期限切れ', (f) => { f.auth.checked_at = new Date(f.deps.now() - 26 * 3600000 - 1).toISOString(); f.ddb.set(f.auth); }, 'AUTH_CHECK_FAILED'],
  ['DNS取得不明', (f) => { f.auth.status = 'UNKNOWN'; f.ddb.set(f.auth); }, 'AUTH_CHECK_FAILED'],
  ['設定版違い', (f) => { f.auth.config_hash = 'a'.repeat(64); f.ddb.set(f.auth); }, 'AUTH_CHECK_STALE'],
  ['受入記録なし', (f) => { delete f.org.delivery_check; f.ddb.set(f.org); }, 'DELIVERY_CHECK_REQUIRED'],
  ['受入記録期限切れ', (f) => { f.org.delivery_check.passed_at = new Date(f.deps.now() - 91 * 86400000).toISOString(); f.ddb.set(f.org); }, 'DELIVERY_CHECK_REQUIRED'],
  ['DNSハッシュ変更', (f) => { f.auth.dns_config_hash = 'a'.repeat(64); f.ddb.set(f.auth); }, 'DELIVERY_CHECK_REQUIRED'],
  ['証跡なし', (f) => { f.files.clear(); }, 'DELIVERY_CHECK_REQUIRED'],
  ['受入試験不足', (f) => { delete f.org.delivery_check.cases['T-45']; f.ddb.set(f.org); }, 'DELIVERY_CHECK_REQUIRED'],
  ['SES残枠不足', (f) => { f.account.SendQuota.SentLast24Hours = 99999; }, 'QUOTA_INSUFFICIENT'],
  ['監視API失敗', (f) => { f.alarmError = new Error('private@example.com'); }, 'MONITORING_UNAVAILABLE'],
  ['アラーム不在', (f) => { f.alarms.pop(); }, 'MONITORING_UNAVAILABLE'],
  ['評判異常', (f) => { f.alarms[0].StateValue = 'ALARM'; }, 'REPUTATION_ALARM'],
  ['Firehose異常', (f) => { f.alarms[2].StateValue = 'ALARM'; }, 'EVENT_LOG_STALE'],
  ['SES応答欠落', (f) => { f.account = undefined; }, 'SES_PAUSED'],
  ['認証応答欠落', (f) => { f.identity = undefined; }, 'AUTH_CHECK_FAILED'],
  ['設定セット応答欠落', (f) => { f.configuration = undefined; }, 'CONFIGURATION_INVALID'],
  ['イベント送信先応答欠落', (f) => { f.destinations = undefined; }, 'EVENT_DESTINATION_DISABLED'],
];
for (const [name, mutate, code] of failures) {
  test(`3.10/7.1 ${name}の検査失敗は${code}`, async () => {
    const f = fixture({ env: 'prod' }); mutate(f);
    const result = await createPrecheck({ ...f.deps, store: f.store }).run();
    assert.equal(result.ok, false); assert.equal(result.code, code);
    assert.equal(JSON.stringify(result).includes('private@example.com'), false);
  });
}

test('3.10 SES取得失敗に古いPASSを使わず、設定変更でキャッシュを無効化', async () => {
  const f = fixture(); const checker = createPrecheck({ ...f.deps, store: f.store });
  assert.equal((await checker.run()).ok, true);
  f.settings.max_rate_per_sec = 2; f.accountError = new Error('unavailable');
  assert.equal((await checker.run()).code, 'SES_PAUSED');
});

test('7.1 状態競合と予約設定時だけのSES枠不足警告', async () => {
  const f = fixture(); const checker = createPrecheck({ ...f.deps, store: f.store });
  assert.equal((await checker.run({ campaign: f.getCampaign() })).code, 'STATE_CONFLICT');
  f.account.SendQuota.Max24HourSend = 0;
  const result = await checker.run({ scheduling: true });
  assert.equal(result.ok, true); assert.deepEqual(result.warnings, ['QUOTA_INSUFFICIENT']);
  assert.equal((await checker.run()).code, 'QUOTA_INSUFFICIENT');
});

test('7.8 個別検査理由をpause_reasonに対応させる', () => {
  for (const code of ['AUTH_CHECK_STALE', 'LOCK_WAIT_TIMEOUT']) assert.equal(pauseReason(code), code);
  for (const code of ['AUTH_CHECK_FAILED', 'SUPPRESSION_MISCONFIGURED', 'CONFIGURATION_INVALID', 'DELIVERY_CHECK_REQUIRED']) assert.equal(pauseReason(code), 'AUTH_CHECK');
  for (const code of ['EVENT_DESTINATION_DISABLED', 'MONITORING_UNAVAILABLE']) assert.equal(pauseReason(code), 'MONITORING_UNAVAILABLE');
  assert.equal(pauseReason('EVENT_LOG_STALE'), 'EVENT_LOG_STALE');
  assert.equal(pauseReason('EVENTS_MISSING'), 'EVENTS_MISSING');
});

test('4.3/7.3 送信ロックは配信・テスト共通、期限延長・所有者条件・次時刻保持', async () => {
  const f = fixture(); const lock = createSendLock({ ...f.deps, store: f.store });
  assert.equal((await lock.acquire(ID, 30)).owner, ID);
  assert.equal(await lock.acquire('test:request', 30), undefined);
  f.advance(1); const extended = await lock.extend(ID, 60);
  assert.equal(extended.expires_at_ms, f.deps.now() + 60000);
  assert.equal(await lock.release(ID2), undefined);
  const next = f.deps.now() + 100;
  await lock.release(ID, { next, lastStart: f.deps.now() });
  const held = await lock.acquire('test:request', 30);
  assert.equal(held.next_send_at_ms, next);
  assert.equal(await lock.extend(ID, 60), undefined);
  f.advance(30001); assert.equal((await lock.acquire(ID2, 60)).owner, ID2);
  assert.equal(await lock.release('test:request'), undefined);
});

test('4.3 ロックのDDB障害は競合扱いせず送信を止める', async () => {
  const f = fixture(); f.ddb.beforeUpdate = () => { throw new Error('unavailable'); };
  await assert.rejects(createSendLock({ ...f.deps, store: f.store }).acquire(ID, 60), /unavailable/);
});
