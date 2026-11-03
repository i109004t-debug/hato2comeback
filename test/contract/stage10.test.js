import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, ID, ID2, ARN, failure } from '../helpers/sending.js';
import { managementFixture } from '../helpers/management.js';
import { acceptedBucket } from '../../src/common/monitoring.js';
import { marshall, unmarshall } from '../../src/common/ddb.js';
import { createHandler as createArchive } from '../../src/audit/handler.js';
import { auditArchiveKey, readAuditArchive } from '../../src/common/audit-archive.js';
import { unknownReviewFields } from '../../src/common/campaign-lifecycle.js';

test('T-58 API-17/18は範囲必須、時刻境界と構成上限を検査する', async () => {
  const f = managementFixture(); f.draft();
  for (const body of [{}, { ...f.scope(), max_recipients: 0 }, { ...f.scope(), send_by: new Date(f.deps.now() + 3599999).toISOString() }, { ...f.scope(), send_by: new Date(f.deps.now() + 90 * 86400000 + 1).toISOString() }, { ...f.scope(), send_after: f.scope().send_by }, { ...f.scope(), send_by: '2026-02-30T00:00:00Z' }]) assert.equal((await f.request(`POST ${f.campaignPath}/submit`, body)).statusCode, 400);
  f.settings.max_recipients_per_campaign = 10;
  assert.equal((await f.request(`POST ${f.campaignPath}/submit`, f.scope())).statusCode, 400);
  assert.equal(f.templates.size, 0);
  f.settings.max_recipients_per_campaign = 100000;
  const value = await f.request(`POST ${f.campaignPath}/submit`, { max_recipients: 100, send_by: new Date(f.deps.now() + 3600000).toISOString() });
  assert.equal(value.statusCode, 200);
  assert.ok(Date.parse(value.json.proposed_scope.send_after) <= Date.parse(value.json.submitted_at));
  assert.equal(value.json.audience_estimate, 45);
  assert.ok(value.json.audience_estimate_at);
  assert.equal(value.json.forecast.completes, true);
  assert.equal((await f.request(`POST ${f.campaignPath}/approve`, { content_sha256: value.json.content_sha256 })).statusCode, 400);
});

test('T-58 申請・承認の監査に概算と範囲を残し、同じ内容で承認し直せる', async () => {
  const f = managementFixture(); f.draft();
  const submitted = await f.request(`POST ${f.campaignPath}/submit`, f.scope());
  f.sub = 'approver'; f.resetApi();
  let response = await f.request(`POST ${f.campaignPath}/approve`, { ...f.scope(), max_recipients: 80, content_sha256: submitted.json.content_sha256 });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json.approval_scope.max_recipients, 80);
  response = await f.request(`POST ${f.campaignPath}/approve`, { ...f.scope(), max_recipients: 90, content_sha256: submitted.json.content_sha256 });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json.approval_scope.max_recipients, 90);
  assert.equal(f.templates.size, 1);
  const audits = [...f.ddb.items.values()].filter((item) => ['CAMPAIGNS_SUBMIT', 'CAMPAIGNS_APPROVE'].includes(item.action));
  assert.equal(audits.length, 3);
  assert.ok(audits.every((item) => item.details.audience_estimate === 45));
  assert.equal(audits.at(-1).details.approval_scope.max_recipients, 90);
});

for (const auto of [false, true]) test(`T-58 準備時の件数超過は1通も送らず範囲を消して承認待ち ${auto}`, async () => {
  const f = managementFixture({ count: 3 });
  f.org.approval_required = !auto; f.ddb.set(f.org); f.draft();
  const submitted = (await f.request(`POST ${f.campaignPath}/submit`, { ...f.scope(), max_recipients: 2 })).json;
  if (!auto) { f.sub = 'another'; f.resetApi(); await f.request(`POST ${f.campaignPath}/approve`, { ...f.scope(), max_recipients: 2, content_sha256: submitted.content_sha256 }); }
  f.setCampaign({ status: 'QUEUED', execution_arn: ARN });
  assert.equal((await f.worker(f.event('prepare'), f.context)).action, 'START_FAILED');
  let current = f.getCampaign();
  assert.equal(current.status, 'PENDING_APPROVAL');
  assert.equal(current.start_error, 'AUDIENCE_EXCEEDS_APPROVAL');
  for (const field of ['approved_by', 'approved_at', 'approval_scope']) assert.equal(current[field], undefined);
  assert.equal(current.template_name, submitted.template_name);
  assert.equal((await f.worker(f.event('finish', { outcome: 'START_FAILED' }), f.context)).action, 'START_FAILED');
  assert.equal(f.sends.length, 0);
  if (!auto) { f.sub = 'user'; f.resetApi(); assert.equal((await f.request(`POST ${f.campaignPath}/approve`, { ...f.scope(), content_sha256: submitted.content_sha256 })).statusCode, 403); f.sub = 'another'; f.resetApi(); }
  const approved = await f.request(`POST ${f.campaignPath}/approve`, { ...f.scope(), content_sha256: submitted.content_sha256 });
  assert.equal(approved.statusCode, 200);
  assert.equal(approved.json.rev, submitted.rev);
});

