import test from 'node:test';
import assert from 'node:assert/strict';
import { createSender, classifySendError, buildSendInput } from '../../src/common/sender.js';
import { createSendLock } from '../../src/common/lock.js';
import { createPrecheck } from '../../src/common/precheck.js';
import { fixture, failure, ID, ARN } from '../helpers/sending.js';
import { jstDate } from '../../src/common/time.js';

async function session(f, testSend = false) {
  f.setCampaign({ status: 'SENDING', execution_arn: ARN, started_at: new Date(f.deps.now()).toISOString(), rate_per_sec: 10, progress: { chunk: 0, index: 0 }, chunks_total: 1, recipients_total: 45, counts: { accepted: 0, failed: 0, unknown: 0 } });
  const lock = createSendLock({ ...f.deps, store: f.store });
  const owner = testSend ? 'test:request' : ID;
  await lock.acquire(owner, 7200);
  const sender = createSender({ ...f.deps, store: f.store, lock, precheck: createPrecheck({ ...f.deps, store: f.store }) });
  const limiter = { interval: 100, next: f.deps.now() };
  const context = { owner, campaignId: ID, executionArn: ARN, test: testSend, remainingTime: f.context.getRemainingTimeInMillis };
  return { sender, limiter, context, lock, send: (address = f.addresses[0]) => sender.trySend(buildSendInput(f.getCampaign(), address, { ...f.deps, test: testSend }), limiter, context) };
}

test('7.5 trySendの全分類、HTTP状態のない例外・全5xxはUNKNOWN', () => {
  const cases = [
    ['TooManyRequestsException', 429, 'Maximum sending rate exceeded', 'RATE_LIMIT'],
    ['TooManyRequestsException', 429, 'Daily message quota exceeded', 'QUOTA'],
    ['ThrottlingException', 400, 'Maximum sending rate exceeded', 'RATE_LIMIT'],
    ['ThrottlingException', 400, 'Daily message quota exceeded', 'QUOTA'],
    ['ThrottlingException', 400, 'Unrecognized throttling message', 'CONFIG_ERROR'],
    ['LimitExceededException', 400, '24 hour sending limit exceeded', 'QUOTA'],
    ['SendingPausedException', 400, '', 'SES_PAUSED'], ['AccountSuspendedException', 400, '', 'SES_PAUSED'],
    ['BadRequestException', 400, 'Invalid email address', 'FAILED'], ['BadRequestException', 400, 'Invalid template', 'CONFIG_ERROR'],
    ...['AccessDeniedException', 'MessageRejected', 'MailFromDomainNotVerifiedException', 'NotFoundException', 'UnrecognizedClientException'].map((name) => [name, 400, '', 'CONFIG_ERROR']),
    ['TimeoutError', undefined, '', 'UNKNOWN'], ['AccessDeniedException', undefined, '', 'UNKNOWN'],
    ...[500, 501, 502, 503, 504].map((status) => ['ServiceException', status, '', 'UNKNOWN']),
  ];
  for (const [name, status, message, type] of cases) assert.equal(classifySendError(failure(name, status, message)).type, type, `${name}/${status}`);
});

test('7.4.1 応答遅延と待機超過後も実開始間隔を守り、追いつき送信をしない', async () => {
  const f = fixture(); const s = await session(f);
  f.onSend = async () => { f.advance(230); return { MessageId: 'ok' }; };
  await s.send(); await s.send();
  f.onSend = undefined;
  f.onSleep = () => f.advance(250);
  await s.send(); await s.send(); await s.send();
  assert.ok(f.sends.slice(1).every((call, i) => call.time - f.sends[i].time >= 100));
  assert.ok(f.sends.at(-1).time - f.sends.at(-2).time >= 350);
});

