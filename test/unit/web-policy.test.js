import test from 'node:test';
import assert from 'node:assert/strict';
import { primaryAction, controlPolicy, canSchedule, testSendInput, scopeDefaults, scopeInput, forecastText } from '../../web/js/views/send.js';
import { apiPath, ERROR_MESSAGES } from '../../web/js/api.js';
import { validateRoute, validateQuery } from '../../src/common/validate.js';
import { readFileSync } from 'node:fs';

const id = '01JAZ6Y0N00000000000000001';
const hash = 'a'.repeat(64);
const user = (role, sub = 'approver-person') => ({ sub, roles: Array.isArray(role) ? role : [role] });
const campaign = (status, extra = {}) => ({ campaign_id: id, status, submitted_by: 'sender-person', content_sha256: hash, ...extra });
const checked = { previewHash: hash, confirmed: true };

test('6.9 画面の初期値は概算×1.2の100件単位切上げ、7日後を期限にする', () => {
  const now = Date.parse('2026-11-03T00:00:00Z');
  assert.deepEqual(scopeDefaults(101, now), { max_recipients: 200, send_by: '2026-11-10T00:00:00.000Z' });
  assert.equal(scopeDefaults(100000, now).max_recipients, 100000);
  assert.equal(scopeDefaults(0, now).max_recipients, 100);
});

test('6.9 日本時間の範囲をAPI-17/18とAPI-14見込み更新へ渡せる', () => {
  const now = Date.parse('2026-11-03T00:00:00Z');
  const scope = scopeInput('200', '2026-11-10T09:00', '2026-11-03T10:00', now);
  assert.equal(scope.send_by, '2026-11-10T00:00:00.000Z');
  assert.equal(scope.send_after, '2026-11-03T01:00:00.000Z');
  assert.deepEqual(validateRoute('campaigns.submit', scope), scope);
  assert.equal(validateRoute('campaigns.approve', { ...scope, content_sha256: hash }).max_recipients, 200);
  const path = apiPath(`/campaigns/${id}`, { send_by: scope.send_by, send_after: scope.send_after });
  assert.match(path, /send_by=2026-11-10T00%3A00%3A00.000Z/);
  assert.equal(validateQuery('campaigns.get', { send_by: scope.send_by }).send_by, scope.send_by);
  for (const args of [['0', '2026-11-10T09:00'], ['1.1', '2026-11-10T09:00'], ['100001', '2026-11-10T09:00'], ['100', '2026-11-03T09:59'], ['100', 'bad'], ['100', '2026-11-10T09:00', '2026-11-10T09:00']]) assert.throws(() => scopeInput(...[args[0], args[1], args[2] ?? '', now]), { code: 'INVALID_REQUEST' });
});

test('6.5 承認不要の組織で件数超過から戻ったときだけ同じ申請者も承認できる', () => {
  const own = user('admin', 'sender-person');
  assert.equal(primaryAction(campaign('PENDING_APPROVAL', { approval_required: false }), own, checked).enabled, true);
  assert.equal(primaryAction(campaign('PENDING_APPROVAL', { approval_required: true }), own, checked).enabled, false);
});

test('7.10 見込みの不足と未取得を区別し、新メッセージと管理者の調査欄を用意する', () => {
  assert.match(forecastText(null), /取得できません/);
  assert.match(forecastText({ assumptions: { recipients: 10000 }, completes: false, capacity_until_deadline: 7000, shortfall: 3000 }), /対象 10,000件.*約7,000件.*不足 約3,000件/);
  const html = readFileSync(new URL('../../web/index.html', import.meta.url), 'utf8');
  for (const selector of ['data-scope', 'data-max-recipients', 'data-send-by', 'data-send-after', 'data-forecast', 'data-deadline', 'data-events', 'data-unknown-review', 'data-unknown-admin', 'data-unknown-submit']) assert.ok(html.includes(selector));
  const help = readFileSync(new URL('../../web/help.html', import.meta.url), 'utf8');
  for (const code of ['CAPACITY_INSUFFICIENT', 'AUDIENCE_EXCEEDS_APPROVAL', 'OUTSIDE_APPROVED_WINDOW', 'DEADLINE_PASSED', 'SCHEDULE_DELAYED', 'EVENTS_MISSING', 'UNKNOWN_REVIEW_OPEN']) { assert.ok(ERROR_MESSAGES[code]); assert.ok(help.includes(code)); }
  assert.equal(apiPath(`/campaigns/${id}/unknowns`), `/campaigns/${id}/unknowns`);
  assert.equal(controlPolicy(campaign('QUEUED'), user('sender')).pause.enabled, true);
});

test('schedule selection is available only when approved and recovery requires admin with reason', () => {
  for (const state of ['DRAFT', 'PENDING_APPROVAL', 'SCHEDULED', 'QUEUED']) assert.equal(canSchedule(campaign(state), user('admin')), false);
  assert.equal(canSchedule(campaign('APPROVED'), user('sender')), true);
  assert.equal(canSchedule(campaign('APPROVED'), user('viewer')), false);
  assert.equal(canSchedule(campaign('APPROVED'), user('admin'), true), false);
  assert.deepEqual(testSendInput(user('sender'), false), {});
  assert.throws(() => testSendInput(user('sender'), true, 'check'), { code: 'FORBIDDEN' });
  assert.throws(() => testSendInput(user('admin'), true, ' '), { code: 'INVALID_REQUEST' });
  assert.deepEqual(testSendInput(user('admin'), true, ' recheck '), { purpose: 'ACCEPTANCE_RECOVERY', note: 'recheck' });
});

