import { AppError, invalid } from './http.js';
import { normalizeEmail } from './email.js';
import { isUlid } from './ids.js';

export const hasTemplateSyntax = (value) => value.includes('{{') || value.includes('}}');
const controls = /[\p{Cc}\p{Cs}\p{Zl}\p{Zp}]/u;
const count = (value) => [...value].length;
const object = (value) => value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));

export function validateSubject(value) {
  if (typeof value !== 'string' || count(value) < 1 || count(value) > 200 || controls.test(value) || hasTemplateSyntax(value)) throw invalid('subject');
  return value;
}

export function validateBody(value) {
  if (typeof value !== 'string' || /\p{Cs}/u.test(value) || hasTemplateSyntax(value)) throw invalid('body_text');
  const text = value.replace(/\r\n?/g, '\n');
  if (Buffer.byteLength(text) > 50 * 1024) throw new AppError('PAYLOAD_TOO_LARGE', 413, '本文は50KiB以内にしてください。', [{ field: 'body_text', code: 'MAX_BYTES' }]);
  return text;
}

export function bodyWarnings(value) {
  return /https?:\/\/(?:bit\.ly|t\.co|tinyurl\.com|goo\.gl|is\.gd|ow\.ly)(?:[/?#]|$)/i.test(value) ? ['SHORT_URL'] : [];
}

export function isIsoDateTime(value) {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) return false;
  const [, year, month, day, hour, minute, second, zone] = match;
  const days = new Date(Date.UTC(Number(year), Number(month), 0)).getUTCDate();
  if (+month < 1 || +month > 12 || +day < 1 || +day > days || +hour > 23 || +minute > 59 || +second > 59) return false;
  if (zone !== 'Z' && (+zone.slice(1, 3) > 23 || +zone.slice(4) > 59)) return false;
  return Number.isFinite(Date.parse(value));
}

const string = (min = 0, max = Infinity, options = {}) => ({ type: 'string', min, max, ...options });
const record = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required });
const array = (items, min = 0, max = Infinity) => ({ type: 'array', items, min, max });
const enumeration = (...values) => ({ enum: values });
const number = (min, max = Infinity, integer = false) => ({ type: 'number', min, max, integer });
const boolean = { type: 'boolean' };
const version = number(0, Number.MAX_SAFE_INTEGER - 1, true);
const safeText = (min, max) => string(min, max, { safe: true });
const plainText = (min, max) => string(min, max, { noControls: true });
const email = { normalize: (value) => normalizeEmail(value).email };
const topic = string(1, 20, { pattern: /^[a-z0-9_]+$/, topic: true });
const topics = array(topic, 1, 20);
const timestamp = { normalize: (value, context) => {
  if (!isIsoDateTime(value) || Date.parse(value) > (context.now ?? Date.now)()) throw invalid('at', 'DATETIME');
  return value;
} };
const consent = record({ at: timestamp, source: plainText(1, 100), version: plainText(0, 30) }, ['at', 'source']);
const reconsent = record({ at: timestamp, source: plainText(1, 100) });
const note = plainText(1, 1000);
const hash = string(64, 64, { pattern: /^[a-f0-9]{64}$/ });
const evidence = string(1, 1024, { pattern: /^delivery-checks\/[A-Za-z0-9/_\-.]+$/, check: (value) => !value.split('/').includes('..') });
const legalContact = { ...safeText(1, Infinity), check: (value) => {
  if (value.includes('@')) {
    try { normalizeEmail(value); return true; } catch { return false; }
  }
  try {
    const url = new URL(value);
    if (['https:', 'http:'].includes(url.protocol) && url.hostname && !url.username && !url.password) return true;
  } catch { /* 電話番号として検査する。 */ }
  return /^[+()\d -]+$/.test(value) && value.replace(/\D/g, '').length >= 6;
} };
const legal = record({ sender_name: safeText(1, Infinity), address: safeText(1, Infinity), contact: legalContact });
const settings = record({
  version,
  from_local: { normalize: (value, context) => {
    if (typeof value !== 'string' || !/^[a-z0-9!#$%&'*+\/=?^_`{|}~.-]+$/i.test(value) || hasTemplateSyntax(value)) throw invalid('from_local');
    normalizeEmail(`${value}@${context.senderDomain ?? 'example.com'}`);
    return value.toLowerCase();
  } },
  from_name: string(1, 64, { safe: true, pattern: /^[^<>"]+$/u }),
  reply_to: { normalize: (value) => {
    if (typeof value !== 'string' || controls.test(value) || hasTemplateSyntax(value)) throw invalid('reply_to');
    return value === '' ? '' : normalizeEmail(value).email;
  } },
  legal,
  approval_required: boolean,
  test_recipients: array(email, 0, 5),
  max_rate_per_sec: number(1),
}, ['version', 'from_local', 'from_name', 'legal']);
const draft = { topic, subject: { normalize: validateSubject }, body_text: { normalize: validateBody } };
const empty = record({});

export const routeSchemas = Object.freeze({
  'me.get': empty,
  'settings.get': empty,
  'settings.update': settings,
  'topics.list': empty,
  'contacts.list': empty,
  'contacts.get': record({ email }),
  'contacts.create': record({ email, name: plainText(0, 50), consent, topics }, ['email', 'consent', 'topics']),
  'contacts.update': record({ email, name: plainText(0, 50), consent, topics: { type: 'map', key: topic, values: enumeration('OPT_IN', 'OPT_OUT'), min: 1, max: 20 } }, ['email']),
  'contacts.unsubscribe': record({ email, scope: { normalize: (value, context) => value === 'ALL' ? value : validateSchema(topic, value, context).value, check: (value) => typeof value === 'string' && /^(ALL|[a-z0-9_]{1,20})$/.test(value) } }),
  'contacts.reconsent': record({ email, topics, reconsent, note }),
  'contacts.erase': record({ email, note }),
  'imports.create': string(1, Infinity),
  'imports.list': empty,
  'imports.get': empty,
  'campaigns.list': empty,
  'campaigns.create': record(draft),
  'campaigns.get': empty,
  'campaigns.update': record({ version, ...draft }, ['version']),
  'campaigns.preview': empty,
  'campaigns.test-send': record({ purpose: enumeration('ACCEPTANCE_RECOVERY'), note }, []),
  'campaigns.submit': empty,
  'campaigns.approve': record({ content_sha256: hash }),
  'campaigns.reject': record({ reason: note }),
  'campaigns.start': record({ mode: enumeration('NOW', 'SCHEDULED'), at: string(1, 40) }, ['mode']),
  'campaigns.unschedule': empty,
  'campaigns.pause': empty,
  'campaigns.resume': record({ note, evidence_key: evidence }, []),
  'campaigns.cancel': record({ reason: note }, []),
  'campaigns.review': record({ decision: enumeration('SKIP', 'RESEND', 'CANCEL'), note, resume: boolean }, ['decision', 'note']),
  'campaigns.stats': empty,
  'campaigns.failures': empty,
  'audit.list': empty,
  'settings.delivery-check': record({ passed: boolean, note, evidence_key: evidence, cases: { type: 'map', key: string(4, 4, { pattern: /^T-\d{2}$/ }), values: enumeration('PASS', 'FAIL'), min: 1 }, config_hash: hash, dns_config_hash: hash }),
});

export function validateSchema(schema, input, context = {}) {
  const errors = [];
  const visit = (rule, value, path) => {
    const fail = (code = 'INVALID') => { errors.push({ field: path || 'body', code }); return undefined; };
    if (rule.enum && !rule.enum.includes(value)) return fail('ENUM');
    if (rule.normalize) {
      try { value = rule.normalize(value, context); } catch (error) {
        if (!(error instanceof AppError)) throw error;
        return fail(error.fieldErrors?.[0]?.code ?? error.code);
      }
    }
    if (rule.type === 'object' || rule.type === 'map') {
      if (!object(value)) return fail('TYPE');
      const entries = Object.entries(value);
      if (rule.type === 'object') {
        for (const field of rule.required ?? []) if (!Object.hasOwn(value, field)) errors.push({ field: path ? `${path}.${field}` : field, code: 'REQUIRED' });
        return Object.fromEntries(entries.flatMap(([field, item]) => {
          if (!Object.hasOwn(rule.properties, field)) { errors.push({ field: path ? `${path}.$unknown` : '$unknown', code: 'UNKNOWN_FIELD' }); return []; }
          return [[field, visit(rule.properties[field], item, path ? `${path}.${field}` : field)]];
        }));
      }
      if (entries.length < (rule.min ?? 0) || entries.length > (rule.max ?? Infinity)) return fail('LENGTH');
      return Object.fromEntries(entries.map(([field, item], index) => {
        visit(rule.key, field, `${path}.key[${index}]`);
        return [field, visit(rule.values, item, `${path}[${index}]`)];
      }));
    }
    if (rule.type === 'array') {
      if (!Array.isArray(value)) return fail('TYPE');
      if (value.length < rule.min || value.length > rule.max) return fail('LENGTH');
      const result = value.map((item, index) => visit(rule.items, item, `${path}[${index}]`));
      if (new Set(result).size !== result.length) return fail('DUPLICATE');
      return result;
    }
    if (rule.type && typeof value !== rule.type) return fail('TYPE');
    if (rule.type === 'string') {
      if (count(value) < rule.min || count(value) > rule.max) return fail('LENGTH');
      if (/\p{Cs}/u.test(value) || ((rule.safe || rule.noControls) && controls.test(value)) || (rule.safe && hasTemplateSyntax(value))) return fail('CHARACTERS');
      if (rule.min > 0 && !value.trim()) return fail('EMPTY');
      if (rule.pattern && !rule.pattern.test(value)) return fail('FORMAT');
      if (rule.topic && context.topics && !context.topics.includes(value)) return fail('UNKNOWN_TOPIC');
    }
    if (rule.type === 'number' && (!Number.isFinite(value) || value < rule.min || value > rule.max || (rule.integer && !Number.isSafeInteger(value)))) return fail('RANGE');
    if (rule.check && !rule.check(value, context)) return fail();
    return value;
  };
  const value = visit(schema, input, '');
  return { value, field_errors: errors };
}

function assertResult(result) {
  if (result.field_errors.length) {
    const code = result.field_errors[0].code;
    if (['INVALID_ADDRESS', 'NONSTANDARD_ADDRESS'].includes(code)) throw new AppError(code, 422, 'メールアドレスの形式を確認してください。', result.field_errors);
    if (code === 'MAX_BYTES') throw new AppError('PAYLOAD_TOO_LARGE', 413, '本文が大きすぎます。', result.field_errors);
    throw new AppError('INVALID_REQUEST', 400, '入力形式を確認してください。', result.field_errors);
  }
  return result.value;
}

export function validateConsent(value, context) {
  return assertResult(validateSchema(consent, value, context));
}

export function validateName(value) {
  return assertResult(validateSchema(plainText(0, 50), value));
}

export function validateSettings(input, context = {}) {
  const value = assertResult(validateSchema(settings, input, context));
  return { approval_required: true, max_rate_per_sec: 10, test_recipients: [], ...value };
}

export function validateRoute(route, input, context = {}) {
  if (!Object.hasOwn(routeSchemas, route)) throw new AppError('NOT_FOUND', 404, '対象がありません。');
  if (route === 'settings.update') return validateSettings(input, context);
  const value = assertResult(validateSchema(routeSchemas[route], input, context));
  if (route === 'contacts.create') Object.assign(value, normalizeEmail(input.email));
  if (route === 'campaigns.test-send' && (Object.hasOwn(value, 'purpose') !== Object.hasOwn(value, 'note'))) throw invalid('note', 'REQUIRED');
  if (route === 'imports.create' && Buffer.byteLength(value) > 2 * 1024 * 1024) throw new AppError('PAYLOAD_TOO_LARGE', 413, 'CSVが大きすぎます。');
  if (route === 'contacts.update' && !Object.hasOwn(value, 'name') && !Object.hasOwn(value, 'topics')) throw invalid('body', 'EMPTY_UPDATE');
  if (route === 'campaigns.update' && !Object.keys(draft).some((field) => Object.hasOwn(value, field))) throw invalid('body', 'EMPTY_UPDATE');
  if (route === 'campaigns.start') {
    const current = (context.now ?? Date.now)();
    const time = Date.parse(value.at);
    if (value.mode === 'NOW' ? Object.hasOwn(value, 'at') : !isIsoDateTime(value.at) || time < current + 300000 || time > current + 90 * 86400000) throw invalid('at', 'SCHEDULE');
  }
  return value;
}

export function validateParams(params) {
  for (const value of Object.values(params)) if (!isUlid(value)) throw invalid('id', 'ULID');
  return params;
}

export function validateQuery(route, query = {}) {
  const list = ['contacts.list', 'imports.list', 'campaigns.list', 'campaigns.failures', 'audit.list'];
  const properties = list.includes(route) ? { limit: string(1, 2, { pattern: /^(?:[1-9]|[1-4]\d|50)$/ }), cursor: string(1, 16384, { pattern: /^[A-Za-z0-9_-]+$/ }) } : {};
  if (route === 'contacts.list') Object.assign(properties, { topic, status: enumeration('OPT_IN', 'OPT_OUT') });
  if (route === 'audit.list') properties.month = string(6, 6, { pattern: /^\d{4}(?:0[1-9]|1[0-2])$/ });
  const value = assertResult(validateSchema(record(properties, route === 'audit.list' ? ['month'] : []), query));
  if (list.includes(route)) value.limit = value.limit ? Number(value.limit) : 50;
  return value;
}
