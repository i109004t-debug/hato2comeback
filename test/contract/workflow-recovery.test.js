import test from 'node:test';
import assert from 'node:assert/strict';
import { managementFixture } from '../helpers/management.js';
import { failure, ID } from '../helpers/sending.js';
import { createPrecheck } from '../../src/common/precheck.js';

const recovery = { check_id: ID, purpose: 'ACCEPTANCE_RECOVERY', note: '設定修正後の受信ヘッダーと解除リンクを再確認する' };
const expectCode = (response, status, code) => {
  assert.equal(response.statusCode, status, response.body);
  assert.equal(response.json.error_code, code);
};
const arn = (name) => `arn:aws:states:ap-northeast-1:123456789012:execution:ht2:${name}`;
const completed = (status = 'SUCCEEDED', action = 'START_FAILED') => ({ status, input: JSON.stringify({ campaign_id: ID }), output: JSON.stringify({ campaign_id: ID, result: { action } }) });

function recoveryFixture(options = {}) {
  const f = managementFixture({ registered: true, env: 'prod', count: 2, ...options });
  f.draft();
  f.ddb.set({ PK: 'ACCEPTANCE', SK: ID, check_id: ID, schema_version: 1, status: 'OPEN', version: 0, expires_at: Math.floor(f.deps.now() / 1000) + 86400, test_sends: [], cases: {} });
  f.org.delivery_check = { ...f.delivery, status: 'FAIL' };
  f.ddb.set(f.org);
  return f;
}

for (const cause of ['expired', 'failed', 'config-changed', 'dns-changed']) {
  test(`6.6 管理者の明示的な受入復旧テストで${cause}を再確認でき、一般送信は拒否する`, async () => {
    const f = recoveryFixture();
    const delivery = { ...f.delivery };
    if (cause === 'expired') delivery.passed_at = new Date(f.deps.now() - 91 * 86400000).toISOString();
    if (cause === 'failed') delivery.status = 'FAIL';
    if (cause === 'config-changed') delivery.config_hash = 'a'.repeat(64);
    if (cause === 'dns-changed') delivery.dns_config_hash = 'b'.repeat(64);
    f.org.delivery_check = delivery; f.ddb.set(f.org);
    expectCode(await f.request(`POST ${f.campaignPath}/test-send`, {}), 422, 'DELIVERY_CHECK_REQUIRED');
    const response = await f.request(`POST ${f.campaignPath}/test-send`, recovery);
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(response.json.results.map((item) => item.status), ['ACCEPTED', 'ACCEPTED']);
    assert.deepEqual(f.ddb.get('SETTINGS', 'ORG').delivery_check, delivery);
    const rows = [...f.ddb.items.values()].filter((item) => item.PK.startsWith('AUDIT#'));
    assert.ok(rows.some((item) => item.action === 'ACCEPTANCE_RECOVERY_TEST' && item.details.note === recovery.note));
    assert.ok(rows.some((item) => item.action === 'TEST_SEND' && item.details.purpose === recovery.purpose));
    f.setCampaign({ status: 'APPROVED' });
    expectCode(await f.request(`POST ${f.campaignPath}/start`, { mode: 'NOW' }), 422, 'DELIVERY_CHECK_REQUIRED');
    assert.equal(f.executions.size, 0);
  });
}

test('6.6 受入復旧テストは管理者と是正メモが必要', async () => {
  const f = recoveryFixture({ role: 'sender' });
  expectCode(await f.request(`POST ${f.campaignPath}/test-send`, recovery), 403, 'FORBIDDEN');
  f.role = 'admin'; f.resetApi();
  for (const body of [{ purpose: recovery.purpose }, { ...recovery, note: '   ' }]) {
    expectCode(await f.request(`POST ${f.campaignPath}/test-send`, body), 400, 'INVALID_REQUEST');
  }
  assert.equal(f.sends.length, 0);
});

test('6.6 受入復旧の例外はtestの明示がなければ適用しない', async () => {
  const f = recoveryFixture();
  const checker = createPrecheck({ ...f.deps, store: f.store });
  assert.equal((await checker.run({ acceptanceRecovery: true })).code, 'DELIVERY_CHECK_REQUIRED');
  assert.equal((await checker.run({ test: true, acceptanceRecovery: true, remaining: 1 })).ok, true);
});

test('6.6 少量テストの60秒後の再検査でも復旧目的を保持する', async () => {
  const f = recoveryFixture();
  f.onSend = (_, number) => { if (number === 1) f.advance(61000); return { MessageId: `m${number}` }; };
  const response = await f.request(`POST ${f.campaignPath}/test-send`, recovery);
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(response.json.results.map((item) => item.status), ['ACCEPTED', 'ACCEPTED']);
  assert.ok(f.controls.filter((item) => item.op === 'account').length >= 2);
});

