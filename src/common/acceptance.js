import { sendingConfigHash } from './precheck.js';
import { monitoringAlarmNames, assertHealthy } from './monitoring.js';
import { checkDns } from './dns-auth.js';
import { AppError } from './http.js';
import { updateRecord, timestamp, conflict } from './records.js';
import { assertSupportedSchema } from './schema.js';

export function currentConfigHash(runtime, org) {
  return sendingConfigHash({
    env: runtime.env, region: runtime.region, accountId: runtime.accountId, senderDomain: runtime.senderDomain,
    contactList: runtime.contactList, configSet: runtime.configSet, eventStreamArn: runtime.eventStreamArn,
    from_local: org.from_local, from_name: org.from_name, reply_to: org.reply_to ?? null, legal: org.legal,
    monitoringAlarms: runtime.monitoringAlarms ?? monitoringAlarmNames(runtime.env),
  });
}

export function assertIdentity(identity, domain) {
  assertHealthy(identity?.VerifiedForSendingStatus === true && identity.DkimAttributes?.SigningEnabled === true && identity.DkimAttributes.Status === 'SUCCESS' && identity.DkimAttributes.CurrentSigningKeyLength === 'RSA_2048_BIT', 'AUTH_CHECK_FAILED');
  const mail = identity.MailFromAttributes;
  assertHealthy(mail?.MailFromDomain === `bounce.${domain}` && mail.MailFromDomainStatus === 'SUCCESS' && mail.BehaviorOnMxFailure === 'REJECT_MESSAGE', 'AUTH_CHECK_FAILED');
}

export async function acceptanceHashes(runtime, org) {
  const identity = await runtime.ses.getEmailIdentity({ EmailIdentity: runtime.senderDomain });
  assertIdentity(identity, runtime.senderDomain);
  const dns = await checkDns(runtime, identity);
  assertHealthy(dns.status === 'PASS', 'AUTH_CHECK_FAILED');
  return { config_hash: currentConfigHash(runtime, org), dns_config_hash: dns.dns_config_hash, dns_item_hashes: dns.dns_item_hashes };
}

export async function openCheck(runtime, id) {
  const check = assertSupportedSchema(await runtime.store.get('ACCEPTANCE', id));
  if (!check) throw new AppError('NOT_FOUND', 404, '受入検査がありません。');
  if (check.status !== 'OPEN' || check.expires_at <= runtime.now() / 1000) throw new AppError('STATE_CONFLICT', 409, '受入検査の期限か状態を確認してください。');
  return check;
}

export async function saveTestSends(runtime, id, results) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const check = await openCheck(runtime, id);
    try {
      await updateRecord(runtime, 'ACCEPTANCE', id, check, { test_sends: [...check.test_sends, ...results.map((result) => ({ ...result, at: timestamp(runtime) }))] });
      return;
    } catch (error) { if (!conflict(error) || attempt === 4) throw error; }
  }
}

export function deliveryStatus(runtime, record, maxAgeDays = 90) {
  if (!record) return null;
  const expires_at = new Date(Date.parse(record.passed_at) + maxAgeDays * 86400000).toISOString();
  const remaining_days = Math.max(0, Math.ceil((Date.parse(expires_at) - runtime.now()) / 86400000));
  return { ...record, expires_at, remaining_days, invalidation_reason: runtime.now() >= Date.parse(expires_at) ? 'EXPIRED' : record.invalidation_reason ?? null };
}

export async function notifyAcceptanceExpiry(runtime) {
  const org = await runtime.store.get('SETTINGS', 'ORG');
  const delivery = org?.delivery_check;
  if (!delivery) return;
  const config = await runtime.config.get();
  const days = (Date.parse(delivery.passed_at) + config.delivery_check_max_age_days * 86400000 - runtime.now()) / 86400000;
  const stage = days <= 0 ? 'EXPIRED' : [1, 7, 14, 30].find((value) => days <= value);
  if (stage === undefined || delivery.expiry_notified?.includes(String(stage))) return;
  // 先に通知済みを保存する。通知の結果不明時も同じ段階を自動で再通知しない。
  await updateRecord(runtime, 'SETTINGS', 'ORG', org, { delivery_check: { ...delivery, expiry_notified: [...(delivery.expiry_notified ?? []), String(stage)] } });
  await runtime.notify(stage === 'EXPIRED' ? 'DELIVERY_CHECK_EXPIRED' : 'DELIVERY_CHECK_EXPIRING', 'ORG');
}
