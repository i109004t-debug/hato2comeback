import test from 'node:test';
import assert from 'node:assert/strict';
import { managementFixture } from '../helpers/management.js';
import { ID, failure, eraseHash } from '../helpers/sending.js';
import { API_ROUTES } from '../../src/common/router.js';
import { DELIVERY_CASES } from '../../src/common/precheck.js';
import { addressHash } from '../../src/common/log.js';

const consent = { at: '2026-01-01T00:00:00Z', source: '入会フォーム' };
const newContact = { email: 'new@example.com', consent, topics: ['news'] };
const expectCode = (response, status, code) => { assert.equal(response.statusCode, status, response.body); assert.equal(response.json.error_code, code); };
const audits = (f) => [...f.ddb.items.values()].filter((item) => item.PK.startsWith('AUDIT#'));
const rejectedOperations = {
  admin: [],
  sender: ['settings.update', 'delivery-check.get', 'delivery-check.start', 'delivery-check.case', 'delivery-check.evidence', 'delivery-check.submit', 'staff.list', 'staff.create', 'staff.change', 'contacts.reconsent', 'contacts.erase', 'campaigns.approve', 'campaigns.reject', 'campaigns.review', 'audit.list'],
  approver: ['contacts.events', 'imports.confirm', 'imports.discard', 'settings.update', 'delivery-check.get', 'delivery-check.start', 'delivery-check.case', 'delivery-check.evidence', 'delivery-check.submit', 'staff.list', 'staff.create', 'staff.change', 'contacts.create', 'contacts.update', 'contacts.unsubscribe', 'contacts.reconsent', 'contacts.erase', 'imports.create', 'imports.get', 'imports.list', 'campaigns.create', 'campaigns.update', 'campaigns.test-send', 'campaigns.submit', 'campaigns.start', 'campaigns.unschedule', 'campaigns.review', 'audit.list'],
  viewer: ['contacts.events', 'imports.confirm', 'imports.discard', 'settings.update', 'delivery-check.get', 'delivery-check.start', 'delivery-check.case', 'delivery-check.evidence', 'delivery-check.submit', 'staff.list', 'staff.create', 'staff.change', 'contacts.create', 'contacts.update', 'contacts.unsubscribe', 'contacts.reconsent', 'contacts.erase', 'imports.create', 'imports.get', 'imports.list', 'campaigns.create', 'campaigns.update', 'campaigns.preview', 'campaigns.test-send', 'campaigns.submit', 'campaigns.approve', 'campaigns.reject', 'campaigns.start', 'campaigns.unschedule', 'campaigns.pause', 'campaigns.resume', 'campaigns.cancel', 'campaigns.review', 'audit.list'],
};

test('T-01 閲覧者による登録・配信開始を処理前に拒否', async () => {
  const f = managementFixture({ role: 'viewer' });
  for (const [path, body] of [['/contacts', newContact], [f.campaignPath + '/start', { mode: 'NOW' }]]) expectCode(await f.request('POST ' + path, body), 403, 'FORBIDDEN');
  assert.equal(f.changes.length, 0); assert.equal(f.executions.size, 0);
});

for (const role of ['admin', 'sender', 'approver', 'viewer']) {
  test(`T-24 権限表の拒否を全ルートで検証: ${role}`, async () => {
    const f = managementFixture({ role });
    for (const route of API_ROUTES.filter((route) => rejectedOperations[role].includes(route.operation))) {
      const path = route.path.replace('{id}', ID).replace('{importId}', ID);
      expectCode(await f.request(`${route.method} ${path}`, {}), 403, 'FORBIDDEN');
    }
    assert.equal(f.changes.length, 0); assert.equal(f.invocations.length, 0);
  });
}

test('T-02 Cognitoの無効化とグループ変更は60秒で反映', async () => {
  const f = managementFixture();
  assert.equal((await f.request('GET /me')).statusCode, 200);
  f.enabled = false; f.advance(59999);
  assert.equal((await f.request('GET /me')).statusCode, 200);
  f.advance(1);
  expectCode(await f.request('GET /me'), 403, 'USER_DISABLED');
  assert.equal(f.cognitoCalls, 2);
  f.enabled = true; f.role = 'viewer';
  expectCode(await f.request('POST /contacts', newContact), 403, 'FORBIDDEN');
});

