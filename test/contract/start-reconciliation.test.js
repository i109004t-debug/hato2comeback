import test from 'node:test';
import assert from 'node:assert/strict';
import { managementFixture } from '../helpers/management.js';
import { failure, ID, ID2 } from '../helpers/sending.js';

const request = (mode) => ({ mode, ...(mode === 'SCHEDULED' ? { at: '2026-11-04T19:05:00+09:00' } : {}) });
const codes = (f) => f.notices.filter((item) => item.id === ID).map((item) => item.code);

for (const mode of ['NOW', 'SCHEDULED']) {
  const status = mode === 'NOW' ? 'QUEUED' : 'SCHEDULED';
  const service = mode === 'NOW' ? 'sfn' : 'scheduler';
  const operation = mode === 'NOW' ? 'startExecution' : 'createSchedule';
  const reason = mode === 'NOW' ? 'START_EXECUTION' : 'CREATE_SCHEDULE';

  test(`7.1 ${mode}の作成失敗は不存在確認後だけ承認済みに戻し、明示再開始できる`, async () => {
    const f = managementFixture({ count: 1 }); f.setCampaign({ status: 'APPROVED' });
    const create = f.deps[service][operation];
    let attempts = 0;
    f.deps[service][operation] = async () => { attempts += 1; throw failure('AccessDeniedException', 403, 'private@example.com token=secret'); };
    const response = await f.request(`POST ${f.campaignPath}/start`, request(mode));
    assert.equal(response.statusCode, 503, response.body);
    assert.equal(response.json.error_code, 'MONITORING_UNAVAILABLE');
    assert.equal(f.getCampaign().status, 'APPROVED');
    assert.equal(f.getCampaign().start_error, `${reason}_FAILED`);
    assert.equal(f.getCampaign().execution_arn, undefined);
    assert.equal(f.getCampaign().schedule_name, undefined);
    assert.equal(f.getCampaign().scheduled_at, undefined);
    assert.ok(!JSON.stringify(f.getCampaign()).includes('private@example.com'));
    assert.ok(!response.body.includes('secret'));
    assert.equal(attempts, 1);
    f.deps[service][operation] = create;
    const retried = await f.request(`POST ${f.campaignPath}/start`, request(mode));
    assert.equal(retried.statusCode, 200, retried.body);
    assert.equal(retried.json.start_execution_name, `${ID}-s2`);
    assert.equal(retried.json.status, status);
    assert.equal(f.sends.length, 0);
  });

  test(`7.1 ${mode}の作成結果が照合不能なら状態を保って503、再投入しない`, async () => {
    const f = managementFixture(); f.setCampaign({ status: 'APPROVED' });
    let attempts = 0;
    f.deps[service][operation] = async () => { attempts += 1; throw failure('TimeoutError'); };
    if (mode === 'NOW') f.deps.sfn.describeExecution = async () => { throw failure('AccessDeniedException', 403); };
    else f.deps.scheduler.getSchedule = async () => { throw failure('TimeoutError'); };
    const response = await f.request(`POST ${f.campaignPath}/start`, request(mode));
    assert.equal(response.statusCode, 503, response.body);
    assert.equal(f.getCampaign().status, status);
    assert.equal(f.getCampaign().start_error, `${reason}_UNCONFIRMED`);
    assert.equal((await f.request(`POST ${f.campaignPath}/start`, request(mode))).statusCode, 409);
    assert.equal(attempts, 1);
    assert.equal(f.sends.length, 0);
  });

  test(`7.1 ${mode}の作成応答消失でもリソースがあれば成功として扱う`, async () => {
    const f = managementFixture(); f.setCampaign({ status: 'APPROVED' });
    const create = f.deps[service][operation];
    f.deps[service][operation] = async (input) => { await create(input); throw failure('TimeoutError'); };
    const response = await f.request(`POST ${f.campaignPath}/start`, request(mode));
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json.status, status);
    assert.equal(f.getCampaign().start_error, '');
    assert.equal(f.executions.size + f.schedules.size, 1);
    assert.equal(f.sends.length, 0);
  });
}

test('7.1 予約が見つからなくても実行の照合不能なら承認済みへ戻さない', async () => {
  const f = managementFixture(); f.setCampaign({ status: 'APPROVED' });
  f.deps.scheduler.createSchedule = async () => { throw failure('TimeoutError'); };
  f.deps.sfn.describeExecution = async () => { throw failure('TimeoutError'); };
  const response = await f.request(`POST ${f.campaignPath}/start`, request('SCHEDULED'));
  assert.equal(response.statusCode, 503, response.body);
  assert.equal(f.getCampaign().status, 'SCHEDULED');
  assert.equal(f.getCampaign().start_error, 'CREATE_SCHEDULE_UNCONFIRMED');
});

test('7.1 予約作成の応答消失後に予約が発火・自動削除されていても巻き戻さない', async () => {
  const f = managementFixture(); f.setCampaign({ status: 'APPROVED' });
  f.deps.scheduler.createSchedule = async (input) => {
    const target = JSON.parse(input.Target.Input);
    await f.deps.sfn.startExecution({ name: target.Name, input: target.Input });
    throw failure('TimeoutError');
  };
  assert.equal((await f.request(`POST ${f.campaignPath}/start`, request('SCHEDULED'))).statusCode, 200);
  assert.equal(f.getCampaign().status, 'SCHEDULED');
  assert.equal(f.executions.size, 1);
});