for (const [cause, status, code, modify] of [
  ['停止スイッチ', 503, 'SENDING_DISABLED', (f) => { f.settings.sending_enabled = false; }],
  ['認証', 503, 'AUTH_CHECK_FAILED', (f) => { f.identity.DkimAttributes.Status = 'FAILED'; }],
  ['サプレッション', 503, 'SUPPRESSION_MISCONFIGURED', (f) => { f.account.SuppressionAttributes.SuppressedReasons = ['BOUNCE']; }],
  ['監視', 503, 'EVENT_LOG_STALE', (f) => { f.alarms.find((item) => item.AlarmName.endsWith('firehose-delivery')).StateValue = 'ALARM'; }],
  ['送信枠', 422, 'QUOTA_INSUFFICIENT', (f) => { f.account.SendQuota.Max24HourSend = 0; }],
  ['購読解除', 422, 'TEST_RECIPIENT_NOT_REGISTERED', (f) => { f.contacts[0].UnsubscribeAll = true; }],
  ['最大5件', 422, 'SETTINGS_INCOMPLETE', (f) => { f.org.test_recipients = Array.from({ length: 6 }, (_, n) => `test${n}@example.com`); f.ddb.set(f.org); }],
]) {
  test(`6.6 受入復旧テストでも${cause}を緩和しない`, async () => {
    const f = recoveryFixture(); modify(f);
    expectCode(await f.request(`POST ${f.campaignPath}/test-send`, recovery), status, code);
    assert.equal(f.sends.length, 0);
  });
}

test('6.6 受入復旧テストでも非本番の許可リストを必須にする', async () => {
  const f = recoveryFixture({ env: 'stg' }); f.settings.nonprod_allowlist = [];
  expectCode(await f.request(`POST ${f.campaignPath}/test-send`, recovery), 422, 'RECIPIENT_NOT_ALLOWED_IN_ENV');
  assert.equal(f.sends.length, 0);
});

test('6.6 復旧テスト途中の安全条件悪化と結果不明の再送を禁止する', async () => {
  const f = recoveryFixture();
  f.onSend = () => { f.advance(61000); f.identity.VerifiedForSendingStatus = false; return { MessageId: 'one' }; };
  const result = await f.request(`POST ${f.campaignPath}/test-send`, recovery);
  assert.equal(result.json.results[1].status, 'NOT_ATTEMPTED', result.body);
  assert.equal(f.sends.length, 1);
  const g = recoveryFixture({ count: 1 }); g.onSend = () => { throw failure('TimeoutError'); };
  assert.equal((await g.request(`POST ${g.campaignPath}/test-send`, recovery)).json.results[0].status, 'UNKNOWN');
  assert.equal((await g.request(`POST ${g.campaignPath}/test-send`, recovery)).json.results[0].code, 'PRIOR_UNKNOWN');
  assert.equal(g.sends.length, 1);
});

async function failStart(mode = 'NOW') {
  const f = managementFixture({ registered: true, count: 1 });
  f.setCampaign({ status: 'APPROVED' });
  const request = { mode, ...(mode === 'SCHEDULED' ? { at: '2026-11-04T19:05:00+09:00' } : {}) };
  const response = await f.request(`POST ${f.campaignPath}/start`, request);
  assert.equal(response.statusCode, 200, response.body);
  if (mode === 'SCHEDULED') {
    const target = JSON.parse(f.schedules.get(`ht2-${ID}`).Target.Input);
    await f.deps.sfn.startExecution({ name: target.Name, stateMachineArn: target.StateMachineArn, input: target.Input });
  }
  f.identity.VerifiedForSendingStatus = false;
  assert.equal((await f.worker(f.event('prepare', { execution_arn: arn(ID) }), f.context)).action, 'START_FAILED');
  await f.worker(f.event('finish', { execution_arn: arn(ID), outcome: 'START_FAILED' }), f.context);
  assert.equal(f.getCampaign().status, 'APPROVED');
  f.identity.VerifiedForSendingStatus = true;
  f.deps.sfn.describeExecution = async (input) => { assert.equal(input.executionArn, arn(ID)); return completed(); };
  return f;
}

for (const mode of ['NOW', 'SCHEDULED']) {
  test(`7.1 ${mode}の準備失敗は終了確認後の明示的な開始で新しい実行を作る`, async () => {
    const f = await failStart(mode);
    const response = await f.request(`POST ${f.campaignPath}/start`, { mode, ...(mode === 'SCHEDULED' ? { at: '2026-11-05T19:05:00+09:00' } : {}) });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json.start_attempt, 2);
    assert.equal(f.getCampaign().execution_arn, arn(`${ID}-s2`));
    assert.equal(f.getCampaign().start_error, '');
    if (mode === 'NOW') assert.ok(f.executions.has(`${ID}-s2`));
    else {
      const target = JSON.parse(f.schedules.get(`ht2-${ID}-s2`).Target.Input);
      assert.equal(target.Name, `${ID}-s2`);
      await f.deps.sfn.startExecution({ name: target.Name, stateMachineArn: target.StateMachineArn, input: target.Input });
    }
    assert.equal((await f.worker(f.event('prepare', { execution_arn: arn(`${ID}-s2`) }), f.context)).action, 'SEND');
    await f.worker(f.event('send', { execution_arn: arn(`${ID}-s2`) }), f.context);
    assert.equal(f.sends.length, 1);
  });
}