test('UI-09 下書きは管理者・配信担当だけが保存後に申請できる', () => {
  for (const role of ['admin', 'sender']) assert.deepEqual(primaryAction(campaign('DRAFT'), user(role)), { action: 'submit', label: '承認申請', enabled: true, reason: '' });
  for (const role of ['approver', 'viewer']) assert.equal(primaryAction(campaign('DRAFT'), user(role)).enabled, false);
  assert.match(primaryAction({ status: 'DRAFT' }, user('sender')).reason, /保存/);
  assert.equal(primaryAction(campaign('DRAFT'), user('sender'), { dirty: true }).enabled, false);
});

test('UI-09 承認は別人の管理者・承認者だけ、描画結果と全ハッシュの一致が必要', () => {
  for (const role of ['admin', 'approver']) {
    assert.equal(primaryAction(campaign('PENDING_APPROVAL'), user(role), checked).enabled, true);
    assert.equal(primaryAction(campaign('PENDING_APPROVAL'), user(role, 'sender-person'), checked).enabled, false);
    assert.equal(primaryAction(campaign('PENDING_APPROVAL'), user(role)).enabled, false);
    assert.equal(primaryAction(campaign('PENDING_APPROVAL'), user(role), { ...checked, previewHash: 'b'.repeat(64) }).enabled, false);
    assert.equal(primaryAction(campaign('PENDING_APPROVAL'), user(role), { ...checked, confirmed: false }).enabled, false);
  }
  for (const role of ['sender', 'viewer']) assert.equal(primaryAction(campaign('PENDING_APPROVAL'), user(role), checked).enabled, false);
  assert.equal(primaryAction(campaign('PENDING_APPROVAL', { submitted_by: '' }), user('admin'), checked).enabled, false);
});

test('UI-09 承認済みだけが開始でき、承認者・閲覧者には開始を許可しない', () => {
  for (const role of ['admin', 'sender']) assert.equal(primaryAction(campaign('APPROVED'), user(role)).enabled, true);
  for (const role of ['approver', 'viewer']) assert.equal(primaryAction(campaign('APPROVED'), user(role)).enabled, false);
  for (const state of ['SCHEDULED', 'QUEUED', 'SENDING', 'PAUSED', 'NEEDS_REVIEW', 'COMPLETED', 'CANCELLED', 'UNKNOWN']) {
    const action = primaryAction(campaign(state), user('admin'), checked);
    assert.equal(action.enabled, false);
    assert.ok(action.reason);
  }
});

test('UI-09 役割を併せ持っても自分の申請は承認できない', () => {
  assert.equal(primaryAction(campaign('PENDING_APPROVAL'), user(['sender', 'approver', 'viewer']), checked).enabled, true);
  assert.equal(primaryAction(campaign('PENDING_APPROVAL'), user(['admin', 'approver'], 'sender-person'), checked).enabled, false);
});

test('UI-09 二度押し・競合・通信結果不明のときは開始を止め理由を表示', () => {
  for (const flag of ['busy', 'stale', 'uncertain']) {
    const action = primaryAction(campaign('APPROVED'), user('admin'), { [flag]: true });
    assert.equal(action.enabled, false);
    assert.ok(action.reason);
  }
});

test('UI-11 利用者による停止は運営者が再開でき、システム停止は管理者だけ', () => {
  for (const role of ['admin', 'sender', 'approver', 'viewer']) {
    assert.equal(controlPolicy(campaign('PAUSED', { pause_reason: 'USER' }), user(role)).resume.enabled, role !== 'viewer');
    for (const reason of ['AUTH_CHECK', 'QUOTA', 'REPUTATION_ALARM', 'UNKNOWN', undefined]) assert.equal(controlPolicy(campaign('PAUSED', { pause_reason: reason }), user(role)).resume.enabled, role === 'admin');
  }
});

test('UI-11 一時停止・予約取消・差戻しは役割と状態で判定', () => {
  for (const role of ['admin', 'sender', 'approver', 'viewer']) {
    assert.equal(controlPolicy(campaign('SENDING'), user(role)).pause.enabled, role !== 'viewer');
    assert.equal(controlPolicy(campaign('SCHEDULED'), user(role)).unschedule.enabled, ['admin', 'sender'].includes(role));
    assert.equal(controlPolicy(campaign('PENDING_APPROVAL'), user(role)).reject.enabled, ['admin', 'approver'].includes(role));
    assert.equal(controlPolicy(campaign('COMPLETED'), user(role)).resume.enabled, false);
  }
});

test('UI-11 中止は有効な配信だけで、終了した配信を再開しない', () => {
  for (const state of ['APPROVED', 'SCHEDULED', 'QUEUED', 'SENDING', 'PAUSED', 'NEEDS_REVIEW']) {
    assert.equal(controlPolicy(campaign(state), user('sender')).cancel.enabled, true);
    assert.equal(controlPolicy(campaign(state), user('viewer')).cancel.enabled, false);
  }
  for (const state of ['DRAFT', 'PENDING_APPROVAL', 'COMPLETED', 'CANCELLED']) assert.equal(controlPolicy(campaign(state), user('admin')).cancel.enabled, false);
});

test('UI-11 処理中・結果不明のときは補助の状態変更も止める', () => {
  const policy = controlPolicy(campaign('SENDING'), user('admin'), true);
  assert.ok(Object.values(policy).every((item) => !item.enabled && item.reason));
});