test('T-58 即時・予約は承認期間内、期限と等しい時刻は期間外', async () => {
  const f = managementFixture();
  f.setCampaign({ status: 'APPROVED', approval_scope: { max_recipients: 100, send_after: new Date(f.deps.now() + 600000).toISOString(), send_by: new Date(f.deps.now() + 3600000).toISOString() } });
  for (const body of [{ mode: 'NOW' }, { mode: 'SCHEDULED', at: new Date(f.deps.now() + 300000).toISOString() }, { mode: 'SCHEDULED', at: new Date(f.deps.now() + 3600000).toISOString() }]) {
    const response = await f.request(`POST ${f.campaignPath}/start`, body);
    assert.equal(response.statusCode, 422); assert.equal(response.json.error_code, 'OUTSIDE_APPROVED_WINDOW');
  }
  assert.equal((await f.request(`POST ${f.campaignPath}/start`, { mode: 'SCHEDULED', at: new Date(f.deps.now() + 600000).toISOString() })).statusCode, 200);
});

test('T-57 準備後の実数で日次1000件・1万件を拒否し、APPROVEDへ戻す', async () => {
  const f = fixture({ count: 10000, env: 'prod' });
  assert.equal((await f.prepare()).action, 'START_FAILED');
  assert.equal(f.getCampaign().status, 'APPROVED');
  assert.equal(f.getCampaign().start_error, 'CAPACITY_INSUFFICIENT');
  assert.equal(f.getCampaign().forecast.completes, false);
  assert.equal(f.getCampaign().forecast.shortfall > 0, true);
  assert.equal(f.sends.length, 0);
  assert.equal(f.ddb.get('LOCK', 'SEND').owner, undefined);
});

test('7.10 API-14の概算は先行配信を引き、入力中の期限でも読取計算できる', async () => {
  const f = managementFixture({ count: 100 }); f.draft();
  f.ddb.set({ ...f.getCampaign(), SK: ID2, campaign_id: ID2, status: 'SENDING', recipients_total: 900, counts: { accepted: 50, failed: 10, unknown: 10, skipped_blocked: 30 } });
  const by = new Date(f.deps.now() + 3600000).toISOString();
  const response = await f.request(`GET ${f.campaignPath}`, undefined, { queryStringParameters: { send_by: by } });
  assert.equal(response.json.forecast.assumptions.ahead, 800);
  assert.equal(response.json.forecast.assumptions.recipients, 100);
  assert.equal(response.json.forecast.assumptions.deadline_at, by);
  assert.equal(response.json.status, 'DRAFT');
});

test('7.4 20件ごとのflushは送信要求開始時刻の区間に1回だけ加算する', async () => {
  const f = fixture({ count: 25 });
  await f.prepare();
  f.setTime(Date.parse('2026-11-03T10:04:50Z'));
  assert.deepEqual(f.getCampaign().accepted_buckets, {});
  let conflict = false;
  f.ddb.beforeUpdate = (input) => {
    if (!conflict && Object.values(input.ExpressionAttributeNames ?? {}).includes('progress')) { conflict = true; f.setCampaign({ version: f.getCampaign().version + 1 }); }
  };
  f.onSend = (_, n) => { f.advance(1000); return { MessageId: `m${n}` }; };
  await f.send();
  const buckets = f.getCampaign().accepted_buckets;
  const expected = {};
  for (const send of f.sends) { const bucket = acceptedBucket(send.time); expected[bucket] = (expected[bucket] ?? 0) + 1; }
  assert.deepEqual(buckets, expected);
  assert.equal(Object.keys(buckets).length, 2);
  assert.equal(Object.values(buckets).reduce((sum, n) => sum + n, 0), 25);
});

