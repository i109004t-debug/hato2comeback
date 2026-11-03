import { AppError } from './http.js';
import { hasTemplateSyntax } from './validate.js';

export const UNSUBSCRIBE_PLACEHOLDER = '{{amazonSESUnsubscribeUrl}}';

export function createFooter(settings, topicDisplay) {
  const legal = settings?.legal;
  const fields = [legal?.sender_name, legal?.address, legal?.contact, topicDisplay];
  if (fields.some((value) => typeof value !== 'string' || !value.trim() || /[\p{Cc}\p{Cs}\p{Zl}\p{Zp}]/u.test(value) || hasTemplateSyntax(value))) throw new AppError('SETTINGS_INCOMPLETE', 422, '法定表示とトピックの設定を確認してください。');
  return `\n----\nこのメールは${legal.sender_name}の「${topicDisplay}」にご登録いただいた方にお送りしています。\n配信停止・配信設定の変更は、次のURLから手続きできます（このメール上部の「登録解除」からも停止できます）。\n${UNSUBSCRIBE_PLACEHOLDER}\n\n発行：${legal.sender_name}\n所在地：${legal.address}\nお問い合わせ：${legal.contact}\n`;
}