test('7.5 429は1・2・4秒、最大20%のゆらぎ、初回と再試行3回が日次枠を消費', async () => {
  const f = fixture(); f.deps.random = () => 1;
  f.onSend = () => { throw failure('TooManyRequestsException', 429, 'Maximum sending rate exceeded'); };
  const s = await session(f);
  assert.equal((await s.send()).type, 'THROTTLED');
  assert.equal(f.sends.length, 4);
  assert.deepEqual(f.sleeps, [1200, 2400, 4800]);
  assert.equal(f.ddb.get('DAILY', jstDate(f.deps.now())).reserved_attempts, 4);
  assert.ok(f.sends.every((entry) => entry.input.Destination.ToAddresses[0] === f.addresses[0]));
});

test('7.5 429再試行直前の停止を検知し、次の試行を開始しない', async () => {
  const f = fixture(); const s = await session(f);
  f.onSend = () => { throw failure('TooManyRequestsException', 429); };
  f.onSleep = () => f.setCampaign({ status: 'PAUSED', pause_reason: 'USER' });
  assert.equal((await s.send()).type, 'PAUSE'); assert.equal(f.sends.length, 1);
});

test('7.5 UNKNOWNは再試行せず、MessageId欠落もUNKNOWN', async () => {
  const f = fixture(); const s = await session(f);
  f.onSend = () => { throw failure('TimeoutError'); };
  assert.equal((await s.send()).type, 'UNKNOWN'); assert.equal(f.sends.length, 1);
  f.onSend = async () => ({});
  assert.equal((await s.send()).code, 'MISSING_MESSAGE_ID'); assert.equal(f.sends.length, 2);
});

test('7.5 宛先BadRequestが同じコードで5回続くとCONFIG_ERROR', async () => {
  const f = fixture(); const s = await session(f);
  f.onSend = () => { throw failure('BadRequestException', 400, 'Invalid email address'); };
  for (let i = 0; i < 4; i += 1) assert.equal((await s.send()).type, 'FAILED');
  assert.equal((await s.send()).type, 'CONFIG_ERROR');
});

test('7.4.1 最新SES枠から受付済みと不明を保守的に減算', async () => {
  const f = fixture(); f.account.SendQuota.Max24HourSend = 2;
  const s = await session(f);
  assert.equal((await s.send()).type, 'ACCEPTED');
  f.onSend = () => { throw failure('TimeoutError'); };
  assert.equal((await s.send()).type, 'UNKNOWN');
  assert.equal((await s.send()).type, 'QUOTA');
  assert.equal(f.sends.length, 2);
});

test('7.4.1 60秒以上の速度待機後は認証・監視を更新し、停止後に送らない', async () => {
  const f = fixture(); const s = await session(f);
  await s.send();
  s.limiter.next = f.deps.now() + 61000;
  f.onSleep = () => { if (f.deps.now() - f.sends[0].time >= 60000) f.identity.DkimAttributes.SigningEnabled = false; };
  const result = await s.send();
  assert.equal(result.type, 'PAUSE'); assert.equal(result.reason, 'AUTH_CHECK'); assert.equal(f.sends.length, 1);
  assert.equal(f.controls.length, 2);
});

test('7.4.1 SES上限の低下を更新後すぐ間隔に反映', async () => {
  const f = fixture(); const s = await session(f); await s.send();
  f.advance(60000); f.account.SendQuota.MaxSendRate = 1;
  await s.send(); await s.send();
  assert.equal(s.limiter.interval, 1250);
  assert.ok(f.sends[2].time - f.sends[1].time >= 1250);
});

test('7.4.1 予約直後の深夜越えは両日を予約し、旧予約を戻さない', async () => {
  const f = fixture({ time: Date.parse('2026-11-03T14:59:59.999Z') });
  const s = await session(f);
  let moved = false;
  f.ddb.afterUpdate = (_, item) => { if (item.PK === 'DAILY' && !moved) { moved = true; f.advance(2); } };
  assert.equal((await s.send()).type, 'ACCEPTED');
  assert.equal(f.ddb.get('DAILY', '2026-11-03').reserved_attempts, 1);
  assert.equal(f.ddb.get('DAILY', '2026-11-04').reserved_attempts, 1);
});