test('T-56 送信中と終了後の日次で同じ区間判定を使い、API-14/23に保存値を出す', async () => {
  const f = managementFixture({ count: 1 }); await f.worker(f.event('prepare'), f.context);
  const start = f.deps.now() - 3600000;
  f.setCampaign({ started_at: new Date(start).toISOString(), accepted_buckets: { [acceptedBucket(start)]: 100 }, counts: { accepted: 100 }, progress: { chunk: 0, index: 0 } });
  assert.equal((await f.worker(f.event('send'), f.context)).action, 'PAUSED');
  assert.equal(f.getCampaign().pause_reason, 'EVENTS_MISSING');
  for (const path of [f.campaignPath, `${f.campaignPath}/stats`]) {
    const response = await f.request(`GET ${path}`);
    assert.equal(response.json.events_status, 'MISSING');
    assert.equal(response.json.events_missing, 100);
    assert.ok(response.json.events_checked_at);
  }
  f.setCampaign({ status: 'CANCELLED', completed_at: new Date(f.deps.now()).toISOString() });
  await f.worker({ mode: 'daily' });
  assert.ok(f.notices.some((n) => n.code === 'EVENTS_MISSING'));
});

test('T-59 各送信の直前に期限を確かめ、以降を送らず未送信件数と通知を残す', async () => {
  const f = fixture({ count: 5 }); await f.prepare();
  f.setCampaign({ deadline_at: new Date(f.deps.now() + 10000).toISOString() });
  f.onSend = () => { f.advance(11000); return { MessageId: 'one' }; };
  assert.equal((await f.send()).action, 'CANCELLED');
  const campaign = f.getCampaign();
  assert.equal(campaign.cancel_reason, 'DEADLINE_PASSED');
  assert.equal(campaign.unsent_count, 4);
  assert.equal(campaign.counts.accepted, 1);
  assert.equal(f.sends.length, 1);
  assert.equal(f.notices.filter((n) => n.code === 'DEADLINE_PASSED').length, 1);
});

for (const phase of ['prepare', 'paused', 'day', 'resume']) test(`T-59 ${phase}の継続でも期限経過後は送らない`, async () => {
  const f = managementFixture({ count: 3 });
  if (phase !== 'prepare') await f.worker(f.event('prepare'), f.context);
  f.setCampaign({ ...(phase === 'paused' || phase === 'resume' ? { status: 'PAUSED', pause_reason: 'USER' } : {}), approval_scope: { ...f.getCampaign().approval_scope, send_by: new Date(f.deps.now()).toISOString() } });
  const response = phase === 'resume' ? await f.request(`POST ${f.campaignPath}/resume`, {}) : await f.worker(f.event(phase === 'prepare' ? 'prepare' : 'send'), f.context);
  assert.equal(phase === 'resume' ? response.json.status : response.action, 'CANCELLED');
  assert.equal(f.getCampaign().cancel_reason, 'DEADLINE_PASSED');
  assert.equal(f.sends.length, 0);
});

test('T-59 ロック待ちの予約遅延は日次と準備で重複せず、期限切れなら0通で中止', async () => {
  const f = managementFixture({ count: 1 });
  f.setCampaign({ status: 'SCHEDULED', scheduled_at: new Date(f.deps.now() - 900000).toISOString() });
  f.ddb.set({ PK: 'LOCK', SK: 'SEND', owner: 'other', expires_at_ms: f.deps.now() + 100000 });
  assert.equal((await f.worker(f.event('prepare'), f.context)).action, 'WAIT_LOCK');
  await f.worker({ mode: 'daily' });
  await f.worker(f.event('prepare'), f.context);
  assert.equal(f.notices.filter((n) => n.code === 'SCHEDULE_DELAYED').length, 1);
  assert.ok(f.getCampaign().schedule_delayed_notified_at);
  f.setCampaign({ approval_scope: { ...f.getCampaign().approval_scope, send_by: new Date(f.deps.now()).toISOString() } });
  await f.worker({ mode: 'daily' });
  assert.equal(f.getCampaign().cancel_reason, 'DEADLINE_PASSED');
  assert.equal(f.sends.length, 0);
});

