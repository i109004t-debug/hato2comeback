import { AppError, invalid } from './http.js';

const plain = (value) => value !== null && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value));

export function toAttribute(value, seen = new WeakSet()) {
  if (value === null) return { NULL: true };
  if (typeof value === 'string') return { S: value };
  if (typeof value === 'boolean') return { BOOL: value };
  if (typeof value === 'bigint') return { N: String(value) };
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) throw new TypeError('Invalid DynamoDB number');
    return { N: String(value) };
  }
  if (value instanceof Uint8Array) return { B: value };
  if (!value || typeof value !== 'object' || seen.has(value)) throw new TypeError('Unsupported DynamoDB value');
  seen.add(value);
  try {
    if (Array.isArray(value)) return { L: value.map((item) => toAttribute(item, seen)) };
    if (value instanceof Set) {
      const values = [...value].map((item) => toAttribute(item, seen));
      const type = Object.keys(values[0] ?? {})[0];
      if (!['S', 'N', 'B'].includes(type) || values.some((item) => Object.keys(item)[0] !== type)) throw new TypeError('Invalid DynamoDB set');
      return { [`${type}S`]: values.map((item) => item[type]) };
    }
    if (plain(value)) return { M: Object.fromEntries(Object.entries(value).map(([key, item]) => [key, toAttribute(item, seen)])) };
    throw new TypeError('Unsupported DynamoDB object');
  } finally {
    seen.delete(value);
  }
}

function fromNumber(value) {
  if (typeof value !== 'string' || !/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value)) throw new TypeError('Invalid DynamoDB number');
  if (/^-?\d+$/.test(value) && !Number.isSafeInteger(Number(value))) return BigInt(value);
  const result = Number(value);
  if (!Number.isFinite(result) || (Number.isInteger(result) && !Number.isSafeInteger(result))) throw new TypeError('DynamoDB number exceeds JS precision');
  return result;
}

export function fromAttribute(value) {
  if (!plain(value) || Object.keys(value).length !== 1) throw new TypeError('Invalid AttributeValue');
  const [type, item] = Object.entries(value)[0];
  if (type === 'S' && typeof item === 'string') return item;
  if (type === 'N') return fromNumber(item);
  if (type === 'BOOL' && typeof item === 'boolean') return item;
  if (type === 'NULL' && item === true) return null;
  if (type === 'B' && item instanceof Uint8Array) return item;
  if (type === 'L' && Array.isArray(item)) return item.map(fromAttribute);
  if (type === 'M' && plain(item)) return unmarshall(item);
  if (['SS', 'NS', 'BS'].includes(type) && Array.isArray(item) && item.length) return new Set(item.map((entry) => fromAttribute({ [type[0]]: entry })));
  throw new TypeError('Invalid AttributeValue');
}

export function marshall(item) {
  if (!plain(item)) throw new TypeError('DynamoDB item must be an object');
  return toAttribute(item).M;
}

export function unmarshall(item) {
  if (!plain(item)) throw new TypeError('Invalid DynamoDB item');
  return Object.fromEntries(Object.entries(item).map(([key, value]) => [key, fromAttribute(value)]));
}

export function createExpressions() {
  const names = {};
  const values = {};
  const aliases = new Map();
  const name = (path) => (Array.isArray(path) ? path : [path]).map((part) => {
    if (typeof part !== 'string' || !part) throw new TypeError('Invalid attribute path');
    if (!aliases.has(part)) {
      const alias = `#n${aliases.size}`;
      aliases.set(part, alias);
      names[alias] = part;
    }
    return aliases.get(part);
  }).join('.');
  const value = (item) => {
    const alias = `:v${Object.keys(values).length}`;
    values[alias] = toAttribute(item);
    return alias;
  };
  return {
    name, value,
    equals: (path, item) => `${name(path)} = ${value(item)}`,
    notExists: (path) => `attribute_not_exists(${name(path)})`,
    in: (path, items) => {
      if (!items.length) throw new TypeError('Empty condition');
      return `${name(path)} IN (${items.map(value).join(', ')})`;
    },
    attributes: () => ({
      ...(Object.keys(names).length ? { ExpressionAttributeNames: { ...names } } : {}),
      ...(Object.keys(values).length ? { ExpressionAttributeValues: { ...values } } : {}),
    }),
  };
}

export function buildUpdate({ set = {}, remove = [], add = {}, delete: del = {} }, expressions = createExpressions()) {
  const paths = [...Object.keys(set), ...remove, ...Object.keys(add), ...Object.keys(del)];
  if (!paths.length || new Set(paths).size !== paths.length || paths.some((path) => ['PK', 'SK'].includes(path))) throw new TypeError('Invalid update fields');
  const clauses = [];
  for (const [operation, fields] of [['SET', set], ['ADD', add], ['DELETE', del]]) {
    const entries = Object.entries(fields).map(([key, item]) => `${expressions.name(key)}${operation === 'SET' ? ' =' : ''} ${expressions.value(item)}`);
    if (entries.length) clauses.push(`${operation} ${entries.join(', ')}`);
  }
  if (remove.length) clauses.push(`REMOVE ${remove.map(expressions.name).join(', ')}`);
  return { UpdateExpression: clauses.join(' '), ...expressions.attributes() };
}

