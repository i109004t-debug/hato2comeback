import test from 'node:test';
import assert from 'node:assert/strict';
import { primaryAction, controlPolicy } from '../../web/js/views/send.js';

const id = '01JAZ6Y0N00000000000000001';
const hash = 'a'.repeat(64);
const user = (role, sub = 'approver-person') => ({ sub, roles: Array.isArray(role) ? role : [role] });
const campaign = (status, extra = {}) => ({ campaign_id: id, status, submitted_by: 'sender-person', content_sha256: hash, ...extra });
const checked = { previewHash: hash, confirmed: true };

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