async function unknownFixture() {
  const f = managementFixture({ count: 2 });
  await f.worker(f.event('prepare'), f.context);
  f.onSend = (_, n) => { if (n === 1) throw failure('TimeoutError'); return { MessageId: 'ok' }; };
  await f.worker(f.event('send'), f.context);
  await f.worker(f.event('finish', { outcome: 'DONE' }), f.context);
  return f;
}

test('T-60 finishでOPENを作り、管理者だけがsnapshotから元のアドレスを確認できる', async () => {
  const f = await unknownFixture();
  assert.equal(f.getCampaign().unknown_review.status, 'OPEN');
  assert.equal(f.getCampaign().unknown_review.count, 1);
  const admin = (await f.request(`GET ${f.campaignPath}/failures`)).json.items[0];
  assert.ok(admin.email.endsWith('@example.com'));
  assert.equal(f.files.has(`recipients/${ID}/00000.jsonl`), true);
  for (const role of ['sender', 'approver', 'viewer']) {
    f.role = role; f.resetApi();
    assert.equal((await f.request(`GET ${f.campaignPath}/failures`)).json.items[0].email, undefined);
    assert.equal((await f.request(`POST ${f.campaignPath}/unknowns`, { decision: 'NO_RESEND', note: '再送しない' })).statusCode, 403);
  }
  f.role = 'admin'; f.resetApi(); f.advance(30 * 86400000);
  assert.equal((await f.request(`GET ${f.campaignPath}/failures`)).json.items[0].email, undefined);
});

test('T-60 HOLDは継続、NO_RESENDはRESOLVEDと宛先削除、索引の差込口と監査', async () => {
  const f = await unknownFixture();
  f.deps.unknownIndex = { countAccepted: async () => 1 }; f.resetApi();
  const body = { decision: 'HOLD', note: '記録を照会中' };
  let response = await f.request(`POST ${f.campaignPath}/unknowns`, body);
  assert.equal(response.json.unknown_review.status, 'OPEN');
  assert.equal(f.files.has(`recipients/${ID}/00000.jsonl`), true);
  response = await f.request(`POST ${f.campaignPath}/unknowns`, { decision: 'NO_RESEND', note: '二重送信を避け、送り直さない' });
  assert.equal(response.json.unknown_review.status, 'RESOLVED');
  assert.equal(response.json.unknown_review.decisions.length, 2);
  assert.equal(response.json.unknown_review.decisions[1].ses_accepted_count, 1);
  assert.equal(f.files.has(`recipients/${ID}/00000.jsonl`), false);
  assert.equal((await f.request(`GET ${f.campaignPath}/failures`)).json.items[0].email, undefined);
  assert.equal([...f.ddb.items.values()].filter((item) => item.action === 'UNKNOWN_DECISION').length, 2);
  assert.equal(f.sends.length, 2);
});

test('API-30 判断・note・OPEN・索引の件数を検査し、異常なら解決しない', async () => {
  const f = await unknownFixture();
  for (const body of [{ decision: 'RESEND', note: '判断' }, { decision: 'HOLD', note: '' }, { decision: 'HOLD', note: ' ' }, { decision: 'HOLD', note: 'a'.repeat(501) }]) assert.equal((await f.request(`POST ${f.campaignPath}/unknowns`, body)).statusCode, 400);
  f.deps.unknownIndex = { countAccepted: async () => 2 }; f.resetApi();
  assert.equal((await f.request(`POST ${f.campaignPath}/unknowns`, { decision: 'NO_RESEND', note: '調査' })).statusCode, 503);
  assert.equal(f.getCampaign().unknown_review.status, 'OPEN');
});

test('8.6 snapshotの期限・欠落・誤った位置やHMACではアドレスを返さない', async () => {
  const f = await unknownFixture();
  const key = f.getCampaign().result_keys[0];
  const row = JSON.parse(f.files.get(key).trim());
  f.files.delete(`recipients/${ID}/00000.jsonl`);
  assert.equal((await f.request(`GET ${f.campaignPath}/failures`)).json.items[0].email, undefined);
  f.files.set(`recipients/${ID}/00000.jsonl`, JSON.stringify({ e: 'different@example.com' }) + '\n');
  assert.equal((await f.request(`GET ${f.campaignPath}/failures`)).statusCode, 500);
  f.files.set(key, JSON.stringify({ ...row, ci: 999 }) + '\n');
  assert.equal((await f.request(`GET ${f.campaignPath}/failures`)).statusCode, 500);
});

