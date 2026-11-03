import test from 'node:test';
import assert from 'node:assert/strict';
import { maskAddress, visibleAddress, isMasked, formatCount, formatTime, jstInput, fromJstInput, statusLabel, resultLabel, progressLines, createActionGate, startPolling } from '../../web/js/dom.js';
import { defaultSchedule, scheduleInput, isOnTheHour, hasShortUrl, validateDraft, draftFooter, reviewInput } from '../../web/js/views/send.js';
import { consentInput, contactInput, topicSummary, importReason } from '../../web/js/views/contacts.js';
import { settingsInput, deliveryInput, DELIVERY_CASES } from '../../web/js/views/settings.js';
import { historyRow } from '../../web/js/views/history.js';
import { parseRoute } from '../../web/js/app.js';
import { validateRoute } from '../../src/common/validate.js';
import { createFooter } from '../../src/common/footer.js';
import { DELIVERY_CASES as SERVER_CASES } from '../../src/common/precheck.js';

const user = (roles) => ({ sub: 'person', roles });
const now = Date.parse('2026-11-03T10:00:00+09:00');
const org = { from_local: 'info', from_name: '会報事務局', legal: { sender_name: '会報事務局', address: '東京都千代田区', contact: 'support@example.jp' } };

test('9.3・11.4 閲覧者は伏せ字、複数役割では権限を足し合わせる', () => {
  assert.equal(visibleAddress('abcz@example.com', user(['viewer'])), 'a***z@example.com');
  assert.equal(maskAddress('a@example.com'), 'a***@example.com');
  assert.equal(maskAddress('a***z@example.com'), 'a***z@example.com');
  assert.equal(maskAddress('invalid'), '***');
  assert.equal(visibleAddress('abcz@example.com', user(['viewer', 'sender'])), 'abcz@example.com');
  assert.equal(isMasked(user([])), true);
  for (const role of ['admin', 'sender', 'approver']) assert.equal(isMasked(user([role])), false);
});

test('8.1 未取得の件数を0に見せず、受付と配送を別に表示', () => {
  assert.equal(formatCount(null), '—');
  assert.equal(formatCount(undefined), '—');
  assert.equal(formatCount(0), '0');
  assert.equal(formatCount(1234), '1,234');
  const lines = Object.fromEntries(progressLines({ recipients_total: 100, counts: { accepted: 90, failed: 2, unknown: 3 } }, { metrics: { Send: 89, Delivery: 80, DeliveryDelay: 4 } }));
  assert.equal(lines['送信済み（SES受付・送信処理の集計）／総数'], '90 ／ 100');
  assert.equal(lines['SES受付（イベントの集計）'], '89');
  assert.equal(lines['配送'], '80');
  assert.equal(lines['苦情'], '—');
  assert.equal(lines['不明'], '3');
});

test('9.2 日時は日本時間で表示し、入力も日本時間として解釈', () => {
  assert.match(formatTime('2026-11-02T15:05:00Z'), /2026\/11\/03 00:05:00（日本時間）/);
  assert.equal(formatTime('bad'), '—');
  assert.equal(jstInput('2026-11-02T15:05:00Z'), '2026-11-03T00:05');
  assert.equal(fromJstInput('2026-11-03T00:05'), '2026-11-03T00:05:00+09:00');
  assert.equal(fromJstInput('2026-02-30T09:00'), null);
  assert.equal(fromJstInput('2026-11-03T24:00'), null);
});

test('8.1・8.2 停止済みの未送信を失敗と分けて詳細・履歴・一覧に表示する', () => {
  const campaign = { recipients_total: 10, counts: { accepted: 6, failed: 1, unknown: 1, skipped_blocked: 2 } };
  const lines = Object.fromEntries(progressLines(campaign));
  assert.equal(lines['失敗'], '1');
  assert.equal(lines['停止済みのため送らなかった'], '2');
  assert.equal(historyRow(campaign).problems, '1 ／ 1');
  assert.equal(historyRow(campaign).skipped, '2');
  assert.equal(resultLabel('SKIPPED'), '停止済みのため送らなかった');
  assert.equal(resultLabel('FAILED'), '失敗');
  assert.equal(resultLabel('UNKNOWN'), '不明');
});

test('7.1 予約の既定は05分で、常に5分以上後', () => {
  for (const current of ['2026-11-03T10:00:00+09:00', '2026-11-03T10:00:01+09:00', '2026-11-03T10:59:59+09:00', '2026-12-31T23:59:00+09:00']) {
    const time = Date.parse(current);
    const value = defaultSchedule(time);
    assert.equal(value.slice(14, 16), '05');
    assert.ok(Date.parse(fromJstInput(value)) >= time + 300000);
  }
  assert.equal(defaultSchedule(now), '2026-11-03T10:05');
  assert.equal(isOnTheHour('2026-11-03T19:00'), true);
  assert.equal(isOnTheHour('2026-11-03T19:05'), false);
});

