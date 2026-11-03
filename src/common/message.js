import { createFooter } from './footer.js';
import { formatFrom, normalizeEmail } from './email.js';
import { AppError } from './http.js';

export function fixedMessage(org, campaign, senderDomain) {
  if (!org?.from_local || !org.from_name) throw new AppError('SETTINGS_INCOMPLETE', 422, '差出人と法定表示を設定してください。');
  const footer = createFooter(org, campaign.topic_display);
  return { org, from: formatFrom(org.from_name, org.from_local, senderDomain), reply_to: org.reply_to ?? '', footer_text: footer, text: campaign.body_text + footer };
}

export function templateContent(campaign, message) {
  return { Subject: campaign.subject, Text: message.text };
}

export const templateName = (campaign, revision) => `ht2-c-${campaign.campaign_id}-${revision}`;

export function recipientTags(tags, rid) {
  if (!/^[a-f0-9]{64}$/.test(rid)) throw new TypeError('Invalid recipient identifier');
  return [...(tags ?? []).filter((tag) => tag.Name !== 'rid'), { Name: 'rid', Value: rid }];
}

export function buildSendInput(campaign, email, { contactList, configSet, test = false, simple } = {}) {
  if (normalizeEmail(email).email !== email || !contactList || !configSet || !campaign.from || /[\r\n]/.test(campaign.from)) throw new TypeError('Invalid send input');
  return {
    FromEmailAddress: campaign.from, Destination: { ToAddresses: [email] },
    ...(campaign.reply_to ? { ReplyToAddresses: [campaign.reply_to] } : {}),
    Content: simple ? { Simple: { Subject: { Data: simple.subject, Charset: 'UTF-8' }, Body: { Text: { Data: simple.text, Charset: 'UTF-8' } } } } : { Template: { TemplateName: campaign.template_name, TemplateData: '{}' } },
    ListManagementOptions: { ContactListName: contactList, TopicName: campaign.topic },
    ConfigurationSetName: configSet, EmailTags: [{ Name: 'campaign', Value: test ? 'test' : campaign.campaign_id }],
  };
}
