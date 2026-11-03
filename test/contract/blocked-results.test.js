import test from 'node:test';
import assert from 'node:assert/strict';
import { managementFixture } from '../helpers/management.js';
import { addressHash } from '../../src/common/log.js';
import { failure } from '../helpers/sending.js';

const hash = (email) => addressHash(email, '7'.repeat(64));
const block = (f, email) => f.ddb.set({ PK: 'CONTACT_META', SK: hash(email), version: 1, blocked_all: true });

for (const operation of ['topic', 'all', 'erase']) {
  test(`7.4・8.2 snapshot後の${operation}停止はSKIPPEDとして保存・表示し、失敗に含めない`, async () => {
    const f = managementFixture({ count: 1 }); await f.prepare();
    const response = await f.request(`POST /contacts/${operation === 'erase' ? 'erase' : 'unsubscribe'}`, { email: f.addresses[0], ...(operation === 'erase' ? { note: '本人から削除依頼' } : { scope: operation === 'all' ? 'ALL' : 'news' }) });
    assert.equal(response.statusCode, 200, response.body);
    await f.send();
    const campaign = f.getCampaign();
    assert.equal(campaign.counts.skipped_blocked, 1);
    assert.equal(campaign.counts.failed, 0);
    assert.equal(campaign.counts.accepted, 0);
    assert.equal(campaign.counts.unknown, 0);
    assert.equal(f.sends.length, 0);
    assert.equal(f.ddb.get('DAILY', '2026-11-03'), undefined);
    assert.ok(!f.metrics.some((item) => item.name === 'Failed'));
    const rows = await f.request(`GET ${f.campaignPath}/failures`);
    assert.equal(rows.json.items.length, 1);
    assert.equal(rows.json.items[0].r, 'SKIPPED');
    assert.equal(rows.json.items[0].c, 'CONTACT_BLOCKED');
    assert.equal((await f.request(`GET ${f.campaignPath}/stats`)).json.counts.skipped_blocked, 1);
    f.role = 'viewer'; f.resetApi();
    const masked = (await f.request(`GET ${f.campaignPath}/failures`)).json.items[0];
    assert.equal(masked.r, 'SKIPPED');
    assert.ok(masked.e.includes('*'));
  });
}

test('7.4.1 日次枠予約後に停止が確定しても送信せず、枠を戻さずSKIPPEDへ計上する', async () => {
  const f = managementFixture({ count: 1 }); await f.prepare();
  f.ddb.afterUpdate = async (input) => { if (input.Key.PK.S === 'DAILY') block(f, f.addresses[0]); };
  await f.send();
  assert.equal(f.ddb.get('DAILY', '2026-11-03').reserved_attempts, 1);
  assert.equal(f.sends.length, 0);
  assert.equal(f.getCampaign().counts.failed, 0);
  assert.equal(f.getCampaign().counts.skipped_blocked, 1);
  assert.equal((await f.request(`GET ${f.campaignPath}/failures`)).json.items[0].r, 'SKIPPED');
});

test('7.4 20件を超える停止のcheckpointでも件数を重複加算せず、旧countsにも項目を追加する', async () => {
  const f = managementFixture({ count: 25 }); await f.prepare();
  const counts = f.getCampaign().counts;
  delete counts.skipped_blocked;
  f.setCampaign({ counts });
  for (const email of f.addresses) block(f, email);
  await f.send();
  assert.equal(f.getCampaign().counts.skipped_blocked, 25);
  assert.equal(f.getCampaign().counts.failed, 0);
  assert.equal(f.getCampaign().progress.chunk, 1);
  assert.equal((await f.send()).action, 'DONE');
  assert.equal(f.getCampaign().counts.skipped_blocked, 25);
  assert.equal(f.sends.length, 0);
});

test('8.1 停止と実際のSES送信失敗を別々に集計する', async () => {
  const f = managementFixture({ count: 2 }); await f.prepare();
  block(f, f.addresses[0]);
  f.onSend = () => { throw failure('BadRequestException', 400, 'Invalid email address'); };
  await f.send();
  assert.equal(f.getCampaign().counts.skipped_blocked, 1);
  assert.equal(f.getCampaign().counts.failed, 1);
  const rows = (await f.request(`GET ${f.campaignPath}/failures`)).json.items;
  assert.deepEqual(rows.map((item) => item.r).sort(), ['FAILED', 'SKIPPED']);
  assert.equal(f.metrics.filter((item) => item.name === 'Failed').reduce((sum, item) => sum + item.value, 0), 1);
});

test('6.6 テスト送信も予約後の停止はSKIPPEDとし、残りの登録済み宛先へ進む', async () => {
  const f = managementFixture({ count: 2 }); f.draft();
  let blocked = false;
  f.ddb.afterUpdate = async (input) => {
    if (input.Key.PK.S !== 'DAILY' || blocked) return;
    blocked = true;
    block(f, f.addresses[0]);
  };
  const response = await f.request(`POST ${f.campaignPath}/test-send`, {});
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(response.json.results.map((item) => item.status), ['SKIPPED', 'ACCEPTED']);
  assert.equal(response.json.results[0].code, 'CONTACT_BLOCKED');
  assert.equal(f.sends.length, 1);
  assert.equal(f.ddb.get('DAILY', '2026-11-03').reserved_attempts, 2);
});
