import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createHandler } from '../../src/audit/handler.js';
import { marshall } from '../../src/common/ddb.js';
import { createMetrics } from '../../src/common/metrics.js';

const audit = { PK: 'AUDIT#202611', SK: '2026-11-03T01:02:03.004Z#ID', ts: '2026-11-03T01:02:03.004Z', action: 'CONTACT_STOP', addr_id: 'a'.repeat(64) };
const record = (eventName, extra = {}) => ({
  eventID: 'stream:event-1', eventName,
  dynamodb: { Keys: marshall({ PK: audit.PK, SK: audit.SK }), ...(eventName !== 'REMOVE' ? { NewImage: marshall(audit) } : {}), ...(eventName !== 'INSERT' ? { OldImage: marshall({ ...audit, action: 'CONTACT_CREATE' }) } : {}), ApproximateCreationDateTime: 1793667723 }, ...extra,
});
function fixture() {
  const puts = []; const lines = []; const logs = [];
  const deps = { env: 'stg', auditArchiveBucket: 'vault', now: () => 1000, s3: { putObject: async (input) => { puts.push(structuredClone(input)); } }, metrics: createMetrics({ env: 'stg', now: () => 1000, write: (line) => lines.push(JSON.parse(line)) }), logger: { error: (...args) => logs.push(args) } };
  return { puts, lines, logs, deps, invoke: createHandler(deps) };
}

test('T-52 INSERTを監査日時のUTCパスへ変換し、DynamoDB JSON・eventID・時刻・SHA256を保存する', async () => {
  const f = fixture();
  assert.deepEqual(await f.invoke({ Records: [record('INSERT')] }), { status: 'DONE' });
  const input = f.puts[0]; const body = JSON.parse(input.Body);
  assert.equal(input.Bucket, 'vault'); assert.equal(input.ContentType, 'application/json');
  assert.equal(input.Key, 'audit/2026/11/03/2026-11-03T01_02_03.004Z_ID.json');
  assert.deepEqual(body.after, audit); assert.equal(body.eventID, 'stream:event-1');
  assert.equal(body.ts, audit.ts); assert.ok(body.stream_ts.endsWith('Z'));
  assert.equal(body.sha256, createHash('sha256').update(JSON.stringify({ after: audit })).digest('hex'));
  assert.equal(f.lines.length, 0);
});

for (const eventName of ['INSERT', 'MODIFY', 'REMOVE']) test(`T-52 ${eventName}の同じeventIDは再処理でも同じキーと本文になる`, async () => {
  const f = fixture(); const event = { Records: [record(eventName)] };
  await f.invoke(event); await f.invoke(event);
  assert.deepEqual(f.puts[0], f.puts[1]);
});

for (const eventName of ['MODIFY', 'REMOVE']) test(`T-52 ${eventName}は変更前後をtamperへ保存してHT2/stgのAuditTamperを出す`, async () => {
  const f = fixture(); await f.invoke({ Records: [record(eventName)] });
  const body = JSON.parse(f.puts[0].Body);
  assert.equal(f.puts[0].Key, 'tamper/2026/11/03/stream_event-1.json');
  assert.equal(body.before.action, 'CONTACT_CREATE'); assert.deepEqual(body.after, eventName === 'REMOVE' ? null : audit);
  assert.equal(f.lines[0].AuditTamper, 1);
  assert.equal(f.lines[0]._aws.CloudWatchMetrics[0].Namespace, 'HT2/stg');
  assert.deepEqual(f.lines[0]._aws.CloudWatchMetrics[0].Dimensions, [[]]);
});

for (const identity of [{ type: 'Service', principalId: 'dynamodb.amazonaws.com' }, { type: 'Service', principalId: 'other' }, { type: 'IAMUser', principalId: 'dynamodb.amazonaws.com' }, undefined]) test(`T-52 TTL判定は両方の識別値の一致だけで行う ${JSON.stringify(identity)}`, async () => {
  const f = fixture(); await f.invoke({ Records: [record('REMOVE', { userIdentity: identity })] });
  const ttl = identity?.type === 'Service' && identity.principalId === 'dynamodb.amazonaws.com';
  assert.equal(f.puts.length, ttl ? 0 : 1); assert.equal(f.lines.length, ttl ? 0 : 1);
});

test('4.6 非監査イベントを無視し、S3障害はバッチ全体を失敗させて再試行に委ねる', async () => {
  const f = fixture();
  const other = record('INSERT'); other.dynamodb.Keys = marshall({ PK: 'CAMPAIGN', SK: 'id' });
  await f.invoke({ Records: [other] }); assert.equal(f.puts.length, 0);
  f.deps.s3.putObject = async () => { throw new Error('private@example.com'); };
  await assert.rejects(f.invoke({ Records: [record('INSERT'), record('MODIFY')] }), { code: 'INTERNAL' });
  assert.equal(f.lines.length, 0);
});

test('4.6 変更前イメージや監査日時の欠落は成功扱いせず止める', async () => {
  const f = fixture(); const event = record('MODIFY'); delete event.dynamodb.OldImage;
  await assert.rejects(f.invoke({ Records: [event] }), { code: 'INTERNAL' });
  const invalid = record('INSERT'); invalid.dynamodb.NewImage.ts = { S: 'invalid' };
  await assert.rejects(f.invoke({ Records: [invalid] }), { code: 'INTERNAL' });
  assert.equal(f.puts.length, 0);
});
