import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from '../helpers/sending.js';
import { createSender, buildSendInput } from '../../src/common/sender.js';

function delayedContactCheck({ lockMs, delay }) {
  const f = fixture({ count: 1 });
  const started = f.deps.now();
  const expires = started + lockMs;
  let reads = 0;
  let checks = 0;
  const get = f.ddb.getItem;
  f.ddb.getItem = async (input) => {
    const response = await get(input);
    if (input.Key.PK.S === 'ERASED' && ++reads === 2) f.advance(delay);
    return response;
  };
  const healthy = () => ({ ok: true, config: structuredClone(f.settings), checkedAt: f.deps.now(), quotaRemaining: 100, rate: 10 });
  const sender = createSender({
    ...f.deps, store: f.store, health: healthy(),
    lock: { get: async () => ({ owner: 'test:guard', expires_at_ms: expires }) },
    precheck: { consume() {}, run: async () => { checks += 1; return healthy(); } },
  });
  return {
    f, expires, checks: () => checks,
    send: () => sender.trySend(buildSendInput(f.getCampaign(), f.addresses[0], { ...f.deps, test: true }), { interval: 100, next: started }, { owner: 'test:guard', test: true, remainingTime: () => 900000, rate: 10 }),
  };
}

test('7.3 連絡先の最終確認が遅延してロック余裕10秒を失った場合は送信しない', async () => {
  const { f, send } = delayedContactCheck({ lockMs: 11000, delay: 2000 });
  const result = await send();
  assert.equal(result.type, 'PAUSE');
  assert.equal(result.code, 'LOCK_LOST');
  assert.equal(f.sends.length, 0);
});

test('7.3 連絡先の最終確認中に健康検査が期限切れになれば再検査後に送信する', async () => {
  const { f, send, checks, expires } = delayedContactCheck({ lockMs: 120000, delay: 61000 });
  const result = await send();
  assert.equal(result.type, 'ACCEPTED');
  assert.equal(checks(), 1);
  assert.equal(f.sends.length, 1);
  assert.ok(expires - f.sends[0].time > 10000);
});