export function campaignUpdate({ version, from, set = {} }) {
  if (!Number.isSafeInteger(version) || version < 0 || !Array.isArray(from) || !from.length || 'version' in set) throw new TypeError('Invalid campaign update');
  const expressions = createExpressions();
  const ConditionExpression = `${expressions.in('status', from)} AND ${expressions.equals('version', version)}`;
  return { ConditionExpression, ...buildUpdate({ set: { ...set, version: version + 1 } }, expressions) };
}

export function key(PK, SK) {
  if (typeof PK !== 'string' || !PK || typeof SK !== 'string' || !SK) throw new TypeError('PK and SK are required');
  return marshall({ PK, SK });
}

function decodeBase64(cursor) {
  if (typeof cursor !== 'string' || !/^[A-Za-z0-9_-]+$/.test(cursor) || cursor.length > 16384) throw invalid('cursor');
  const data = Buffer.from(cursor, 'base64url');
  if (data.toString('base64url') !== cursor) throw invalid('cursor');
  try { return new TextDecoder('utf-8', { fatal: true }).decode(data); } catch { throw invalid('cursor'); }
}

export function encodeCursor(lastKey) {
  if (!lastKey || !Object.keys(lastKey).length) return null;
  const item = unmarshall(lastKey);
  key(item.PK, item.SK);
  if (Object.keys(item).length !== 2) throw new TypeError('Invalid cursor key');
  return Buffer.from(JSON.stringify(lastKey)).toString('base64url');
}

export function decodeCursor(cursor, expectedPK) {
  if (cursor === undefined || cursor === null) return undefined;
  try {
    const value = JSON.parse(decodeBase64(cursor));
    const item = unmarshall(value);
    key(item.PK, item.SK);
    if (Object.keys(item).length !== 2 || (expectedPK && item.PK !== expectedPK)) throw new Error();
    return value;
  } catch { throw invalid('cursor'); }
}

export const encodeSesCursor = (token) => token ? Buffer.from(token).toString('base64url') : null;
export const decodeSesCursor = (cursor) => cursor === undefined || cursor === null ? undefined : decodeBase64(cursor);

export async function* queryPages(ddb, input) {
  let cursor = input.ExclusiveStartKey;
  const seen = new Set();
  do {
    const page = await ddb.query({ ...input, ...(cursor ? { ExclusiveStartKey: cursor } : {}) });
    yield { items: (page.Items ?? []).map(unmarshall), cursor: encodeCursor(page.LastEvaluatedKey) };
    cursor = page.LastEvaluatedKey;
    if (cursor && Object.keys(cursor).length) {
      const encoded = encodeCursor(cursor);
      if (seen.has(encoded)) throw new Error('Repeated DynamoDB cursor');
      seen.add(encoded);
    }
  } while (cursor && Object.keys(cursor).length);
}

export function createDdb({ ddb, tableName }) {
  const writable = (PK, condition) => {
    if (!condition || PK.startsWith('AUDIT#')) throw new TypeError('Conditional non-audit update required');
  };
  return {
    async get(PK, SK) {
      const result = await ddb.getItem({ TableName: tableName, Key: key(PK, SK), ConsistentRead: true });
      return result.Item ? unmarshall(result.Item) : undefined;
    },
    async put(item, condition = 'attribute_not_exists(PK)', attributes = {}) {
      key(item.PK, item.SK);
      if (!condition || (item.PK.startsWith('AUDIT#') && condition !== 'attribute_not_exists(PK)')) throw new TypeError('Immutable audit item required');
      return ddb.putItem({ ...attributes, TableName: tableName, Item: marshall(item), ConditionExpression: condition });
    },
    async update(PK, SK, update) {
      writable(PK, update.ConditionExpression);
      try {
        const result = await ddb.updateItem({ ...update, TableName: tableName, Key: key(PK, SK), ReturnValues: 'ALL_NEW' });
        return result.Attributes ? unmarshall(result.Attributes) : undefined;
      } catch (error) {
        if (error.name === 'ConditionalCheckFailedException') throw new AppError(PK === 'CAMPAIGN' ? 'STATE_CONFLICT' : 'VERSION_CONFLICT', 409, 'データが変更されています。');
        throw error;
      }
    },
    queryPages: (input) => queryPages(ddb, { ...input, TableName: tableName }),
  };
}
