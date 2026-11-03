import { AppError, invalid } from './http.js';

const atext = /^[a-z0-9!#$%&'*+\/=?^_`{|}~.-]+$/;

export function normalizeEmail(input) {
  const fail = (code = 'INVALID_ADDRESS') => { throw new AppError(code, 422, 'メールアドレスの形式を確認してください。'); };
  if (typeof input !== 'string') fail();
  const original = input.trim();
  const email = original.toLowerCase();
  if (!email || /[^\x21-\x7e]/.test(original) || email.length > 254) fail();
  const parts = email.split('@');
  if (parts.length !== 2) fail();
  let [local, domain] = parts;
  if (!local || local.length > 64 || !atext.test(local)) fail();
  if (local.startsWith('.') || local.endsWith('.') || local.includes('..')) fail('NONSTANDARD_ADDRESS');
  const labels = domain.split('.');
  if (domain.length > 253 || labels.length < 2 || labels.some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) || /^\d+$/.test(labels.at(-1))) fail();
  if (domain === 'gmail.com' || domain === 'googlemail.com') {
    local = local.split('+')[0].replaceAll('.', '');
    if (!local) fail();
    const normalized = `${local}@gmail.com`;
    return { email: normalized, ...(normalized !== original ? { orig: original } : {}) };
  }
  return { email };
}

export function maskEmail(input) {
  const email = normalizeEmail(input).email;
  const [local, domain] = email.split('@');
  return `${local[0]}***${local.length > 1 ? local.at(-1) : ''}@${domain}`;
}

export function encodeRfc2047(text) {
  if (typeof text !== 'string' || /[\p{Cc}\p{Cs}\p{Zl}\p{Zp}]/u.test(text)) throw invalid('header');
  const chunks = [];
  let chunk = '';
  let bytes = 0;
  for (const char of text) {
    const size = Buffer.byteLength(char);
    if (bytes + size > 45) {
      chunks.push(chunk);
      chunk = '';
      bytes = 0;
    }
    chunk += char;
    bytes += size;
  }
  if (chunk) chunks.push(chunk);
  return chunks.map((value) => `=?UTF-8?B?${Buffer.from(value).toString('base64')}?=`).join('\r\n ');
}

export function formatFrom(name, local, domain) {
  if (typeof name !== 'string' || !name.trim() || [...name].length > 64 || /[\p{Cc}\p{Cs}\p{Zl}\p{Zp}<>"]/u.test(name) || name.includes('{{') || name.includes('}}')) throw invalid('from_name');
  const address = `${local}@${domain}`;
  // 差出人の表記を、宛先用のGmail正規化で書き換えない。
  normalizeEmail(address);
  if (address.trim() !== address || address.includes('{{') || address.includes('}}')) throw invalid('from_local');
  const display = /[^\x20-\x7e]/.test(name) ? encodeRfc2047(name) : `"${name.replaceAll('\\', '\\\\')}"`;
  return `${display} <${address}>`;
}