test('7.1 予約作成失敗の照合で異なる予約が見つかっても承認済みへ戻さない', async () => {
  const f = managementFixture(); f.setCampaign({ status: 'APPROVED' });
  f.schedules.set(`pl-${ID}`, { ScheduleExpression: 'at(2027-01-01T00:00:00)' });
  assert.equal((await f.request(`POST ${f.campaignPath}/start`, request('SCHEDULED'))).statusCode, 409);
  assert.equal(f.getCampaign().status, 'SCHEDULED');
});

test('7.1 不存在照合後の巻戻しはversion競合時に進行中の状態を上書きしない', async () => {
  const f = managementFixture(); f.setCampaign({ status: 'APPROVED' });
  f.deps.sfn.startExecution = async () => { throw failure('TimeoutError'); };
  f.deps.sfn.describeExecution = async () => {
    f.setCampaign({ status: 'SENDING', version: f.getCampaign().version + 1, started_at: new Date(f.deps.now()).toISOString() });
    throw failure('ExecutionDoesNotExist', 400);
  };
  assert.equal((await f.request(`POST ${f.campaignPath}/start`, request('NOW'))).statusCode, 503);
  assert.equal(f.getCampaign().status, 'SENDING');
  assert.ok(f.getCampaign().started_at);
});

for (const mode of ['NOW', 'SCHEDULED']) {
  test(`7.1 ${mode}の不存在確認後でも再開始時に旧リソースが現れたら新規作成しない`, async () => {
    const f = managementFixture(); f.setCampaign({ status: 'APPROVED' });
    const service = mode === 'NOW' ? f.deps.sfn : f.deps.scheduler;
    const operation = mode === 'NOW' ? 'startExecution' : 'createSchedule';
    const create = service[operation];
    service[operation] = async () => { throw failure('TimeoutError'); };
    assert.equal((await f.request(`POST ${f.campaignPath}/start`, request(mode))).statusCode, 503);
    service[operation] = create;
    if (mode === 'NOW') f.executions.set(ID, { input: JSON.stringify({ campaign_id: ID }) });
    else f.schedules.set(`pl-${ID}`, {});
    assert.equal((await f.request(`POST ${f.campaignPath}/start`, request(mode))).statusCode, 409);
    assert.equal(f.getCampaign().start_attempt, 1);
  });
}

for (const status of ['QUEUED', 'SCHEDULED']) {
  test(`13.4 ${status}の欠落は15分以降の日次点検でSNS通知し、自動再作成しない`, async () => {
    const f = managementFixture({ count: 0 }); f.setCampaign({ status, start_requested_at: new Date(f.deps.now()).toISOString() });
    f.deps.sesControl = f.deps.ses;
    f.resetWorker();
    f.advance(899999);
    await f.worker({ mode: 'daily' }, f.context);
    assert.deepEqual(codes(f), []);
    f.advance(1);
    const result = await f.worker({ mode: 'daily' }, f.context);
    assert.equal(result.results.campaigns, 'PASS');
    assert.deepEqual(codes(f), [status === 'QUEUED' ? 'QUEUED_EXECUTION_MISSING' : 'SCHEDULED_SCHEDULE_MISSING']);
    assert.equal(f.getCampaign().status, status);
    assert.equal(f.executions.size + f.schedules.size, 0);
    assert.equal(f.sends.length, 0);
  });
}

test('13.4 正常な開始待ちと将来の予約、発火後の予約自動削除は欠落通知しない', async () => {
  for (const kind of ['execution', 'schedule', 'fired']) {
    const f = managementFixture({ count: 0 });
    f.setCampaign({ status: kind === 'execution' ? 'QUEUED' : 'SCHEDULED' });
    if (kind === 'schedule') f.schedules.set(`pl-${ID}`, { ScheduleExpression: 'at(2026-11-04T19:05:00)' });
    else f.executions.set(ID, { input: JSON.stringify({ campaign_id: ID }) });
    f.advance(900000);
    assert.equal((await f.worker({ mode: 'daily' }, f.context)).results.campaigns, 'PASS');
    assert.deepEqual(codes(f), [], kind);
  }
});

test('13.4 照合障害は要確認としてSNS通知し、後続配信の欠落点検を続ける', async () => {
  const f = managementFixture({ count: 0 });
  f.ddb.set({ ...f.getCampaign(), SK: ID2, campaign_id: ID2 });
  f.deps.sfn.describeExecution = async ({ executionArn }) => { throw failure(executionArn.endsWith(ID) ? 'AccessDeniedException' : 'ExecutionDoesNotExist', 400); };
  f.advance(900000);
  const messages = [];
  delete f.deps.notify;
  f.deps.alertTopicArn = 'arn:aws:sns:ap-northeast-1:123456789012:alerts';
  f.deps.sns = { publish: async (input) => { messages.push(JSON.parse(input.Message)); return {}; } };
  f.resetWorker();
  assert.equal((await f.worker({ mode: 'daily' }, f.context)).results.campaigns, 'PASS');
  assert.ok(messages.some((item) => item.campaign_id === ID && item.code === 'START_CHECK_UNAVAILABLE'));
  assert.ok(messages.some((item) => item.campaign_id === ID2 && item.code === 'QUEUED_EXECUTION_MISSING'));
  assert.equal(f.getCampaign().status, 'QUEUED');
});