test('7.1 5分後〜90日後を検証し、API-19と同じ形式で送る', () => {
  assert.deepEqual(scheduleInput('NOW', '', now), { mode: 'NOW' });
  assert.deepEqual(scheduleInput('SCHEDULED', '2026-11-03T10:05', now), { mode: 'SCHEDULED', at: '2026-11-03T10:05:00+09:00' });
  assert.doesNotThrow(() => scheduleInput('SCHEDULED', jstInput(now + 90 * 86400000), now));
  for (const value of ['2026-11-03T10:04', jstInput(now + 90 * 86400000 + 60000), '2026-02-30T10:00', 'bad']) assert.throws(() => scheduleInput('SCHEDULED', value, now));
});

test('6.3 下書きのバイト数・Unicode文字数・禁止文字・改行を検証', () => {
  const valid = { topic: 'kaiho', subject: '会報', body_text: '本文\r\n続き\r末尾' };
  assert.equal(validateDraft(valid).body_text, '本文\n続き\n末尾');
  assert.doesNotThrow(() => validateDraft({ ...valid, subject: '😀'.repeat(200), body_text: 'a'.repeat(51200) }));
  for (const change of [{ subject: '😀'.repeat(201) }, { subject: 'a\nb' }, { subject: '{{name}}' }, { body_text: '{{name}}' }, { topic: '' }, { body_text: 'あ'.repeat(17067) }]) assert.throws(() => validateDraft({ ...valid, ...change }));
  assert.equal(hasShortUrl('案内 https://bit.ly/abc'), true);
  assert.equal(hasShortUrl('https://bit.ly.evil.example/path'), false);
});

test('6.7 下書きのフッターはAPIの生成文と一致し未設定を隠さない', () => {
  assert.equal(draftFooter(org, '会報'), createFooter(org, '会報'));
  assert.equal((draftFooter(org, '会報').match(/\{\{amazonSESUnsubscribeUrl\}\}/g) ?? []).length, 1);
  assert.match(draftFooter({}, '会報'), /未設定/);
});

test('7.7 準備中は最初からやり直すか中止、スナップショット確定後は範囲の判断', () => {
  const preparing = { review: { phase: 'prepare' } };
  assert.deepEqual(reviewInput(preparing, 'RESTART', '送信前の異常を修正'), { decision: 'SKIP', note: '送信前の異常を修正', resume: false });
  assert.throws(() => reviewInput(preparing, 'RESEND', '確認済み'));
  assert.throws(() => reviewInput({ chunks_total: 1 }, 'RESTART', '確認済み'));
  const recorded = { chunks_total: 1, review: { chunk: 0, index_from: 0, index_to: 0 }, review_recipients: ['member@example.jp'], athena_query: 'SELECT * FROM ht2_events.ses_events' };
  assert.deepEqual(reviewInput(recorded, 'SKIP', '配送の記録で確認'), { decision: 'SKIP', note: '配送の記録で確認' });
  assert.throws(() => reviewInput({ chunks_total: 1 }, 'RESEND', '確認済み'));
  assert.deepEqual(reviewInput({ chunks_total: 1 }, 'CANCEL', '確認不能のため中止'), { decision: 'CANCEL', note: '確認不能のため中止' });
  assert.throws(() => reviewInput({ chunks_total: 1 }, 'RESEND', ''));
});

test('9.3 同意は実日時・取得経路が必須、未来を許可しない', () => {
  assert.deepEqual(consentInput('2026-11-03T09:00', '入会申込', 'v1', now), { at: '2026-11-03T09:00:00+09:00', source: '入会申込', version: 'v1' });
  assert.throws(() => consentInput('2026-11-03T10:01', 'フォーム', '', now));
  assert.throws(() => consentInput('2026-11-03T09:00', '', '', now));
});

test('API-06〜10 宛先操作の本文を実APIのスキーマで検証', () => {
  const values = { email: 'member@example.jp', name: '会員', consent_at: '2026-11-03T09:00', consent_source: '入会申込', consent_version: 'v1', note: '本人から新しく申込あり' };
  for (const [operation, serverOperation] of [['create', 'contacts.create'], ['update', 'contacts.update'], ['unsubscribe', 'contacts.unsubscribe'], ['unsubscribe-all', 'contacts.unsubscribe'], ['reconsent', 'contacts.reconsent'], ['erase', 'contacts.erase']]) {
    const input = contactInput({ ...values, operation }, ['kaiho'], now);
    assert.doesNotThrow(() => validateRoute(serverOperation, input.body, { now: () => now, topics: ['kaiho'] }));
    assert.ok(!input.path.includes(values.email));
    if (operation === 'update') assert.deepEqual(input.body.topics, { kaiho: 'OPT_IN' });
    if (operation === 'reconsent') assert.equal(input.body.reconsent.version, undefined);
  }
  assert.throws(() => contactInput({ ...values, operation: 'create' }, [], now));
  assert.throws(() => contactInput({ ...values, operation: 'unsubscribe' }, ['kaiho', 'event'], now));
  assert.throws(() => contactInput({ ...values, operation: 'erase', note: '' }, [], now));
});