for (const path of ['cancel', 'review', 'daily']) test(`8.6 ${path}で終了する経路にもOPENを作る`, async () => {
  const f = managementFixture();
  f.setCampaign({ status: path === 'review' ? 'NEEDS_REVIEW' : 'PAUSED', counts: { unknown: 2 }, paused_at: new Date(f.deps.now() - 8 * 86400000).toISOString() });
  if (path === 'daily') await f.worker({ mode: 'daily' });
  else await f.request(`POST ${f.campaignPath}/${path}`, path === 'review' ? { decision: 'CANCEL', note: '中止' } : {});
  assert.equal(f.getCampaign().status, 'CANCELLED');
  assert.equal(f.getCampaign().unknown_review.status, 'OPEN');
});

test('8.6 中止と送信結果の保存が競合しても、最後のUNKNOWNを調査に含める', async () => {
  const f = managementFixture({ count: 2 }); await f.worker(f.event('prepare'), f.context);
  f.onSend = async () => { await f.request(`POST ${f.campaignPath}/cancel`, {}); throw failure('TimeoutError'); };
  await f.worker(f.event('send'), f.context);
  assert.equal(f.getCampaign().unknown_review.count, 1);
  assert.equal(f.getCampaign().unknown_review.status, 'OPEN');
  assert.equal(f.sends.length, 1);
});

test('8.6 3日超のOPENだけ通知し、同じ配信は7日経過まで通知しない', async () => {
  const f = await unknownFixture();
  f.setTime(Date.parse(f.getCampaign().unknown_review.opened_at) + 3 * 86400000 - 60000);
  await f.worker({ mode: 'daily' });
  assert.equal(f.notices.filter((n) => n.code === 'UNKNOWN_REVIEW_OPEN').length, 0);
  f.advance(60001); await f.worker({ mode: 'daily' }); await f.worker({ mode: 'daily' });
  assert.equal(f.notices.filter((n) => n.code === 'UNKNOWN_REVIEW_OPEN').length, 1);
  f.advance(7 * 86400000); await f.worker({ mode: 'daily' });
  assert.equal(f.notices.filter((n) => n.code === 'UNKNOWN_REVIEW_OPEN').length, 2);
});

test('8.6 終了判断後に未保存だったUNKNOWNが増えたら判断履歴を保って調査を再開する', () => {
  const previous = { status: 'RESOLVED', count: 1, opened_at: '2026-11-01T00:00:00Z', decisions: [{ decision: 'NO_RESEND' }], notified_at: '2026-11-02T00:00:00Z' };
  const reopened = unknownReviewFields({ counts: { unknown: 2 }, unknown_review: previous }, 1793667723000).unknown_review;
  assert.equal(reopened.status, 'OPEN');
  assert.equal(reopened.count, 2);
  assert.equal(reopened.notified_at, undefined);
  assert.deepEqual(reopened.decisions, previous.decisions);
  assert.equal(unknownReviewFields({ counts: { unknown: 1 }, unknown_review: previous }, 1793667723000).unknown_review.status, 'RESOLVED');
});

test('8.6 NO_RESEND後の宛先削除に失敗しても日次処理で削除を完了する', async () => {
  const f = await unknownFixture();
  const remove = f.deps.s3.deleteObject;
  f.deps.s3.deleteObject = async () => { throw failure('TimeoutError'); };
  assert.equal((await f.request(`POST ${f.campaignPath}/unknowns`, { decision: 'NO_RESEND', note: '再送しない' })).statusCode, 500);
  assert.equal(f.getCampaign().unknown_review.status, 'RESOLVED');
  f.deps.s3.deleteObject = remove;
  await f.worker({ mode: 'daily' });
  assert.equal(f.files.has(`recipients/${ID}/00000.jsonl`), false);
  assert.ok(f.getCampaign().snapshot_deleted_at);
});

