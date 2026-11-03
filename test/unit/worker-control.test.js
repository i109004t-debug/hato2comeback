import test from 'node:test';
import assert from 'node:assert/strict';
import { unmarshall } from '../../src/common/ddb.js';
import { fixture, failure, ID, ARN } from '../helpers/sending.js';

test('7.4 20通ごとの進捗・件数保存とバッチの完了位置', async () => {
  const f = fixture({ count: 45 }); assert.equal((await f.prepare()).action, 'SEND');
  f.ddb.calls.length = 0;
  assert.equal((await f.send()).action, 'SEND');
  const progress = f.ddb.calls.filter((input) => input.Key?.PK.S === 'CAMPAIGN' && Object.values(input.ExpressionAttributeNames).includes('progress'));
  assert.deepEqual(progress.map((input) => {
    const field = Object.entries(input.ExpressionAttributeNames).find(([, name]) => name === 'progress')[0];
    const value = input.UpdateExpression.match(new RegExp(`${field} = (:\\w+)`))[1];
    return unmarshall(input.ExpressionAttributeValues)[value];
  }), [{ chunk: 0, index: 20 }, { chunk: 0, index: 40 }, { chunk: 1, index: 0 }]);
  assert.ok(progress.every((input) => !input.ConditionExpression.includes('status') && Object.values(input.ExpressionAttributeNames).includes('version')));
  assert.equal(f.getCampaign().counts.accepted, 45);
  assert.equal((await f.send()).action, 'DONE');
  assert.equal((await f.finish('DONE')).action, 'DONE'); assert.equal(f.getCampaign().status, 'COMPLETED');
  assert.equal(f.ddb.get('LOCK', 'SEND').owner, undefined);
});

for (const status of ['PAUSED', 'CANCELLED']) {
  test(`7.4 進捗保存前の${status}を保持し、直前の受付件数を保存する`, async () => {
    const f = fixture(); await f.prepare();
    f.onSend = async (_, n) => {
      if (n === 7) f.setCampaign({ status, pause_reason: 'USER', version: f.getCampaign().version + 1 });
      return { MessageId: `m${n}` };
    };
    assert.equal((await f.send()).action, status);
    assert.equal(f.sends.length, 7); assert.equal(f.getCampaign().counts.accepted, 7);
    assert.deepEqual(f.getCampaign().progress, { chunk: 0, index: 7 });
    assert.equal(f.getCampaign().status, status); assert.equal(f.ddb.get('LOCK', 'SEND').owner, undefined);
  });
}

test('7.4 残時間15秒未満で未試行の位置を保存する', async () => {
  const f = fixture(); await f.prepare();
  f.onSend = async (_, n) => { if (n === 3) f.setRemaining(14999); return { MessageId: `m${n}` }; };
  assert.equal((await f.send()).action, 'SEND');
  assert.equal(f.getCampaign().progress.index, 3); assert.equal(f.getCampaign().counts.accepted, 3);
  f.setRemaining(900000); f.onSend = undefined;
  await f.send(); assert.equal(f.sends.length, 45);
  assert.equal(new Set(f.sends.map((entry) => entry.input.Destination.ToAddresses[0])).size, 45);
});

test('7.4 429再試行待機に残時間が足りなければ未試行位置で中断', async () => {
  const f = fixture(); await f.prepare();
  f.onSend = () => { f.setRemaining(15500); throw failure('TooManyRequestsException', 429); };
  assert.equal((await f.send()).action, 'SEND');
  assert.equal(f.sends.length, 1); assert.equal(f.getCampaign().progress.index, 0);
  assert.equal(f.getCampaign().counts.accepted, 0);
});

