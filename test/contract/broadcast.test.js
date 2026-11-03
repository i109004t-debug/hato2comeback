import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fixture, failure, ID, ID2, ARN } from '../helpers/sending.js';
import { createPrecheck } from '../../src/common/precheck.js';
import { jstDate } from '../../src/common/time.js';

const definition = JSON.parse(readFileSync(new URL('../../infra/broadcast.asl.json', import.meta.url), 'utf8'));

test('7.2 ASLは正しいJSON、全状態が到達可能でNext/Endと分岐が成立', () => {
  const states = definition.States;
  const reachable = new Set();
  const visit = (name) => {
    assert.ok(states[name], `missing ${name}`);
    if (reachable.has(name)) return;
    reachable.add(name);
    const state = states[name];
    const edges = [state.Next, state.Default, ...(state.Choices ?? []).map((choice) => choice.Next), ...(state.Catch ?? []).map((entry) => entry.Next)].filter(Boolean);
    if (state.Type === 'Choice') assert.ok(state.Default && state.Choices.length);
    else if (['Fail', 'Succeed'].includes(state.Type)) assert.ok(!state.Next && !state.End);
    else assert.equal(Boolean(state.Next) !== Boolean(state.End), true, name);
    edges.forEach(visit);
  };
  visit(definition.StartAt);
  assert.deepEqual([...reachable].sort(), Object.keys(states).sort());
  assert.equal(states.WaitDay.SecondsPath, '$.result.wait_seconds');
  assert.equal(states.WaitLock.Seconds, 300); assert.equal(states.Throttled.Seconds, 60);
  assert.equal(states.WaitForResume.TimeoutSeconds, 7 * 86400);
  assert.equal(states.WaitForResume.Resource, 'arn:aws:states:::aws-sdk:dynamodb:updateItem.waitForTaskToken');
  assert.equal(states.WaitForResume.Parameters.TableName, '${TableName}');
  for (const state of Object.values(states)) {
    if (state.Resource === '${WorkerFunctionArn}') {
      assert.deepEqual(state.Retry, [{ ErrorEquals: ['Lambda.TooManyRequestsException'], IntervalSeconds: 5, MaxAttempts: 5, BackoffRate: 2 }]);
    } else assert.equal(state.Retry, undefined);
  }
  assert.match(states.WaitForResume.Parameters.ConditionExpression, /#status = :paused/);
  assert.match(states.WaitForResume.Parameters.ConditionExpression, /#version = :version/);
  assert.equal(states.Finish.Next, 'FinishRoute');
  assert.equal(states.FinishRoute.Choices.find((choice) => choice.StringEquals === 'PAUSED').Next, 'WaitForResume');
});

test('T-07 送信側は異なる実行ARNによる開始の重複で所有権を奪わない', async () => {
  const f = fixture();
  f.setCampaign({ execution_arn: ARN });
  assert.equal((await f.prepare({ execution_arn: `${ARN}-duplicate` })).action, 'CANCELLED');
  assert.equal(f.getCampaign().execution_arn, ARN); assert.equal(f.sends.length, 0);
  assert.equal((await f.prepare()).action, 'SEND');
  assert.equal((await f.prepare({ execution_arn: `${ARN}-duplicate` })).action, 'REVIEW');
  assert.equal(f.sends.length, 0);
});

test('T-08 一時停止後の新規送信は20件以内、未保存受付数も保存', async () => {
  const f = fixture(); await f.prepare();
  f.onSend = async (_, n) => { if (n === 9) f.setCampaign({ status: 'PAUSED', pause_reason: 'USER', version: f.getCampaign().version + 1 }); return { MessageId: `m${n}` }; };
  assert.equal((await f.send()).action, 'PAUSED'); assert.equal(f.sends.length, 9);
  assert.equal(f.getCampaign().counts.accepted, 9); assert.equal(f.getCampaign().status, 'PAUSED');
});

test('T-09 再開トークン保存の競合はSendBatchへ進み、新状態から継続', async () => {
  const caught = definition.States.WaitForResume.Catch.find((entry) => entry.ErrorEquals.includes('DynamoDb.ConditionalCheckFailedException'));
  assert.deepEqual(caught.ErrorEquals, ['DynamoDb.ConditionalCheckFailedException', 'DynamoDB.ConditionalCheckFailedException']);
  assert.equal(caught.Next, 'SendBatch');
  const f = fixture({ count: 2 }); await f.prepare();
  f.setCampaign({ status: 'PAUSED', pause_reason: 'USER' });
  f.setCampaign({ status: 'SENDING', version: f.getCampaign().version + 1 });
  assert.equal((await f.send()).action, 'SEND'); assert.equal(f.getCampaign().counts.accepted, 2);
});

test('T-10 停止中の中止・7日期限切れはFinish、ロック解放', async () => {
  const catches = definition.States.WaitForResume.Catch;
  for (const code of ['States.Timeout', 'Cancelled']) assert.equal(catches.find((item) => item.ErrorEquals.includes(code)).Next, 'CancelResult');
  const f = fixture(); await f.prepare(); f.setCampaign({ status: 'PAUSED' });
  assert.equal((await f.finish('CANCELLED')).action, 'CANCELLED');
  assert.equal(f.getCampaign().status, 'CANCELLED'); assert.equal(f.ddb.get('LOCK', 'SEND').owner, undefined);
});

for (const decision of ['SKIP', 'RESEND']) {
  test(`T-11 異常終了を自動再試行せず20件以内を要確認、${decision}位置から固定スナップショットで再開`, async () => {
    const f = fixture({ count: 30 }); await f.prepare();
    const originalSnapshot = f.files.get(`recipients/${ID}/00000.jsonl`);
    const originalGet = f.ddb.getItem;
    f.ddb.getItem = async (input) => {
      if (f.sends.length === 8 && input.Key.PK.S === 'CAMPAIGN') throw new Error('worker crashed private@example.com');
      return originalGet(input);
    };
    await assert.rejects(f.send(), (error) => error.code === 'INTERNAL' && !error.message.includes('@'));
    assert.equal(f.sends.length, 8); assert.equal(f.getCampaign().progress.index, 0);
    f.ddb.getItem = originalGet;
    await f.finish('REVIEW');
    const review = f.getCampaign().review;
    assert.equal(f.getCampaign().status, 'NEEDS_REVIEW');
    assert.equal(review.index_from, 0); assert.equal(review.index_to, 19);
    f.setCampaign({ status: 'QUEUED', review: null, progress: { chunk: review.chunk, index: decision === 'SKIP' ? review.index_to + 1 : review.index_from }, version: f.getCampaign().version + 1 });
    const newArn = `${ARN}-r1`;
    assert.equal((await f.prepare({ execution_arn: newArn, resume: true })).action, 'SEND');
    assert.equal(f.files.get(`recipients/${ID}/00000.jsonl`), originalSnapshot);
    const before = f.sends.length;
    await f.handler(f.event('send', { execution_arn: newArn }), f.context);
    const expected = JSON.parse(originalSnapshot.trim().split('\n')[decision === 'SKIP' ? 20 : 0]).e;
    assert.equal(f.sends[before].input.Destination.ToAddresses[0], expected);
  });
}

test('T-12 429は同じ宛先に最大3回再試行、進捗を進めず60秒待機', async () => {
  const f = fixture({ count: 2 }); await f.prepare();
  f.onSend = () => { throw failure('TooManyRequestsException', 429); };
  assert.equal((await f.send()).action, 'THROTTLED'); assert.equal(f.sends.length, 4);
  assert.equal(new Set(f.sends.map((item) => item.input.Destination.ToAddresses[0])).size, 1);
  assert.equal(f.getCampaign().progress.index, 0); assert.equal(definition.States.Throttled.Seconds, 60);
  f.advance(60000); f.onSend = undefined;
  await f.send(); assert.equal(f.getCampaign().counts.accepted, 2);
});

test('T-13 タイムアウトの宛先は再試行せず、5回連続で停止', async () => {
  const f = fixture(); await f.prepare(); f.onSend = () => { throw failure('TimeoutError'); };
  assert.equal((await f.send()).action, 'PAUSED'); assert.equal(f.sends.length, 5);
  assert.equal(f.getCampaign().pause_reason, 'SES_UNSTABLE'); assert.equal(f.getCampaign().progress.index, 5);
});

test('T-14 SESローリング24時間上限はQUOTA、JST翌日でも自動再開しない', async () => {
  const f = fixture(); await f.prepare();
  f.onSend = () => { throw failure('TooManyRequestsException', 429, 'Daily message quota exceeded'); };
  assert.equal((await f.send()).action, 'PAUSED'); assert.equal(f.getCampaign().pause_reason, 'QUOTA');
  f.setTime(Date.parse('2026-11-03T15:05:00Z')); f.onSend = undefined;
  assert.equal((await f.send()).action, 'PAUSED'); assert.equal(f.sends.length, 1);
});

test('T-15 評判ALARMで停止し、ALARM継続中の再開検査も失敗', async () => {
  const f = fixture(); await f.prepare(); f.alarms[0].StateValue = 'ALARM';
  assert.equal((await f.send()).action, 'PAUSED'); assert.equal(f.getCampaign().pause_reason, 'REPUTATION_ALARM');
  const result = await createPrecheck({ ...f.deps, store: f.store }).run({ campaign: f.getCampaign(), allowedStatuses: ['PAUSED'] });
  assert.equal(result.code, 'REPUTATION_ALARM'); assert.equal(f.sends.length, 0);
});

test('T-22 通常配信中の別配信はWAIT_LOCK/prepare、確定後ならWAIT_LOCK/send', async () => {
  const f = fixture(); await f.prepare();
  f.ddb.set({ ...f.getCampaign(), SK: ID2, campaign_id: ID2, status: 'QUEUED', execution_arn: '', version: 0 });
  let result = await f.handler(f.event('prepare', { campaign_id: ID2, execution_arn: `${ARN}-other` }), f.context);
  assert.deepEqual(result, { action: 'WAIT_LOCK', phase: 'prepare' });
  f.ddb.set({ ...f.getCampaign(ID2), status: 'SENDING' });
  result = await f.handler(f.event('send', { campaign_id: ID2, execution_arn: `${ARN}-other` }), f.context);
  assert.deepEqual(result, { action: 'WAIT_LOCK', phase: 'send' }); assert.equal(f.sends.length, 0);
});

test('T-25 予約起動時も認証異常を拒否しAPPROVEDへ戻し、監査に個別理由を保存', async () => {
  const f = fixture({ env: 'prod' }); f.setCampaign({ status: 'SCHEDULED' }); f.identity.DkimAttributes.Status = 'FAILED';
  assert.equal((await f.prepare()).action, 'START_FAILED'); assert.equal(f.getCampaign().status, 'APPROVED');
  assert.equal(f.getCampaign().start_error, 'AUTH_CHECK_FAILED');
  const audits = [...f.ddb.items.values()].filter((item) => item.PK.startsWith('AUDIT#'));
  assert.ok(audits.some((item) => item.action === 'PRECHECK' && item.details.code === 'AUTH_CHECK_FAILED'));
  assert.equal(f.sends.length, 0);
});

test('T-26 日次上限後は進捗を保持し翌日0時5分に再検査して継続', async () => {
  const f = fixture({ count: 3, cap: 2 }); await f.prepare();
  const wait = await f.send();
  assert.equal(wait.action, 'WAIT_DAY'); assert.equal(wait.next_attempt_at, '2026-11-03T15:05:00.000Z');
  assert.equal(wait.wait_seconds, Math.ceil((Date.parse(wait.next_attempt_at) - f.deps.now()) / 1000));
  assert.equal(f.getCampaign().progress.index, 2); assert.equal(f.getCampaign().counts.accepted, 2);
  assert.equal(f.ddb.get('LOCK', 'SEND').owner, undefined);
  f.setTime(Date.parse(wait.next_attempt_at));
  await f.send(); assert.equal(f.sends.length, 3);
  assert.equal(new Set(f.sends.map((item) => item.input.Destination.ToAddresses[0])).size, 3);
});

for (const cause of ['auth', 'quota', 'monitoring']) {
  test(`T-26 翌日継続でも${cause}異常ならPAUSED、再投入なし`, async () => {
    const f = fixture({ count: 3, cap: 2 }); await f.prepare(); const wait = await f.send(); f.setTime(Date.parse(wait.next_attempt_at));
    if (cause === 'auth') f.identity.DkimAttributes.SigningEnabled = false;
    if (cause === 'quota') f.account.SendQuota.SentLast24Hours = f.account.SendQuota.Max24HourSend;
    if (cause === 'monitoring') f.alarmError = new Error('unavailable');
    assert.equal((await f.send()).action, 'PAUSED'); assert.equal(f.sends.length, 2);
  });
}

test('T-27 MessageRejectedは1件目で要確認、次の宛先へ進まない', async () => {
  const f = fixture(); await f.prepare(); f.onSend = () => { throw failure('MessageRejected', 400, 'sensitive@example.com'); };
  const result = await f.send(); assert.deepEqual(result, { action: 'REVIEW', reason: 'MessageRejected' });
  assert.equal(f.sends.length, 1); assert.equal(f.getCampaign().progress.index, 0);
  await f.finish('REVIEW', { result }); assert.equal(f.getCampaign().status, 'NEEDS_REVIEW');
});

for (const [cause, metrics, expected] of [
  ['遅延', { send: [200], delay: [21] }, 'CAMPAIGN_DELAY'],
  ['バウンス', { delivery: [190], bounce: [11], send: [201] }, 'CAMPAIGN_BOUNCE'],
  ['欠測', {}, 'EVENTS_MISSING'],
  ['描画エラー', { rendering: [1] }, 'CONTENT_ERROR'],
]) {
  test(`T-28 ${cause}を累計メトリクスから検知し停止・通知`, async () => {
    const f = fixture(); await f.prepare(); f.metricValues = metrics;
    if (cause === '欠測') { f.setCampaign({ counts: { accepted: 200, failed: 0, unknown: 0 }, last_send_at: new Date(f.deps.now() - 901000).toISOString() }); }
    assert.equal((await f.send()).action, 'PAUSED'); assert.equal(f.getCampaign().pause_reason, expected);
    assert.ok(f.notices.some((entry) => entry.code === expected)); assert.equal(f.sends.length, 0);
  });
}

test('7.8 遅延5%超と購読設定変更2%超は通知だけで送信継続', async () => {
  const f = fixture({ count: 1 }); await f.prepare();
  f.metricValues = { send: [600], delivery: [500], delay: [31], subscription: [11] };
  assert.equal((await f.send()).action, 'SEND'); assert.equal(f.sends.length, 1);
  assert.ok(f.notices.some((entry) => entry.code === 'CAMPAIGN_DELAY_WARNING'));
  assert.ok(f.notices.some((entry) => entry.code === 'SUBSCRIPTION_WARNING'));
});

test('T-44 日次予約後のクラッシュは枠を戻さず、テストと通常配信は同時送信しない', async () => {
  const f = fixture({ cap: 1 }); await f.prepare();
  f.ddb.afterUpdate = (_, item) => { if (item.PK === 'DAILY') throw new Error('crash after reservation'); };
  await assert.rejects(f.send(), { code: 'INTERNAL' });
  assert.equal(f.ddb.get('DAILY', jstDate(f.deps.now())).reserved_attempts, 1); assert.equal(f.sends.length, 0);
  f.ddb.afterUpdate = undefined; await f.finish('REVIEW');
  assert.equal(f.ddb.get('LOCK', 'SEND').owner, undefined);
  assert.equal(f.ddb.get('DAILY', jstDate(f.deps.now())).reserved_attempts, 1);
});

test('T-45 進捗保存前の監視停止でも受付済み件数を保存し、再開時に重複しない', async () => {
  const f = fixture({ count: 12 }); await f.prepare();
  f.onSend = async (_, n) => { if (n === 7) { f.advance(60000); f.alarms[0].StateValue = 'ALARM'; } return { MessageId: `m${n}` }; };
  assert.equal((await f.send()).action, 'PAUSED'); assert.equal(f.getCampaign().counts.accepted, 7); assert.equal(f.getCampaign().progress.index, 7);
  f.alarms[0].StateValue = 'OK'; f.onSend = undefined; f.setCampaign({ status: 'SENDING', version: f.getCampaign().version + 1 });
  await f.send(); assert.equal(f.sends.length, 12);
  assert.equal(new Set(f.sends.map((item) => item.input.Destination.ToAddresses[0])).size, 12);
});

test('T-48 無履歴の少量テストは可能でも監視API故障・アラーム不在を正常扱いしない', async () => {
  const f = fixture({ env: 'prod' }); delete f.org.delivery_check; f.ddb.set(f.org);
  f.alarms[0].StateValue = 'INSUFFICIENT_DATA';
  const checker = createPrecheck({ ...f.deps, store: f.store });
  assert.equal((await checker.run({ test: true, remaining: 1 })).ok, true);
  assert.equal((await checker.run()).code, 'DELIVERY_CHECK_REQUIRED');
  f.alarms.pop(); assert.equal((await checker.run({ test: true })).code, 'MONITORING_UNAVAILABLE');
});

test('T-48 終了済み配信の15分超のSend証跡欠測でも次の一般配信を拒否', async () => {
  const f = fixture();
  f.ddb.set({ PK: 'CAMPAIGN', SK: ID2, campaign_id: ID2, status: 'COMPLETED', started_at: new Date(f.deps.now() - 1800000).toISOString(), completed_at: new Date(f.deps.now() - 1000000).toISOString(), counts: { accepted: 200 }, last_send_at: new Date(f.deps.now() - 1000000).toISOString() });
  assert.equal((await f.prepare()).action, 'START_FAILED'); assert.equal(f.getCampaign().start_error, 'EVENTS_MISSING');
});

test('7.4 7日超の配信を自動で続けず中止', async () => {
  const f = fixture(); await f.prepare(); f.setCampaign({ started_at: new Date(f.deps.now() - 7 * 86400000 - 1).toISOString() });
  assert.equal((await f.send()).action, 'CANCELLED'); assert.equal(f.getCampaign().status, 'CANCELLED'); assert.equal(f.sends.length, 0);
});
