import { AppError, invalid, header, readBody } from './http.js';
import { normalizeEmail } from './email.js';
import { validateConsent, validateName } from './validate.js';

export const CSV_COLUMNS = Object.freeze(['email', 'name', 'consent_at', 'consent_source', 'consent_version', 'topics']);
const required = ['email', 'consent_at', 'consent_source', 'topics'];
const tooLarge = () => new AppError('PAYLOAD_TOO_LARGE', 413, 'CSVは2MiB・20,000データ行以内にしてください。');

export function parseCsv(input) {
  if (typeof input !== 'string' && !(input instanceof Uint8Array)) throw invalid('csv', 'TYPE');
  const bytes = typeof input === 'string' ? Buffer.from(input) : input;
  if (bytes.length > 2 * 1024 * 1024) throw tooLarge();
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw invalid('csv', 'ENCODING'); }
  if (text.startsWith('\uFEFF')) text = text.slice(1);
  const rows = [];
  let row = [];
  let field = '';
  let state = 'start';
  let ended = true;
  const finishField = () => { row.push(field); field = ''; state = 'start'; };
  const finishRow = () => {
    finishField();
    rows.push(row);
    row = [];
    ended = true;
    if (rows.length > 20001) throw tooLarge();
  };
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    ended = false;
    if (state === 'quoted') {
      if (char === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 1; } else { state = 'closed'; }
      } else { field += char; }
      continue;
    }
    if (char === ',') { finishField(); continue; }
    if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] !== '\n') throw invalid('csv', 'NEWLINE');
      if (char === '\r') i += 1;
      finishRow();
      continue;
    }
    if (state === 'closed') throw invalid('csv', 'QUOTING');
    if (char === '"') {
      if (state !== 'start') throw invalid('csv', 'QUOTING');
      state = 'quoted';
    } else { field += char; state = 'plain'; }
  }
  if (state === 'quoted') throw invalid('csv', 'QUOTING');
  if (!ended) finishRow();
  return rows;
}

export function validateCsvHeader(header) {
  if (!Array.isArray(header) || new Set(header).size !== header.length || header.some((column) => !CSV_COLUMNS.includes(column)) || required.some((column) => !header.includes(column))) throw invalid('csv.header', 'COLUMNS');
  return header;
}

export function validateImportRequest(event) {
  if (!/^text\/csv(?:\s*;\s*charset=utf-8)?$/i.test(header(event, 'content-type') ?? '')) throw invalid('content-type', 'CONTENT_TYPE');
  const idempotencyKey = header(event, 'idempotency-key');
  if (typeof idempotencyKey !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(idempotencyKey)) throw invalid('Idempotency-Key');
  const text = readBody(event);
  validateCsvHeader(parseCsv(text)[0]);
  return { text, idempotencyKey };
}

function validateTopics(topics) {
  if (!Array.isArray(topics) || !topics.length || topics.length > 20 || new Set(topics).size !== topics.length || topics.some((value) => !/^[a-z0-9_]{1,20}$/.test(value))) throw invalid('topics');
}

export function validateImportCsv(input, { topics, importId, now = Date.now } = {}) {
  validateTopics(topics);
  if (typeof importId !== 'string' || !importId) throw new TypeError('Import ID is required');
  const parsed = parseCsv(input);
  const header = validateCsvHeader(parsed[0]);
  const rows = [];
  const rejected = [];
  const seen = new Set();
  for (let index = 1; index < parsed.length; index += 1) {
    const line = parsed[index];
    if (line.length !== header.length) throw invalid(`csv.rows[${index + 1}]`, 'COLUMN_COUNT');
    const source = Object.fromEntries(header.map((column, i) => [column, line[i]]));
    try {
      const address = normalizeEmail(source.email);
      const consent = validateConsent({ at: source.consent_at, source: source.consent_source, ...(source.consent_version ? { version: source.consent_version } : {}) }, { now });
      const name = validateName(source.name ?? '');
      const selected = source.topics.split(';');
      validateTopics(selected);
      if (selected.some((value) => !topics.includes(value))) throw invalid('topics', 'UNKNOWN_TOPIC');
      const attributes = { v: 1, ...(name ? { name } : {}), consent, origin: `import:${importId}`, ...(address.orig ? { orig: address.orig } : {}) };
      if (Buffer.byteLength(JSON.stringify(attributes)) > 1024) throw invalid('attributes', 'MAX_BYTES');
      if (seen.has(address.email)) {
        rejected.push({ row: index + 1, code: 'DUPLICATE_IN_FILE' });
        continue;
      }
      seen.add(address.email);
      rows.push({ row: index + 1, email: address.email, topics: selected, attributes });
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      rejected.push({ row: index + 1, code: error.code });
    }
  }
  return { rows, rejected };
}

export function csvCell(value) {
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function writeSesImport(rows, topics) {
  validateTopics(topics);
  const lines = [['emailAddress', 'unsubscribeAll', 'attributesData', ...topics.map((value) => `topicPreferences.${value}`)]];
  for (const row of rows) {
    validateTopics(row.topics);
    if (row.topics.some((value) => !topics.includes(value))) throw invalid('topics', 'UNKNOWN_TOPIC');
    const attributes = JSON.stringify(row.attributes);
    if (!row.attributes || Buffer.byteLength(attributes) > 1024) throw invalid('attributes', 'MAX_BYTES');
    lines.push([normalizeEmail(row.email).email, 'false', attributes, ...topics.map((value) => row.topics.includes(value) ? 'OPT_IN' : 'OPT_OUT')]);
  }
  return `${lines.map((line) => line.map(csvCell).join(',')).join('\n')}\n`;
}