test('7.4/8.2 結果不明5回で停止、JSONL結果と位置を保存し再送しない', async () => {
  const f = fixture(); await f.prepare();
  f.onSend = () => { throw failure('TimeoutError', undefined, 'private@example.com token=private'); };
  assert.equal((await f.send()).action, 'PAUSED');
  assert.equal(f.getCampaign().pause_reason, 'SES_UNSTABLE');
  assert.equal(f.getCampaign().counts.unknown, 5); assert.equal(f.getCampaign().progress.index, 5);
  const result = f.files.get(`results/${ID}/00000-000.jsonl`).trim().split('\n').map(JSON.parse);
  assert.equal(result.length, 5); assert.ok(result.every((row) => row.r === 'UNKNOWN' && row.c === 'TimeoutError' && row.t));
  assert.equal(f.sends.length, 5);
  f.setCampaign({ status: 'SENDING', version: f.getCampaign().version + 1 }); f.onSend = undefined;
  await f.send(); assert.equal(f.sends.length, 45);
  assert.equal(new Set(f.sends.map((entry) => entry.input.Destination.ToAddresses[0])).size, 45);
});

test('7.4 flushの楽観ロック競合時も中止状態を上書きせず件数は1回加算', async () => {
  const f = fixture(); await f.prepare(); let raced = false;
  f.ddb.beforeUpdate = (input) => {
    if (!raced && input.Key.PK.S === 'CAMPAIGN' && Object.values(input.ExpressionAttributeNames).includes('progress')) {
      raced = true; f.setCampaign({ status: 'CANCELLED', version: f.getCampaign().version + 1 });
    }
  };
  assert.equal((await f.send()).action, 'CANCELLED');
  assert.equal(f.getCampaign().counts.accepted, 20); assert.equal(f.sends.length, 20);
});

test('7.4 pauseの条件更新と中止の競合でも最新の中止を保持', async () => {
  const f = fixture(); await f.prepare();
  f.onSend = async (_, n) => { if (n === 3) f.settings.sending_enabled = false; return { MessageId: `m${n}` }; };
  let raced = false;
  f.ddb.beforeUpdate = (input) => {
    const values = Object.values(unmarshall(input.ExpressionAttributeValues ?? {}));
    if (!raced && input.Key.PK.S === 'CAMPAIGN' && values.includes('PAUSED')) {
      raced = true; f.setCampaign({ status: 'CANCELLED', version: f.getCampaign().version + 1 });
    }
  };
  assert.equal((await f.send()).action, 'CANCELLED');
  assert.equal(f.getCampaign().counts.accepted, 3); assert.equal(f.getCampaign().status, 'CANCELLED');
});

test('7.9 古い実行は送信せず、新しい実行のロックも解放しない', async () => {
  const f = fixture(); await f.prepare(); f.setCampaign({ execution_arn: `${ARN}-new` });
  assert.equal((await f.send()).action, 'CANCELLED');
  await f.finish('CANCELLED'); assert.equal(f.ddb.get('LOCK', 'SEND').owner, ID); assert.equal(f.sends.length, 0);
});

test('7.4 バッチ切替と停止・再開の境界でも送信開始間隔を守る', async () => {
  const f = fixture({ count: 8, batchSize: 3 }); await f.prepare();
  await f.send(); await f.send();
  f.onSend = async (_, n) => { if (n === 7) f.setCampaign({ status: 'PAUSED', pause_reason: 'USER' }); return { MessageId: `m${n}` }; };
  assert.equal((await f.send()).action, 'PAUSED');
  f.setCampaign({ status: 'SENDING' }); f.onSend = undefined; await f.send();
  assert.equal(f.sends.length, 8);
  assert.ok(f.sends.slice(1).every((call, i) => call.time - f.sends[i].time >= 100));
});

test('7.3 ページ全取得、重複・全停止・非許可宛先の除外と固定JSONL', async () => {
  const f = fixture({ count: 3, batchSize: 2 });
  f.contactPages = [{ Contacts: [f.contacts[0], f.contacts[0], { ...f.contacts[1], UnsubscribeAll: true }], NextToken: '1' }, { Contacts: [f.contacts[2], { EmailAddress: 'outsider@example.com' }] }];
  assert.equal((await f.prepare()).action, 'SEND');
  assert.equal(f.getCampaign().recipients_total, 2); assert.equal(f.getCampaign().counts.excluded_allowlist, 1);
  assert.equal(f.listInputs.length, 2); assert.equal(f.listInputs[0].PageSize, 1000);
  assert.deepEqual(f.listInputs[0].Filter, { FilteredStatus: 'OPT_IN', TopicFilter: { TopicName: 'news', UseDefaultIfPreferenceUnavailable: true } });
  assert.equal(f.files.get(`recipients/${ID}/00000.jsonl`).trim().split('\n').length, 2);
});