test('T-03 オリジン→access token→ルート→役割→入力の順序', async () => {
  const f = managementFixture();
  expectCode(await f.request('GET /missing', undefined, { headers: {} }), 403, 'FORBIDDEN_ORIGIN');
  expectCode(await f.request('GET /missing', undefined, { requestContext: { http: { method: 'GET' } } }), 401, 'UNAUTHENTICATED');
  expectCode(await f.request('GET /missing'), 404, 'NOT_FOUND');
  assert.equal(f.cognitoCalls, 0);
  const idToken = { http: { method: 'GET' }, authorizer: { jwt: { claims: { sub: 'user', token_use: 'id', client_id: 'web' } } } };
  expectCode(await f.request('GET /me', undefined, { requestContext: idToken }), 401, 'UNAUTHENTICATED');
  const result = await f.request('GET /me', undefined, { headers: { 'x-origin-verify': 'old-origin' } });
  assert.equal(result.statusCode, 200); assert.equal(result.headers['cache-control'], 'no-store');
  assert.equal(result.json.organization_name, '会');
});

test('T-04 法定表示がない申請はテンプレート作成前に拒否', async () => {
  const f = managementFixture(); f.draft(); f.ddb.set({ ...f.org, legal: {} });
  expectCode(await f.request(`POST ${f.campaignPath}/submit`, f.scope()), 422, 'SETTINGS_INCOMPLETE');
  assert.equal(f.templates.size, 0); assert.equal(f.getCampaign().status, 'DRAFT');
});

test('6.4 固定テンプレート・ハッシュ・差出人を固定し、差戻し後は新しい版', async () => {
  const f = managementFixture(); f.draft();
  let response = await f.request(`POST ${f.campaignPath}/submit`, f.scope());
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json.status, 'PENDING_APPROVAL'); assert.match(response.json.content_sha256, /^[a-f0-9]{64}$/);
  const first = response.json.template_name;
  const template = f.templates.get(first);
  assert.equal(template.Html, undefined); assert.equal(template.Text.split('{{amazonSESUnsubscribeUrl}}').length, 2);
  response = await f.request(`POST ${f.campaignPath}/preview`, {});
  assert.equal(response.json.text, template.Text);
  assert.equal((await f.request(`POST ${f.campaignPath}/reject`, { reason: '修正依頼' })).json.status, 'DRAFT');
  response = await f.request(`POST ${f.campaignPath}/submit`, f.scope());
  assert.equal(response.json.rev, 2); assert.equal(f.templates.size, 2); assert.notEqual(response.json.template_name, first);
  assert.ok(audits(f).some((item) => item.action === 'CAMPAIGNS_SUBMIT'));
});

test('6.4 テンプレート作成だけ成功した後の再申請は内容一致を確認', async () => {
  const f = managementFixture(); f.draft();
  const create = f.deps.ses.createEmailTemplate;
  f.deps.ses.createEmailTemplate = async (input) => { await create(input); throw failure('TimeoutError'); };
  expectCode(await f.request(`POST ${f.campaignPath}/submit`, f.scope()), 500, 'INTERNAL');
  f.deps.ses.createEmailTemplate = create;
  assert.equal((await f.request(`POST ${f.campaignPath}/submit`, f.scope())).statusCode, 200);
  const g = managementFixture(); g.draft(); g.templates.set(`ht2-c-${ID}-1`, { Subject: '別の件名', Text: '別の本文' });
  expectCode(await g.request(`POST ${g.campaignPath}/submit`, g.scope()), 409, 'HASH_MISMATCH');
});

test('T-05 自分の申請は管理者でも承認できない', async () => {
  const f = managementFixture(); f.draft();
  const submitted = await f.request(`POST ${f.campaignPath}/submit`, f.scope());
  expectCode(await f.request(`POST ${f.campaignPath}/approve`, { ...f.scope(), content_sha256: submitted.json.content_sha256 }), 403, 'FORBIDDEN');
});

test('T-06 ハッシュ不一致を拒否し、別人が一致する内容だけ承認', async () => {
  const f = managementFixture(); f.draft();
  const submitted = await f.request(`POST ${f.campaignPath}/submit`, f.scope());
  f.sub = 'second';
  expectCode(await f.request(`POST ${f.campaignPath}/approve`, { ...f.scope(), content_sha256: '0'.repeat(64) }), 409, 'HASH_MISMATCH');
  const response = await f.request(`POST ${f.campaignPath}/approve`, { ...f.scope(), content_sha256: submitted.json.content_sha256 });
  assert.equal(response.json.status, 'APPROVED'); assert.equal(response.json.approved_by, 'second');
});

