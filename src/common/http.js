import { timingSafeEqual } from 'node:crypto';
import { redact } from './log.js';

export const ERROR_STATUS = Object.freeze(Object.fromEntries([
  [400, 'INVALID_REQUEST'], [401, 'UNAUTHENTICATED REAUTH_REQUIRED'],
  [403, 'FORBIDDEN FORBIDDEN_ORIGIN USER_DISABLED NO_ROLE'], [404, 'NOT_FOUND'],
  [409, 'STATE_CONFLICT VERSION_CONFLICT HASH_MISMATCH CONTACT_EXISTS ERASED_ADDRESS RECONSENT_REQUIRED ALREADY_STARTED SENDING_IN_PROGRESS CONTACT_IMPORT_IN_PROGRESS UNSUPPORTED_SCHEMA SELF_CHANGE_FORBIDDEN LAST_ADMIN CHECK_HASH_CHANGED'],
  [413, 'PAYLOAD_TOO_LARGE'],
  [422, 'SETTINGS_INCOMPLETE INVALID_ADDRESS NONSTANDARD_ADDRESS QUOTA_INSUFFICIENT TEST_RECIPIENT_NOT_REGISTERED RECIPIENT_NOT_ALLOWED_IN_ENV DELIVERY_CHECK_REQUIRED IMPORT_REQUIRES_PRODUCTION CONSENT_SOURCE_HAS_ADDRESS OUTSIDE_APPROVED_WINDOW CAPACITY_INSUFFICIENT AUDIENCE_EXCEEDS_APPROVAL TOO_MANY_RECIPIENTS'],
  [503, 'SES_BUSY SES_PAUSED SENDING_DISABLED REPUTATION_ALARM AUTH_CHECK_FAILED AUTH_CHECK_STALE EVENT_DESTINATION_DISABLED EVENT_LOG_STALE MONITORING_UNAVAILABLE SUPPRESSION_MISCONFIGURED CONFIGURATION_INVALID ERASE_CHECK_UNAVAILABLE'],
  [500, 'INTERNAL'],
].flatMap(([status, codes]) => codes.split(' ').map((code) => [code, status]))));

export class AppError extends Error {
  constructor(code, status, message, fieldErrors) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
    if (fieldErrors !== undefined) this.fieldErrors = fieldErrors;
  }
}

export function invalid(field, code = 'INVALID') {
  return new AppError('INVALID_REQUEST', 400, '入力形式を確認してください。', [{ field, code }]);
}

export function jsonResponse(statusCode, body) {
  return { statusCode, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }, body: JSON.stringify(body) };
}

export function errorResponse(error, requestId, logger) {
  const known = error instanceof AppError && ERROR_STATUS[error.code] === error.status;
  if (!known || error.status === 500) logger?.error('Request failed', { err: error });
  return jsonResponse(known ? error.status : 500, {
    error_code: known ? error.code : 'INTERNAL',
    message: known && error.status !== 500 ? redact(error.message) : '処理中にエラーが発生しました。',
    request_id: redact(requestId ?? ''),
    field_errors: known ? redact(error.fieldErrors ?? []) : [],
  });
}

export function header(event, name) {
  return Object.entries(event.headers ?? {}).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
}

export function readBody(event, maxBytes = 2 * 1024 * 1024) {
  if (event.body === undefined || event.body === null) return '';
  if (typeof event.body !== 'string') throw invalid('body', 'TYPE');
  if (event.isBase64Encoded && !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(event.body)) throw invalid('body', 'ENCODING');
  const bytes = Buffer.from(event.body, event.isBase64Encoded ? 'base64' : 'utf8');
  if (bytes.length > maxBytes) throw new AppError('PAYLOAD_TOO_LARGE', 413, '要求本文が大きすぎます。');
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw invalid('body', 'ENCODING');
  }
}

export function parseJsonBody(event) {
  const text = readBody(event);
  if (!text && !header(event, 'content-type')) return {};
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(header(event, 'content-type') ?? '')) throw invalid('content-type', 'CONTENT_TYPE');
  try {
    const body = JSON.parse(text);
    if (!body || Array.isArray(body) || typeof body !== 'object') throw new Error();
    return body;
  } catch {
    throw invalid('body', 'JSON');
  }
}

export function assertOrigin(event, { current, previous } = {}) {
  const value = header(event, 'x-origin-verify');
  const actual = Buffer.from(typeof value === 'string' ? value : '');
  let valid = false;
  for (const candidate of [current, previous]) {
    if (typeof candidate !== 'string' || !candidate) continue;
    const expected = Buffer.from(candidate);
    const equal = actual.length === expected.length && timingSafeEqual(actual, expected);
    valid = equal || valid;
  }
  if (!valid) throw new AppError('FORBIDDEN_ORIGIN', 403, 'アクセスを拒否しました。');
}

export function accessClaims(event, clientId) {
  const claims = event.requestContext?.authorizer?.jwt?.claims;
  if (!clientId || !claims?.sub || claims.token_use !== 'access' || claims.client_id !== clientId) {
    throw new AppError('UNAUTHENTICATED', 401, '再ログインしてください。');
  }
  return { sub: claims.sub, ...(claims.auth_time !== undefined ? { auth_time: claims.auth_time } : {}) };
}

export function assertRequestUrl(event) {
  if (header(event, 'x-forwarded-proto') && header(event, 'x-forwarded-proto') !== 'https') throw invalid('protocol');
  try {
    const path = decodeURIComponent(event.rawPath ?? '');
    const query = new URLSearchParams(event.rawQueryString ?? event.queryStringParameters ?? {});
    if (path.includes('@') || [...query].some(([key, value]) => key.includes('@') || value.includes('@'))) throw new Error();
  } catch {
    throw invalid('url');
  }
}