test('7.10 APIの再開要求で期限を過ぎた待機タスクも終了させる', async () => {
  const f = managementFixture({ count: 1 }); await f.worker(f.event('prepare'), f.context);
  f.setCampaign({ status: 'PAUSED', pause_reason: 'USER', task_token: 'private-token', approval_scope: { ...f.getCampaign().approval_scope, send_by: new Date(f.deps.now()).toISOString() } });
  assert.equal((await f.request(`POST ${f.campaignPath}/resume`, {})).json.status, 'CANCELLED');
  assert.equal(f.getCampaign().task_token, undefined);
  assert.ok(f.tokens.some((t) => t.failure?.error === 'DeadlinePassed'));
  assert.equal(f.sends.length, 0);
});

test('7.8 日次は先頭の配信が欠測でも後続配信の判定を保存する', async () => {
  const f = managementFixture();
  const start = f.deps.now() - 3600000;
  const fields = { status: 'COMPLETED', started_at: new Date(start).toISOString(), completed_at: new Date(f.deps.now()).toISOString(), accepted_buckets: { [acceptedBucket(start)]: 100 } };
  f.setCampaign(fields);
  f.ddb.set({ ...f.getCampaign(), SK: ID2, campaign_id: ID2 });
  await f.worker({ mode: 'daily' });
  assert.equal(f.getCampaign().events_status, 'MISSING');
  assert.equal(f.getCampaign(ID2).events_status, 'MISSING');
});

test('6.2 準備中の手動停止はprepare段階を記録し、再開はQUEUEDへ戻す', async () => {
  const f = managementFixture();
  const paused = await f.request(`POST ${f.campaignPath}/pause`, {});
  assert.equal(paused.json.status, 'PAUSED');
  assert.equal(paused.json.pause_phase, 'prepare');
  assert.equal((await f.request(`POST ${f.campaignPath}/resume`, {})).json.status, 'QUEUED');
});

test('8.6 判断のメモに入ったアドレス・URL・トークンを保存や監査の前に伏せる', async () => {
  const f = await unknownFixture();
  const response = await f.request(`POST ${f.campaignPath}/unknowns`, { decision: 'HOLD', note: 'private@example.com https://example.com/unsubscribe?token=secret token=secret' });
  assert.equal(response.statusCode, 200);
  assert.doesNotMatch(JSON.stringify(f.getCampaign().unknown_review), /private@example\.com|https:\/\/|token=secret/);
});

test('第9段階指摘 同じSKとtsでも異なるPKの偽項目は保管庫の別キーになる', async () => {
  const files = new Map();
  const runtime = { auditArchiveBucket: 'vault', s3: { putObject: async (input) => files.set(input.Key, input.Body), getObject: async (input) => ({ Body: files.get(input.Key) }) } };
  const archive = createArchive(runtime);
  const real = { PK: 'AUDIT#202611', SK: 'same:SK#id', ts: '2026-11-03T10:00:00Z', action: 'CONTACT_STOP' };
  const fake = { ...real, PK: 'AUDIT#202612', action: 'FAKE' };
  for (const item of [real, fake]) await archive({ Records: [{ eventID: item.PK, eventName: 'INSERT', dynamodb: { Keys: marshall({ PK: item.PK, SK: item.SK }), NewImage: marshall(item) } }] });
  assert.equal(files.size, 2);
  assert.notEqual(auditArchiveKey(real), auditArchiveKey(fake));
  assert.deepEqual(await readAuditArchive(runtime, real), real);
  files.set(auditArchiveKey(real), files.get(auditArchiveKey(fake)));
  await assert.rejects(readAuditArchive(runtime, real), /Invalid audit archive/);
  assert.notEqual(auditArchiveKey({ ...real, SK: 'a:b' }), auditArchiveKey({ ...real, SK: 'a_b' }));
});

test('7.8 監視記録の条件更新もversionを条件にし、状態は変更しない', async () => {
  const f = managementFixture(); await f.worker(f.event('prepare'), f.context);
  f.ddb.calls.length = 0;
  await f.worker(f.event('send'), f.context);
  const update = f.ddb.calls.find((input) => Object.values(input.ExpressionAttributeNames ?? {}).includes('events_checked_at'));
  assert.ok(update);
  assert.ok(Object.values(update.ExpressionAttributeNames).includes('version'));
  assert.ok(Object.values(unmarshall(update.ExpressionAttributeValues)).includes('SENDING'));
});