test('6.2 version競合・状態競合を拒否し、自動承認を監査', async () => {
  const f = managementFixture(); f.draft();
  expectCode(await f.request(`PATCH ${f.campaignPath}`, { version: 9, subject: '修正' }), 409, 'VERSION_CONFLICT');
  const updated = await f.request(`PATCH ${f.campaignPath}`, { version: 0, subject: '修正' });
  assert.equal(updated.json.version, 1);
  f.ddb.set({ ...f.org, approval_required: false });
  const response = await f.request(`POST ${f.campaignPath}/submit`, f.scope());
  assert.equal(response.json.status, 'APPROVED'); assert.equal(response.json.approved_by, 'AUTO');
  assert.ok(audits(f).some((item) => item.action === 'APPROVE' && item.details.approved_by === 'AUTO'));
  expectCode(await f.request(`PATCH ${f.campaignPath}`, { version: 2, subject: '再編集' }), 409, 'STATE_CONFLICT');
});

test('T-07 即時開始の競合でも実行は一つ、終了済みの同名実行を成功扱いしない', async () => {
  const f = managementFixture(); f.setCampaign({ status: 'APPROVED' });
  const responses = await Promise.all([f.request(`POST ${f.campaignPath}/start`, { mode: 'NOW' }), f.request(`POST ${f.campaignPath}/start`, { mode: 'NOW' })]);
  assert.equal(responses.filter((result) => result.statusCode === 200).length, 1); assert.equal(f.executions.size, 1);
  assert.deepEqual(JSON.parse(f.executions.get(ID).input), { campaign_id: ID });
  const g = managementFixture(); g.setCampaign({ status: 'APPROVED' }); g.executions.set(ID, {});
  expectCode(await g.request(`POST ${g.campaignPath}/start`, { mode: 'NOW' }), 409, 'STATE_CONFLICT');
  assert.equal(g.getCampaign().status, 'QUEUED');
});

test('7.1 予約は東京時刻・無再試行・自動削除・00分の注意、取消は先にDelete', async () => {
  const f = managementFixture(); f.setCampaign({ status: 'APPROVED' });
  expectCode(await f.request(`POST ${f.campaignPath}/start`, { mode: 'SCHEDULED', at: new Date(f.deps.now() + 299999).toISOString() }), 400, 'INVALID_REQUEST');
  const response = await f.request(`POST ${f.campaignPath}/start`, { mode: 'SCHEDULED', at: '2026-11-04T19:00:00+09:00' });
  assert.equal(response.statusCode, 200, response.body); assert.ok(response.json.warnings.includes('ON_THE_HOUR'));
  const schedule = f.schedules.get(`ht2-${ID}`);
  assert.equal(schedule.ScheduleExpression, 'at(2026-11-04T19:00:00)'); assert.equal(schedule.ScheduleExpressionTimezone, 'Asia/Tokyo');
  assert.equal(schedule.ActionAfterCompletion, 'DELETE'); assert.equal(schedule.Target.RetryPolicy.MaximumRetryAttempts, 0);
  assert.equal((await f.request(`POST ${f.campaignPath}/unschedule`, {})).json.status, 'APPROVED');
  assert.equal(f.schedules.size, 0);
  f.setCampaign({ status: 'SENDING' }); expectCode(await f.request(`POST ${f.campaignPath}/unschedule`, {}), 409, 'ALREADY_STARTED');
});

test('7.1 予約時だけSES枠不足を警告として返す', async () => {
  const f = managementFixture(); f.setCampaign({ status: 'APPROVED' }); f.account.SendQuota.Max24HourSend = 0;
  expectCode(await f.request(`POST ${f.campaignPath}/start`, { mode: 'NOW' }), 422, 'QUOTA_INSUFFICIENT');
  const response = await f.request(`POST ${f.campaignPath}/start`, { mode: 'SCHEDULED', at: '2026-11-04T19:05:00+09:00' });
  assert.ok(response.json.warnings.includes('QUOTA_INSUFFICIENT'), response.body);
});

test('7.6 USER停止は担当・承認者も再開でき、保存済みトークンへ成功を通知', async () => {
  const f = managementFixture({ role: 'approver' }); f.setCampaign({ status: 'SENDING' });
  const paused = await f.request(`POST ${f.campaignPath}/pause`, {});
  assert.equal(paused.json.status, 'PAUSED'); assert.equal(paused.json.pause_reason, 'USER');
  f.setCampaign({ task_token: 'private-task' });
  const response = await f.request(`POST ${f.campaignPath}/resume`, {});
  assert.equal(response.json.status, 'SENDING', response.body); assert.equal(response.json.task_token, undefined);
  assert.deepEqual(f.tokens, [{ success: { taskToken: 'private-task', output: '{}' } }]);
});