for (const [status, action] of [['RUNNING', 'START_FAILED'], ['FAILED', 'START_FAILED'], ['SUCCEEDED', 'DONE']]) {
  test(`7.1 前回が${status}/${action}なら未送信終了とみなさず開始を拒否`, async () => {
    const f = await failStart();
    f.deps.sfn.describeExecution = async () => completed(status, action);
    expectCode(await f.request(`POST ${f.campaignPath}/start`, { mode: 'NOW' }), 409, 'STATE_CONFLICT');
    assert.equal(f.getCampaign().status, 'APPROVED');
    assert.equal(f.getCampaign().start_attempt, 1);
    assert.equal(f.executions.size, 1);
  });
}

test('7.1 終了結果の取得失敗・別配信・既送信の履歴があれば再投入しない', async () => {
  const f = await failStart();
  f.deps.sfn.describeExecution = async () => { throw failure('ExecutionDoesNotExist', 400); };
  expectCode(await f.request(`POST ${f.campaignPath}/start`, { mode: 'NOW' }), 409, 'STATE_CONFLICT');
  f.deps.sfn.describeExecution = async () => ({ ...completed(), output: JSON.stringify({ campaign_id: 'other', result: { action: 'START_FAILED' } }) });
  expectCode(await f.request(`POST ${f.campaignPath}/start`, { mode: 'NOW' }), 409, 'STATE_CONFLICT');
  f.deps.sfn.describeExecution = async () => completed();
  f.setCampaign({ counts: { accepted: 1 } });
  expectCode(await f.request(`POST ${f.campaignPath}/start`, { mode: 'NOW' }), 409, 'STATE_CONFLICT');
  assert.equal(f.executions.size, 1);
});

test('7.1 StartExecutionの応答消失後はQUEUEDを保ち別名で再投入しない', async () => {
  const f = managementFixture(); f.setCampaign({ status: 'APPROVED' });
  const send = f.deps.sfn.startExecution;
  f.deps.sfn.startExecution = async (input) => { await send(input); throw failure('TimeoutError'); };
  assert.equal((await f.request(`POST ${f.campaignPath}/start`, { mode: 'NOW' })).statusCode, 200);
  expectCode(await f.request(`POST ${f.campaignPath}/start`, { mode: 'NOW' }), 409, 'STATE_CONFLICT');
  assert.equal(f.getCampaign().status, 'QUEUED'); assert.equal(f.getCampaign().start_attempt, 1);
  assert.equal(f.executions.size, 1); assert.equal(f.sends.length, 0);
});

test('7.1 予約取り消し後に遅れて届いた旧実行は新しい予約を開始できない', async () => {
  const f = managementFixture(); f.setCampaign({ status: 'APPROVED' });
  const body = { mode: 'SCHEDULED', at: '2026-11-04T19:05:00+09:00' };
  assert.equal((await f.request(`POST ${f.campaignPath}/start`, body)).statusCode, 200);
  assert.equal((await f.request(`POST ${f.campaignPath}/unschedule`, {})).statusCode, 200);
  assert.equal((await f.request(`POST ${f.campaignPath}/start`, { ...body, at: '2026-11-05T19:05:00+09:00' })).statusCode, 200);
  assert.equal((await f.worker(f.event('prepare', { execution_arn: arn(ID) }), f.context)).action, 'CANCELLED');
  assert.equal(f.getCampaign().status, 'SCHEDULED');
  assert.equal(f.getCampaign().execution_arn, arn(`${ID}-s2`));
  assert.equal(f.sends.length, 0);
});

test('7.1 更新前の予約を取り消した記録でも旧実行名を再利用しない', async () => {
  const f = managementFixture();
  f.setCampaign({ status: 'SCHEDULED', start_mode: 'SCHEDULED', schedule_name: `ht2-${ID}`, scheduled_at: '2026-11-04T10:05:00Z' });
  f.schedules.set(`ht2-${ID}`, {});
  assert.equal((await f.request(`POST ${f.campaignPath}/unschedule`, {})).statusCode, 200);
  const response = await f.request(`POST ${f.campaignPath}/start`, { mode: 'SCHEDULED', at: '2026-11-05T19:05:00+09:00' });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json.start_execution_name, `${ID}-s2`);
  assert.equal((await f.worker(f.event('prepare', { execution_arn: arn(ID) }), f.context)).action, 'CANCELLED');
  assert.equal(f.getCampaign().status, 'SCHEDULED');
  assert.equal(f.sends.length, 0);
});