test('7.4.1 日次予約後の停止でも予約を減算しない', async () => {
  const f = fixture(); const s = await session(f);
  f.ddb.afterUpdate = (_, item) => { if (item.PK === 'DAILY') f.setCampaign({ status: 'CANCELLED' }); };
  assert.equal((await s.send()).type, 'PAUSE'); assert.equal(f.sends.length, 0);
  assert.equal(f.ddb.get('DAILY', jstDate(f.deps.now())).reserved_attempts, 1);
});

test('7.4.1 日次予約のDDB障害はWAIT_DAYにせず異常終了', async () => {
  const f = fixture(); const s = await session(f);
  f.ddb.beforeUpdate = (input) => { if (unmarshallKey(input) === 'DAILY') throw new Error('unavailable'); };
  await assert.rejects(s.send(), /unavailable/); assert.equal(f.sends.length, 0);
});
const unmarshallKey = (input) => input.Key.PK.S;

test('6.6 テスト送信も共有枠、許可先・購読・日次枠を検査', async () => {
  const f = fixture({ cap: 1 }); const s = await session(f, true);
  assert.equal((await s.send()).type, 'ACCEPTED');
  assert.equal(f.sends[0].input.EmailTags[0].Value, 'test');
  assert.equal((await s.send()).type, 'WAIT_DAY');
  f.contacts[1].UnsubscribeAll = true;
  assert.equal((await s.send(f.addresses[1])).code, 'TEST_RECIPIENT_NOT_REGISTERED');
  assert.equal((await s.send(f.addresses[6])).code, 'RECIPIENT_NOT_ALLOWED_IN_ENV');
});

test('6.6 本番テストは受入記録の未登録だけを許容し、失効済みを回避できない', async () => {
  const f = fixture({ env: 'prod' }); delete f.org.delivery_check; f.ddb.set(f.org);
  const s = await session(f, true);
  assert.equal((await s.send()).type, 'ACCEPTED');
  f.org.delivery_check = { ...f.delivery, status: 'FAIL' }; f.ddb.set(f.org);
  f.advance(60000);
  assert.equal((await s.send()).reason, 'AUTH_CHECK');
});

test('7.4.1 実行ARNの不一致と期限切れロックでは送信しない', async () => {
  const f = fixture(); const s = await session(f);
  f.setCampaign({ execution_arn: `${ARN}-new` });
  assert.equal((await s.send()).type, 'PAUSE'); assert.equal(f.sends.length, 0);
  f.setCampaign({ execution_arn: ARN }); f.advance(7200001); f.setRemaining(900000);
  assert.equal((await s.send()).type, 'PAUSE'); assert.equal(f.sends.length, 0);
});

test('7.4.1 送信直前に引き下げられた日次上限も反映し、既存予約は戻さない', async () => {
  const f = fixture({ cap: 2 }); const s = await session(f); await s.send();
  const originalGet = f.ddb.getItem;
  let changed = false;
  f.ddb.getItem = async (input) => {
    const result = await originalGet(input);
    if (!changed && input.Key.PK.S === 'DAILY' && result.Item?.reserved_attempts.N === '2') { changed = true; f.settings.daily_send_cap = 1; }
    return result;
  };
  assert.equal((await s.send()).type, 'WAIT_DAY'); assert.equal(f.sends.length, 1);
  assert.equal(f.ddb.get('DAILY', jstDate(f.deps.now())).reserved_attempts, 2);
});

test('7.4.1 速度待機後の許可リスト除外を送信前に反映', async () => {
  const f = fixture(); const s = await session(f); await s.send();
  s.limiter.next = f.deps.now() + 100;
  f.onSleep = () => { f.settings.nonprod_allowlist = []; };
  assert.equal((await s.send()).code, 'RECIPIENT_NOT_ALLOWED_IN_ENV');
  assert.equal(f.sends.length, 1);
});
