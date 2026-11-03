import { AppError } from '../../common/http.js';
import { updateRecord, timestamp } from '../../common/records.js';
import { assertAcceptance, assertIdentity } from '../../common/acceptance.js';
import { requiresEmailMask } from '../../common/authz.js';
import { maskEmail } from '../../common/email.js';

async function get({ runtime, user }) {
  const org = await runtime.store.get('SETTINGS', 'ORG');
  if (!org) return { version: 0, approval_required: true, test_recipients: [], max_rate_per_sec: 10 };
  const { PK, SK, ...value } = org;
  if (requiresEmailMask(user)) value.test_recipients = (value.test_recipients ?? []).map(maskEmail);
  return value;
}

async function update(ctx) {
  const { runtime, body, user, audit } = ctx;
  const org = await runtime.store.get('SETTINGS', 'ORG');
  if (body.version !== (org?.version ?? 0)) throw new AppError('VERSION_CONFLICT', 409, '設定が変更されています。');
  assertIdentity(await runtime.ses.getEmailIdentity({ EmailIdentity: runtime.senderDomain }), runtime.senderDomain);
  for (const email of body.test_recipients) {
    try { await runtime.ses.getContact({ ContactListName: runtime.contactList, EmailAddress: email }); } catch (error) {
      if (error.name !== 'NotFoundException') throw error;
      throw new AppError('TEST_RECIPIENT_NOT_REGISTERED', 422, 'テスト送信先を連絡先に登録してください。');
    }
  }
  await updateRecord(runtime, 'SETTINGS', 'ORG', org, { ...body, updated_by: user.sub });
  runtime.precheck.invalidate();
  if (body.approval_required === false && org?.approval_required !== false) await audit('APPROVAL_DISABLED', 'ORG');
  return get(ctx);
}

async function deliveryCheck(ctx) {
  const { runtime, body, user } = ctx;
  const org = await runtime.store.get('SETTINGS', 'ORG');
  if (!org) throw new AppError('SETTINGS_INCOMPLETE', 422, '組織設定を保存してください。');
  if (body.passed) await assertAcceptance(runtime, org, body);
  const { passed, ...fields } = body;
  const record = { ...fields, status: passed ? 'PASS' : 'FAIL', passed_at: timestamp(runtime), by: user.sub };
  await updateRecord(runtime, 'SETTINGS', 'ORG', org, { delivery_check: record, updated_by: user.sub });
  runtime.precheck.invalidate();
  return { delivery_check: record };
}

export default { 'settings.get': get, 'settings.update': update, 'settings.delivery-check': deliveryCheck };
