import { buildUpdate, createExpressions, decodeCursor, campaignUpdate } from './ddb.js';
import { AppError } from './http.js';
import { assertSupportedSchema } from './schema.js';

export const conflict = (error) => ['STATE_CONFLICT', 'VERSION_CONFLICT'].includes(error.code) || error.name === 'ConditionalCheckFailedException';
export const timestamp = (runtime) => new Date(runtime.now()).toISOString();

export async function updateRecord(runtime, PK, SK, current, set, remove = []) {
  if (['CAMPAIGN', 'IMPORT', 'ACCEPTANCE'].includes(PK)) assertSupportedSchema(current);
  const expressions = createExpressions();
  let ConditionExpression = current ? Number.isSafeInteger(current.version) ? expressions.equals('version', current.version) : `attribute_exists(${expressions.name('PK')}) AND ${expressions.notExists('version')}` : expressions.notExists('PK');
  if (current && ['CAMPAIGN', 'IMPORT', 'ACCEPTANCE'].includes(PK)) ConditionExpression += ` AND ${expressions.equals('schema_version', 1)}`;
  return runtime.store.update(PK, SK, {
    ConditionExpression,
    ...buildUpdate({ set: { ...set, version: (current?.version ?? 0) + 1, updated_at: timestamp(runtime) }, remove }, expressions),
  });
}

export async function updateCampaign(runtime, campaign, statuses, set, remove = []) {
  assertSupportedSchema(campaign);
  if (!statuses.includes(campaign.status)) throw new AppError('STATE_CONFLICT', 409, '配信状態が変更されています。');
  const update = campaignUpdate({ version: campaign.version, from: statuses, set: { ...set, updated_at: timestamp(runtime) } });
  if (remove.length) {
    const names = update.ExpressionAttributeNames;
    update.UpdateExpression += ` REMOVE ${remove.map((field, i) => { names[`#remove${i}`] = field; return `#remove${i}`; }).join(', ')}`;
  }
  return runtime.store.update('CAMPAIGN', campaign.campaign_id, update);
}

export async function listRecords(runtime, PK, { limit = 50, cursor } = {}) {
  const input = { KeyConditionExpression: 'PK = :pk', ExpressionAttributeValues: { ':pk': { S: PK } }, Limit: limit, ScanIndexForward: false };
  if (cursor) input.ExclusiveStartKey = decodeCursor(cursor, PK);
  for await (const page of runtime.store.queryPages(input)) return { items: page.items, cursor: page.cursor };
  return { items: [], cursor: null };
}

export async function* allRecords(runtime, PK) {
  for await (const page of runtime.store.queryPages({ KeyConditionExpression: 'PK = :pk', ExpressionAttributeValues: { ':pk': { S: PK } } })) yield* page.items;
}

export async function objectText(response) {
  const body = response.Body;
  if (typeof body === 'string') return body;
  if (body?.transformToString) return body.transformToString('utf-8');
  if (body instanceof Uint8Array) return new TextDecoder('utf-8', { fatal: true }).decode(body);
  const chunks = [];
  for await (const chunk of body) chunks.push(Buffer.from(chunk));
  return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
}

export async function* contactPages(runtime) {
  let token;
  const seen = new Set();
  do {
    const page = await runtime.ses.listContacts({ ContactListName: runtime.contactList, PageSize: 1000, ...(token ? { NextToken: token } : {}) });
    if (!Array.isArray(page.Contacts)) throw new Error('Invalid contacts response');
    yield page.Contacts;
    token = page.NextToken;
    if (token && seen.has(token)) throw new Error('Repeated contacts cursor');
    if (token) seen.add(token);
  } while (token);
}