test('T-49 システム停止の再開は管理者・是正メモ・存在する証跡・検査が必要', async () => {
  const f = managementFixture({ role: 'sender' }); f.setCampaign({ status: 'PAUSED', pause_reason: 'EVENT_LOG_STALE', updated_at: new Date(f.deps.now()).toISOString() });
  expectCode(await f.request(`POST ${f.campaignPath}/resume`, {}), 403, 'FORBIDDEN');
  f.role = 'admin'; f.resetApi();
  expectCode(await f.request(`POST ${f.campaignPath}/resume`, {}), 400, 'INVALID_REQUEST');
  const body = { note: '配送先の権限を修正し少量試験の証跡を確認', evidence_key: 'delivery-checks/repair/evidence.json' };
  expectCode(await f.request(`POST ${f.campaignPath}/resume`, body), 400, 'INVALID_REQUEST');
  f.files.set(body.evidence_key, '{}'); f.alarms.find((item) => item.AlarmName.endsWith('firehose-delivery')).StateValue = 'ALARM';
  expectCode(await f.request(`POST ${f.campaignPath}/resume`, body), 503, 'EVENT_LOG_STALE');
  f.alarms.forEach((item) => item.StateValue = 'OK');
  assert.equal((await f.request(`POST ${f.campaignPath}/resume`, body)).json.status, 'SENDING');
  assert.ok(audits(f).some((item) => item.action === 'RESUME' && item.details.note === body.note));
});

test('7.6 停止中の中止はCancelledで待ち合わせを解放し、トークンを応答しない', async () => {
  const f = managementFixture(); f.setCampaign({ status: 'PAUSED', task_token: 'private-task' });
  const response = await f.request(`POST ${f.campaignPath}/cancel`, { reason: '中止依頼' });
  assert.equal(response.json.status, 'CANCELLED'); assert.equal(response.json.task_token, undefined);
  assert.equal(f.tokens[0].failure.error, 'Cancelled'); assert.equal(f.getCampaign().task_token, undefined);
});

for (const [decision, index] of [['SKIP', 20], ['RESEND', 0]]) {
  test(`T-11 API-22 ${decision}は保存済み範囲から新しい実行で再開`, async () => {
    const f = managementFixture({ registered: true, count: 25 }); await f.prepare();
    f.setCampaign({ status: 'NEEDS_REVIEW', review: { chunk: 0, index_from: 0, index_to: 19, reason: 'WORKER_FAILED' } });
    const response = await f.request(`POST ${f.campaignPath}/review`, { decision, note: '配送記録のSendとログ遅延を確認して判断' });
    assert.equal(response.json.status, 'QUEUED', response.body); assert.equal(response.json.progress.index, index); assert.equal(f.getCampaign().review, undefined);
    assert.deepEqual(JSON.parse(f.executions.get(`${ID}-r1`).input), { campaign_id: ID, resume: true });
  });
}

test('7.7 準備中の異常はresume:falseだけ、要確認の情報は管理者だけ', async () => {
  const f = managementFixture(); f.setCampaign({ status: 'NEEDS_REVIEW', review: { phase: 'prepare', reason: 'FAILED' } });
  expectCode(await f.request(`POST ${f.campaignPath}/review`, { decision: 'SKIP', note: '再作成' }), 400, 'INVALID_REQUEST');
  assert.equal((await f.request(`POST ${f.campaignPath}/review`, { decision: 'SKIP', note: '再作成', resume: false })).json.status, 'QUEUED');
  assert.equal(JSON.parse(f.executions.get(`${ID}-r1`).input).resume, false);
});

test('7.7 全件進捗保存後の異常では空の要確認範囲を安全に完了へ進める', async () => {
  const f = managementFixture();
  f.setCampaign({ status: 'NEEDS_REVIEW', chunks_total: 1, recipients_total: 3, progress: { chunk: 1, index: 0 }, review: { chunk: 1, index_from: 0, index_to: -1, reason: 'WORKER_FAILED' } });
  const detail = await f.request(`GET ${f.campaignPath}`);
  assert.deepEqual(detail.json.review_recipients, []);
  assert.match(detail.json.athena_query, /ht2_events\.ses_events/);
  const result = await f.request(`POST ${f.campaignPath}/review`, { decision: 'SKIP', note: '全件の受付を証跡で確認' });
  assert.equal(result.statusCode, 200, result.body); assert.deepEqual(result.json.progress, { chunk: 1, index: 0 });
});

