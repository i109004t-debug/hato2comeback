import test from 'node:test';
import assert from 'node:assert/strict';
import { createUlid, isUlid } from '../../src/common/ids.js';
import { shuffleRecipients } from '../../src/common/shuffle.js';
import { createTime, jstDate, nextJstDayAt0005, unixSeconds } from '../../src/common/time.js';

test('ULIDは26文字で同時刻・時計の巻戻りでも単調増加', () => {
  let time = 1760000000000;
  const ulid = createUlid({ now: () => time, random: (length) => Buffer.alloc(length) });
  const values = [ulid(), ulid()];
  time -= 1000;
  values.push(ulid());
  time += 2000;
  values.push(ulid());
  assert.ok(values.every((value) => value.length === 26 && isUlid(value)));
  assert.deepEqual([...values].sort(), values);
  assert.equal(new Set(values).size, values.length);
  assert.equal(isUlid('Z'.repeat(26)), false);
});

test('ULIDの乱数・時刻の範囲と桁あふれ', () => {
  const ulid = createUlid({ now: () => 1, random: (length) => Buffer.alloc(length, 0xff) });
  assert.ok(isUlid(ulid()));
  assert.throws(() => ulid(), RangeError);
  for (const value of [-1, 2 ** 48, 1.5]) assert.throws(() => createUlid({ now: () => value })(), RangeError);
  assert.throws(() => createUlid({ random: () => Buffer.alloc(1) })(), RangeError);
});

test('7.3.7 並べ替えは配信IDごとに再現可能、全件を保持し元配列を変えない', () => {
  const source = Array.from({ length: 1000 }, (_, index) => index);
  const first = shuffleRecipients(source, 'campaign-a', 'test-key');
  assert.deepEqual(shuffleRecipients(source, 'campaign-a', 'test-key'), first);
  assert.notDeepEqual(shuffleRecipients(source, 'campaign-b', 'test-key'), first);
  assert.notDeepEqual(shuffleRecipients(source, 'campaign-a', 'other-key'), first);
  assert.deepEqual([...first].sort((a, b) => a - b), source);
  assert.deepEqual(source, Array.from({ length: 1000 }, (_, index) => index));
  assert.deepEqual(shuffleRecipients([], 'a', 'key'), []);
  assert.deepEqual(shuffleRecipients([1], 'a', 'key'), [1]);
  assert.throws(() => shuffleRecipients([1], 'a', ''));
});

test('日本時間の暦日・翌日0時5分と注入できる時計・待機', async () => {
  assert.equal(jstDate('2026-11-03T14:59:59Z'), '2026-11-03');
  assert.equal(jstDate('2026-11-03T15:00:00Z'), '2026-11-04');
  assert.equal(jstDate('2026-12-31T15:00:00Z'), '2027-01-01');
  assert.equal(nextJstDayAt0005('2026-11-03T14:59:59Z'), '2026-11-03T15:05:00.000Z');
  assert.equal(nextJstDayAt0005('2026-11-03T15:00:00Z'), '2026-11-04T15:05:00.000Z');
  let time = 1000;
  const clock = createTime({ now: () => time, sleep: async (ms) => { time += ms; } });
  await clock.sleep(23);
  assert.equal(clock.now(), 1023);
  assert.equal(unixSeconds(1999), 1);
});
