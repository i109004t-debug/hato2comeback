import { sendingConfigHash, DELIVERY_CASES } from './precheck.js';
import { monitoringAlarmNames, assertHealthy } from './monitoring.js';

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

export async function assertAcceptance(runtime, org, input) {
  const config = await runtime.config.get();
  const auth = await runtime.store.get('SETTINGS', 'AUTH_STATUS');
  const age = runtime.now() - Date.parse(auth?.checked_at);
  assertHealthy(auth && auth.config_hash === currentConfigHash(runtime, org), auth ? 'AUTH_CHECK_STALE' : 'AUTH_CHECK_FAILED');
  assertHealthy(auth.status === 'PASS' && auth.domain === runtime.senderDomain && age >= 0 && age <= config.auth_status_max_age_hours * 3600000, 'AUTH_CHECK_FAILED');
  assertHealthy(input.config_hash === auth.config_hash && input.dns_config_hash === auth.dns_config_hash && DELIVERY_CASES.every((id) => input.cases[id] === 'PASS'), 'DELIVERY_CHECK_REQUIRED');
  assertHealthy(/^delivery-checks\/[^/]+\/.+/.test(input.evidence_key) && !input.evidence_key.split('/').includes('..'), 'DELIVERY_CHECK_REQUIRED');
  try { await runtime.s3.headObject({ Bucket: runtime.dataBucket, Key: input.evidence_key }); } catch { assertHealthy(false, 'DELIVERY_CHECK_REQUIRED'); }
}