test('7.7 管理者の確認用クエリは対象宛先・campaign・日付の条件を含む', async () => {
  const f = managementFixture({ registered: true, count: 25 }); await f.prepare();
  f.setCampaign({ status: 'NEEDS_REVIEW', review: { chunk: 0, index_from: 3, index_to: 5, reason: 'WORKER_FAILED' } });
  const result = await f.request(`GET ${f.campaignPath}`);
  assert.equal(result.json.review_recipients.length, 3);
  assert.match(result.json.athena_query, /element_at\(mail.tags, 'campaign'\)/);
  assert.ok(result.json.review_recipients.every((email) => result.json.athena_query.includes(email)));
  f.role = 'viewer'; f.resetApi(); assert.equal((await f.request(`GET ${f.campaignPath}`)).json.review_recipients, undefined);
});

test('6.3 申請後プレビューはMIMEヘッダーの順序・multipartを処理しtextだけ返す', async () => {
  const f = managementFixture(); f.draft(); await f.request(`POST ${f.campaignPath}/submit`, f.scope());
  f.deps.ses.testRenderEmailTemplate = async () => ({ RenderedTemplate: 'Content-Type: multipart/mixed; boundary="part"\r\n\r\n--part\r\nContent-Type: text/html\r\n\r\n<p>ignored</p>\r\n--part\r\nContent-Transfer-Encoding: base64\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n' + Buffer.from('日本語\n本文').toString('base64') + '\r\n--part--\r\n' });
  const response = await f.request(`POST ${f.campaignPath}/preview`, {});
  assert.equal(response.json.text, '日本語\n本文', response.body); assert.ok(!response.body.includes('ignored'));
});

test('10.5 入力形式が不正ならSESのトピック取得より先に拒否', async () => {
  const f = managementFixture(); let calls = 0;
  f.deps.ses.getContactList = async () => { calls += 1; throw new Error('must not call'); };
  expectCode(await f.request('POST /campaigns', { topic: 'news', subject: '{{bad}}', body_text: '本文' }), 400, 'INVALID_REQUEST');
  assert.equal(calls, 0);
});

test('7.6 SendTaskSuccessの結果不明時も再試行せず、中止用トークンを保持する', async () => {
  const f = managementFixture(); f.setCampaign({ status: 'PAUSED', pause_reason: 'USER', updated_at: new Date(f.deps.now()).toISOString(), task_token: 'private-task' });
  let calls = 0;
  f.deps.sfn.sendTaskSuccess = async () => { calls += 1; throw failure('TimeoutError'); };
  expectCode(await f.request(`POST ${f.campaignPath}/resume`, {}), 500, 'INTERNAL');
  assert.equal(calls, 1); assert.equal(f.getCampaign().task_token, 'private-task');
  assert.equal((await f.request(`POST ${f.campaignPath}/cancel`, {})).json.status, 'CANCELLED');
  assert.equal(f.tokens[0].failure.taskToken, 'private-task');
});

test('T-19 停止済み・未設定トピックの購読は管理者による明示的な再同意が必要', async () => {
  const f = managementFixture();
  const contact = f.contacts[0]; contact.TopicPreferences = [{ TopicName: 'news', SubscriptionStatus: 'OPT_OUT' }];
  expectCode(await f.request('POST /contacts/update', { email: contact.EmailAddress, topics: { news: 'OPT_IN' } }), 409, 'RECONSENT_REQUIRED');
  expectCode(await f.request('POST /contacts/update', { email: contact.EmailAddress, topics: { event: 'OPT_IN' } }), 409, 'RECONSENT_REQUIRED');
  expectCode(await f.request('POST /contacts/update', { email: contact.EmailAddress, topics: { event: 'OPT_IN' }, consent }), 409, 'RECONSENT_REQUIRED');
  assert.equal(f.contacts[0].TopicPreferences[0].SubscriptionStatus, 'OPT_OUT');
  f.contacts[0].UnsubscribeAll = true;
  expectCode(await f.request('POST /contacts/update', { email: contact.EmailAddress, topics: { event: 'OPT_IN' }, consent }), 409, 'RECONSENT_REQUIRED');
});

test('T-47 全停止は名前を消し、再同意だけが全停止を解除し他の停止を保持', async () => {
  const f = managementFixture(); const email = f.addresses[0];
  f.contacts[0].AttributesData = JSON.stringify({ v: 1, name: '会員名', consent, origin: 'manual:user' });
  f.contacts[0].TopicPreferences.push({ TopicName: 'event', SubscriptionStatus: 'OPT_OUT' });
  assert.equal((await f.request('POST /contacts/unsubscribe', { email, scope: 'ALL' })).statusCode, 200);
  const stopped = await f.request('POST /contacts/get', { email });
  assert.equal(JSON.parse(stopped.json.AttributesData).name, undefined); assert.equal(stopped.json.UnsubscribeAll, true);
  const body = { email, topics: ['news'], reconsent: { at: '2026-11-01T00:00:00Z', source: '本人の再申込' }, note: '本人の依頼を照合' };
  assert.equal((await f.request('POST /contacts/reconsent', body)).statusCode, 200);
  assert.equal(f.contacts[0].UnsubscribeAll, false); assert.equal(f.contacts[0].TopicPreferences.find((item) => item.TopicName === 'event').SubscriptionStatus, 'OPT_OUT');
  assert.equal(JSON.parse(f.contacts[0].AttributesData).reconsent.by, 'user');
  assert.ok(audits(f).some((item) => item.action === 'RECONSENT' && item.addr_id));
});