test('9.3 トピックの未設定は既定停止、全停止は個別購読より優先', () => {
  const topics = [{ TopicName: 'kaiho', DisplayName: '会報', DefaultSubscriptionStatus: 'OPT_OUT' }];
  assert.equal(topicSummary({}, topics), '会報：停止');
  assert.equal(topicSummary({ TopicPreferences: [{ TopicName: 'kaiho', SubscriptionStatus: 'OPT_IN' }] }, topics), '会報：購読');
  assert.equal(topicSummary({ UnsubscribeAll: true, TopicPreferences: [{ TopicName: 'kaiho', SubscriptionStatus: 'OPT_IN' }] }, topics), '会報：停止');
  assert.match(importReason('EXISTING_SKIPPED'), /変更しません/);
  assert.doesNotMatch(importReason('member@example.jp'), /@/);
});

test('9.4 API-02の更新では組織設定だけを送り、versionを必須にする', () => {
  const input = settingsInput({ ...org, ...org.legal, approval_required: 'on', test_recipients: 'staff@example.jp\n\n staff2@example.jp ', max_rate_per_sec: '10', delivery_check: { status: 'PASS' } }, 3);
  assert.equal(input.version, 3);
  assert.equal(input.delivery_check, undefined);
  assert.deepEqual(input.test_recipients, ['staff@example.jp', 'staff2@example.jp']);
  assert.doesNotThrow(() => validateRoute('settings.update', input, { senderDomain: 'example.jp' }));
  assert.throws(() => settingsInput({ test_recipients: 'x\n'.repeat(6), max_rate_per_sec: '10' }, 0));
  assert.throws(() => settingsInput({ test_recipients: '', max_rate_per_sec: 'NaN' }, 0));
});

test('API-29 必須試験をサーバーと一致させ、確定時はメモだけを送る', () => {
  assert.deepEqual(DELIVERY_CASES, SERVER_CASES);
  const input = { passed: 'true', note: '主要事業者で受信確認済み', evidence_key: 'delivery-checks/2026-11/report.json', config_hash: 'a'.repeat(64), dns_config_hash: 'b'.repeat(64), ...Object.fromEntries(DELIVERY_CASES.map((id) => [id, 'PASS'])) };
  assert.deepEqual(deliveryInput(input), { note: input.note });
  assert.doesNotThrow(() => validateRoute('delivery-check.submit', deliveryInput(input)));
  assert.throws(() => deliveryInput({ note: ' ' }));
  assert.throws(() => deliveryInput({ note: 'x'.repeat(1001) }));
});

test('9.4 配信履歴は状態・保持期間・予約日時・件数を整形', () => {
  const row = historyRow({ status: 'SCHEDULED', topic_display: '会報', created_at: '2026-11-02T15:05:00Z', scheduled_at: '2026-11-03T10:05:00+09:00', counts: { accepted: 0, failed: 0, unknown: 0 } });
  assert.equal(row.state, '予約済み');
  assert.match(row.title, /保持期間/);
  assert.match(row.scheduled, /10:05/);
  assert.equal(row.accepted, '0 ／ —');
  assert.equal(statusLabel('UNEXPECTED'), '状態を確認できません');
});

test('9.1 ハッシュ経路は既知の画面とULIDに限定', () => {
  assert.deepEqual(parseRoute('#/send/01JAZ6Y0N00000000000000001'), { view: 'send', id: '01JAZ6Y0N00000000000000001' });
  assert.deepEqual(parseRoute('#/settings'), { view: 'settings', id: undefined });
  assert.deepEqual(parseRoute('#/contacts/01JAZ6Y0N00000000000000001'), { view: 'send', id: undefined });
});

test('9.2 同時クリックを1回に制限し、例外後にもゲートを解放', async () => {
  const gate = createActionGate();
  let finish;
  let count = 0;
  const first = gate.run(async () => { count++; await new Promise((resolve) => { finish = resolve; }); });
  assert.equal(gate.busy, true);
  assert.equal(await gate.run(async () => { count++; }), false);
  finish();
  assert.equal(await first, true);
  assert.equal(count, 1);
  await assert.rejects(gate.run(async () => { throw new Error('failed'); }));
  assert.equal(gate.busy, false);
});

test('9.2・9.4 10秒の更新は重複せず、画面移動時に停止', async () => {
  const timers = [];
  const cleared = [];
  let finish;
  let count = 0;
  const stop = startPolling(async () => { count++; await new Promise((resolve) => { finish = resolve; }); }, { setTimer: (fn, delay) => { timers.push({ fn, delay }); return timers.length; }, clearTimer: (id) => cleared.push(id) });
  assert.equal(timers[0].delay, 10000);
  const running = timers[0].fn();
  assert.equal(count, 1);
  assert.equal(timers.length, 1);
  stop(); finish(); await running;
  assert.equal(timers.length, 1);
  assert.ok(cleared.includes(1));
});