test('7.3 0件と件数超過の終了、開始前検査の失敗を記録してロック解放', async () => {
  const empty = fixture({ count: 0 }); assert.equal((await empty.prepare()).action, 'DONE');
  await empty.finish('DONE'); assert.equal(empty.getCampaign().status, 'COMPLETED');
  const f = fixture(); f.settings.max_recipients_per_campaign = 2;
  assert.equal((await f.prepare()).action, 'START_FAILED'); assert.equal(f.getCampaign().status, 'APPROVED');
  assert.equal(f.getCampaign().start_error, 'TOO_MANY_RECIPIENTS'); assert.equal(f.ddb.get('LOCK', 'SEND').owner, undefined);
});

test('7.7 S3読取障害でもMarkReviewはスナップショット記録から20件以下を確定', async () => {
  const f = fixture({ count: 23 }); await f.prepare(); f.setCampaign({ progress: { chunk: 0, index: 20 } });
  f.files.delete(`recipients/${ID}/00000.jsonl`);
  await f.finish('REVIEW'); assert.deepEqual(f.getCampaign().review, { chunk: 0, index_from: 20, index_to: 22, reason: 'WORKER_FAILED' });
});

test('handlerは不正な取込IDと未知モードを受理しない', async () => {
  const f = fixture();
  await assert.rejects(f.handler({ mode: 'import' }), { code: 'INVALID_REQUEST' });
  assert.deepEqual(await f.handler({ mode: 'import', import_id: ID }), { status: 'NOT_FOUND' });
  await assert.rejects(f.handler({ mode: 'bad' }), { code: 'INVALID_REQUEST' });
});

test('7.5 宛先エラーの連続回数はバッチ切替でも保持し、5回目で止める', async () => {
  const f = fixture({ count: 8, batchSize: 2 }); await f.prepare();
  f.onSend = () => { throw failure('BadRequestException', 400, 'Invalid email address'); };
  assert.equal((await f.send()).action, 'SEND');
  assert.equal((await f.send()).action, 'SEND');
  assert.equal((await f.send()).action, 'REVIEW');
  assert.equal(f.sends.length, 5); assert.equal(f.getCampaign().counts.failed, 4);
  assert.deepEqual(f.getCampaign().progress, { chunk: 2, index: 0 });
});

test('7.2 Finish直前の一時停止を保持し、ステートマシンは再開待ちへ戻せる', async () => {
  const f = fixture({ count: 1 }); await f.prepare(); await f.send();
  assert.equal((await f.send()).action, 'DONE');
  f.setCampaign({ status: 'PAUSED', pause_reason: 'USER', version: f.getCampaign().version + 1 });
  assert.equal((await f.finish('DONE')).action, 'PAUSED');
  assert.equal(f.getCampaign().status, 'PAUSED');
});

test('7.7 準備中の異常終了は再生成が必要な要確認として記録', async () => {
  const f = fixture(); f.setCampaign({ execution_arn: ARN });
  await f.finish('REVIEW'); assert.deepEqual(f.getCampaign().review, { phase: 'prepare', reason: 'WORKER_FAILED' });
});

test('7.4 失敗結果のS3保存失敗は進捗を進めず、範囲を要確認に残す', async () => {
  const f = fixture({ count: 23 }); await f.prepare();
  f.onSend = () => { throw failure('BadRequestException', 400, 'Invalid email address'); };
  f.onPut = (input) => { if (input.Key.startsWith('results/')) throw new Error('results unavailable'); };
  await assert.rejects(f.send(), { code: 'INTERNAL' });
  assert.equal(f.getCampaign().progress.index, 0);
  f.onPut = undefined; await f.finish('REVIEW');
  assert.equal(f.getCampaign().review.index_to, 19);
});