test('T-17 完全削除はHMACを保持し、Gmail別表記でも再登録を拒否', async () => {
  const f = managementFixture({ env: 'prod' });
  assert.equal((await f.request('POST /contacts/erase', { email: 'T.a+fc@googlemail.com', note: '本人からの削除請求' })).statusCode, 200);
  const hash = eraseHash('ta@gmail.com');
  assert.ok(f.ddb.get('ERASED', hash));
  expectCode(await f.request('POST /contacts', { ...newContact, email: 't.a@gmail.com' }), 409, 'ERASED_ADDRESS');
  assert.equal(f.changes.filter((change) => change.EmailAddress === 'ta@gmail.com').length, 1);
  assert.ok(!JSON.stringify(audits(f)).includes('ta@gmail.com'));
});

test('API-06 既存宛先の登録は購読を変更せずCONTACT_EXISTS', async () => {
  const f = managementFixture();
  expectCode(await f.request('POST /contacts', { ...newContact, email: f.addresses[0] }), 409, 'CONTACT_EXISTS');
  assert.equal(f.changes.length, 0);
});

test('API-06 新規宛先は正規化・同意属性を保管し、監査にアドレスを残さない', async () => {
  const f = managementFixture({ env: 'prod' });
  const response = await f.request('POST /contacts', { ...newContact, email: 'T.a+fc@googlemail.com', name: '会員名' });
  assert.equal(response.statusCode, 201, response.body); assert.match(response.json.email_masked, /\*\*\*/);
  const input = f.changes[0]; assert.equal(input.EmailAddress, 'ta@gmail.com'); assert.equal(input.UnsubscribeAll, false);
  const attrs = JSON.parse(input.AttributesData);
  assert.equal(attrs.orig, 'T.a+fc@googlemail.com'); assert.equal(attrs.origin, 'manual:user'); assert.deepEqual(attrs.consent, consent);
  const audit = audits(f).find((item) => item.action === 'CONTACT_CREATE');
  assert.ok(audit.addr_id); assert.equal(audit.details.attributes.name, '会員名'); assert.ok(!JSON.stringify(audit).includes('@'));
});

test('5.5 再同意の古い証跡を拒否し、全停止解除は指定外の以前の購読を復活させない', async () => {
  const f = managementFixture();
  f.contacts[0].UnsubscribeAll = true;
  f.contacts[0].AttributesData = JSON.stringify({ v: 1, consent });
  f.contacts[0].TopicPreferences.push({ TopicName: 'event', SubscriptionStatus: 'OPT_IN' });
  const body = { email: f.addresses[0], topics: ['news'], reconsent: { at: consent.at, source: '古い記録' }, note: '再開申請' };
  expectCode(await f.request('POST /contacts/reconsent', body), 400, 'INVALID_REQUEST');
  const response = await f.request('POST /contacts/reconsent', { ...body, reconsent: { at: '2026-11-01T00:00:00Z', source: '本人の新しい申込' } });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(f.contacts[0].TopicPreferences.find((item) => item.TopicName === 'event').SubscriptionStatus, 'OPT_OUT');
});

test('T-20 未登録・停止中のテスト先は送信も連絡先作成もしない', async () => {
  const f = managementFixture(); f.draft(); f.contacts.shift();
  expectCode(await f.request(`POST ${f.campaignPath}/test-send`, {}), 422, 'TEST_RECIPIENT_NOT_REGISTERED');
  assert.equal(f.sends.length, 0); assert.equal(f.changes.length, 0);
});

test('T-21 許可リスト外の個別登録とテスト送信を拒否', async () => {
  const f = managementFixture(); f.draft();
  expectCode(await f.request('POST /contacts', newContact), 422, 'RECIPIENT_NOT_ALLOWED_IN_ENV');
  f.settings.nonprod_allowlist = [];
  expectCode(await f.request(`POST ${f.campaignPath}/test-send`, {}), 422, 'RECIPIENT_NOT_ALLOWED_IN_ENV');
  assert.equal(f.sends.length, 0); assert.equal(f.changes.length, 0);
});

test('6.6 APIのテストはSimple/Template、共有ロック・日次予約・UNKNOWN非再送', async () => {
  const f = managementFixture({ registered: true, count: 2 }); f.draft();
  let response = await f.request(`POST ${f.campaignPath}/test-send`, {});
  assert.equal(response.statusCode, 200, response.body); assert.ok(response.json.results.every((item) => item.status === 'ACCEPTED'));
  assert.equal(f.sends[0].input.Content.Simple.Subject.Charset, 'UTF-8');
  assert.equal(f.sends[0].input.EmailTags[0].Value, 'test'); assert.equal(f.ddb.get('DAILY', '2026-11-03').reserved_attempts, 2);
  f.onSend = () => { throw failure('TimeoutError'); };
  response = await f.request(`POST ${f.campaignPath}/test-send`, {});
  assert.equal(response.json.results[0].status, 'UNKNOWN');
  const count = f.sends.length; f.onSend = undefined;
  response = await f.request(`POST ${f.campaignPath}/test-send`, {});
  assert.equal(response.json.results[0].code, 'PRIOR_UNKNOWN'); assert.equal(f.sends.length, count + 1);
  assert.equal(f.ddb.get('LOCK', 'SEND').owner, undefined);
});

test('6.6 残時間15秒未満・他配信中のテストは開始しない', async () => {
  const f = managementFixture(); f.draft(); f.setRemaining(14000);
  const response = await f.request(`POST ${f.campaignPath}/test-send`, {});
  assert.ok(response.json.results.every((item) => item.status === 'NOT_ATTEMPTED'), response.body); assert.equal(f.sends.length, 0);
  f.ddb.set({ PK: 'LOCK', SK: 'SEND', owner: 'other', expires_at_ms: f.deps.now() + 100000 });
  expectCode(await f.request(`POST ${f.campaignPath}/test-send`, {}), 409, 'SENDING_IN_PROGRESS');
});

test('T-23 テンプレート構文と未定義項目・URLのアドレスを拒否', async () => {
  const f = managementFixture();
  expectCode(await f.request('POST /campaigns', { topic: 'news', subject: '{{bad}}', body_text: '本文' }), 400, 'INVALID_REQUEST');
  expectCode(await f.request('POST /contacts', { ...newContact, 'secret@example.com': 'token' }), 400, 'INVALID_REQUEST');
  const response = await f.request('GET /contacts', undefined, { rawQueryString: 'email=private%40example.com' });
  expectCode(response, 400, 'INVALID_REQUEST'); assert.ok(!response.body.includes('private@example.com'));
});

test('9.3 閲覧者には一覧・詳細・結果のアドレスとorigを返さない', async () => {
  const f = managementFixture({ role: 'viewer' });
  f.contacts[0].AttributesData = JSON.stringify({ orig: f.addresses[0] });
  const list = await f.request('GET /contacts');
  assert.match(list.json.items[0].EmailAddress, /\*\*\*/); assert.equal(list.json.items[0].AttributesData, undefined);
  const one = await f.request('POST /contacts/get', { email: f.addresses[0] });
  assert.match(one.json.EmailAddress, /\*\*\*/); assert.equal(one.json.AttributesData, undefined);
  f.setCampaign({ result_keys: [`results/${ID}/00000-000.jsonl`], task_token: 'private-task' });
  f.files.set(`results/${ID}/00000-000.jsonl`, JSON.stringify({ a: addressHash(f.addresses[0], '7'.repeat(64)), m: 'm***0@example.com', ci: 0, ix: 0, r: 'UNKNOWN', c: 'TimeoutError', t: '2026-11-03T10:00:00Z' }) + '\n');
  assert.match((await f.request(`GET ${f.campaignPath}/failures`)).json.items[0].m, /\*\*\*/);
  assert.equal((await f.request(`GET ${f.campaignPath}`)).json.task_token, undefined);
  assert.equal((await f.request('GET /campaigns')).json.items[0].task_token, undefined);
});

test('8.1 結果は全8指標・Sum・粒度切替・60秒キャッシュ、欠測はnull', async () => {
  const f = managementFixture(); f.setCampaign({ status: 'COMPLETED', started_at: new Date(f.deps.now() - 20 * 86400000).toISOString(), counts: { accepted: 12 } });
  let calls = 0;
  f.deps.cloudwatch.getMetricData = async (input) => { calls += 1; assert.equal(input.MetricDataQueries.length, 8); assert.ok(input.MetricDataQueries.every((query) => query.MetricStat.Period === 86400 && query.MetricStat.Stat === 'Sum')); return { MetricDataResults: input.MetricDataQueries.map(({ Id }) => ({ Id, StatusCode: 'Complete', Values: Id === 'm0' ? [5, 7] : [] })) }; };
  assert.equal((await f.request(`GET ${f.campaignPath}/stats`)).json.metrics.Send, 12);
  assert.equal((await f.request(`GET ${f.campaignPath}/stats`)).json.metrics.Complaint, null); assert.equal(calls, 1);
  f.advance(60000); await f.request(`GET ${f.campaignPath}/stats`); assert.equal(calls, 2);
});

test('8.2 S3保存後の進捗更新に失敗してもAPIは失敗・不明の証跡を取得できる', async () => {
  const f = managementFixture({ registered: true, count: 1 }); await f.prepare();
  f.onSend = () => { throw failure('TimeoutError'); };
  f.ddb.beforeUpdate = (input) => { if (input.Key.PK.S === 'CAMPAIGN' && Object.values(input.ExpressionAttributeNames).includes('progress')) throw failure('TimeoutError'); };
  await assert.rejects(f.send(), { code: 'INTERNAL' });
  assert.equal(f.getCampaign().progress.index, 0);
  const response = await f.request(`GET ${f.campaignPath}/failures`);
  assert.equal(response.json.items.length, 1, response.body); assert.equal(response.json.items[0].r, 'UNKNOWN');
});

test('API-02 組織設定はversion・認証・登録済みテスト先を検査し承認不要を監査', async () => {
  const f = managementFixture();
  const body = { version: 0, from_local: 'info', from_name: '会報', legal: f.org.legal, approval_required: false, test_recipients: [f.addresses[0]], max_rate_per_sec: 5 };
  const response = await f.request('PUT /settings', body);
  assert.equal(response.json.version, 1, response.body); assert.ok(audits(f).some((item) => item.action === 'APPROVAL_DISABLED'));
  expectCode(await f.request('PUT /settings', body), 409, 'VERSION_CONFLICT');
  expectCode(await f.request('PUT /settings', { ...body, version: 1, test_recipients: ['missing@example.com'] }), 422, 'TEST_RECIPIENT_NOT_REGISTERED');
});

test('T-51 旧API-26の手入力ハッシュとAPI-02による受入記録の偽装を拒否', async () => {
  const f = managementFixture({ env: 'prod' });
  const body = { passed: true, note: '実受信と監視経路を確認', evidence_key: f.delivery.evidence_key, cases: Object.fromEntries(DELIVERY_CASES.map((id) => [id, 'PASS'])), config_hash: f.configHash, dns_config_hash: f.auth.dns_config_hash };
  expectCode(await f.request('POST /settings/delivery-check', body), 400, 'INVALID_REQUEST');
  const orgBody = { version: 0, from_local: 'info', from_name: '会報', legal: f.org.legal, delivery_check: { status: 'PASS' } };
  expectCode(await f.request('PUT /settings', orgBody), 400, 'INVALID_REQUEST');
  const check = (await f.request('POST /settings/delivery-check', {})).json;
  assert.equal((await f.request(`PUT /settings/delivery-check/${check.check_id}/cases/T-25`, { result: 'FAIL', note: '不合格' })).statusCode, 200);
  assert.equal((await f.request(`POST /settings/delivery-check/${check.check_id}/submit`, { note: '一般配信を止める' })).json.delivery_check.status, 'FAIL');
  f.setCampaign({ status: 'APPROVED' }); expectCode(await f.request(`POST ${f.campaignPath}/start`, { mode: 'NOW' }), 422, 'DELIVERY_CHECK_REQUIRED');
});

test('API-03 購読者数と監査ログの月・ページング、未定義危険操作は404', async () => {
  const f = managementFixture(); f.ddb.set({ PK: 'SETTINGS', SK: 'TOPIC_COUNTS', counts: { news: 7 }, counted_at: '2026-11-03T00:00:00Z' });
  assert.equal((await f.request('GET /topics')).json.items[0].subscribers, 7);
  for (const path of ['/templates/update', '/templates/delete', '/contacts/delete-list', '/suppression/delete', '/audit/update']) expectCode(await f.request('POST ' + path, {}), 404, 'NOT_FOUND');
  await f.request('POST /contacts/unsubscribe', { email: f.addresses[0], scope: 'news' });
  const page = await f.request('GET /audit', undefined, { queryStringParameters: { month: '202611', limit: '1' } });
  assert.equal(page.json.items.length, 1); assert.ok(page.json.cursor);
  const next = await f.request('GET /audit', undefined, { queryStringParameters: { month: '202611', limit: '1', cursor: page.json.cursor } });
  assert.notEqual(next.json.items[0].SK, page.json.items[0].SK);
});
