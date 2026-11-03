import test from 'node:test';
import assert from 'node:assert/strict';
import { toAttribute, fromAttribute, marshall, unmarshall, createExpressions, buildUpdate, campaignUpdate, key, encodeCursor, decodeCursor, encodeSesCursor, decodeSesCursor, queryPages, createDdb } from '../../src/common/ddb.js';

test('4.3 AttributeValueの往復: 型、入れ子、集合、バイナリ、大きい整数', () => {
  const value = { PK: 'CAMPAIGN', SK: 'id', n: 3.14, zero: 0, negative: -3, huge: 9007199254740993n, nil: null, flag: false, empty: '', list: ['日本語', 1, null, { nested: true }], map: {}, ss: new Set(['a', 'b']), ns: new Set([1, 2]), bs: new Set([Uint8Array.of(1, 2)]), binary: Uint8Array.of(3, 4) };
  assert.deepEqual(unmarshall(marshall(value)), value);
  assert.deepEqual(toAttribute(true), { BOOL: true });
  assert.equal(fromAttribute({ N: '1e-3' }), 0.001);
  const proto = JSON.parse('{"__proto__":{"S":"safe"}}');
  assert.equal(Object.getPrototypeOf(unmarshall(proto)), Object.prototype);
  assert.equal(Object.hasOwn(unmarshall(proto), '__proto__'), true);
});

test('値の変換は未定義・NaN・循環・混合集合・不正AVを拒否', () => {
  const circular = {}; circular.self = circular;
  for (const value of [undefined, Infinity, NaN, 9007199254740992, () => {}, Symbol('x'), new Date(), circular, new Set(), new Set([1, 'a'])]) assert.throws(() => toAttribute(value), TypeError);
  for (const value of [{ S: 1 }, { NULL: false }, { BOOL: 0 }, { S: 'x', N: '1' }, { N: 'no' }, { N: '1e999' }, { SS: [] }, { X: 'a' }]) assert.throws(() => fromAttribute(value), TypeError);
});

test('条件式と更新式は予約語・ドットを持つ属性名を別名化', () => {
  const expression = createExpressions();
  assert.equal(expression.equals('status', 'DRAFT'), '#n0 = :v0');
  assert.equal(expression.notExists(['legal', 'address']), 'attribute_not_exists(#n1.#n2)');
  const update = buildUpdate({ set: { 'x.y': 2 }, remove: ['old'], add: { count: 1 }, delete: { tags: new Set(['a']) } }, expression);
  assert.ok(Object.values(update.ExpressionAttributeNames).includes('x.y'));
  assert.match(update.UpdateExpression, /SET .* ADD .* DELETE .* REMOVE /);
  assert.equal(unmarshall(update.ExpressionAttributeValues)[':v0'], 'DRAFT');
  assert.throws(() => buildUpdate({}), TypeError);
  assert.throws(() => buildUpdate({ set: { PK: 'x' } }), TypeError);
  assert.throws(() => buildUpdate({ set: { x: 1 }, remove: ['x'] }), TypeError);
});

test('6.2 配信更新は状態とversionを条件にして版を1増やす', () => {
  const result = campaignUpdate({ version: 4, from: ['DRAFT', 'PENDING_APPROVAL'], set: { status: 'APPROVED' } });
  assert.match(result.ConditionExpression, / IN .* AND .* = /);
  assert.ok(Object.values(unmarshall(result.ExpressionAttributeValues)).includes(5));
  assert.throws(() => campaignUpdate({ version: -1, from: ['DRAFT'] }));
  assert.throws(() => campaignUpdate({ version: 1, from: [] }));
});

test('10.1 DynamoDB/SESカーソルの往復・型・PKの検査', () => {
  const itemKey = key('AUDIT#202611', '2026-11-03T00:00:00Z#id');
  assert.deepEqual(decodeCursor(encodeCursor(itemKey), 'AUDIT#202611'), itemKey);
  assert.equal(encodeCursor({}), null);
  assert.equal(decodeCursor(undefined), undefined);
  assert.equal(decodeSesCursor(encodeSesCursor('ses-token+/=日本語')), 'ses-token+/=日本語');
  assert.throws(() => decodeCursor(encodeCursor(itemKey), 'CAMPAIGN'), { code: 'INVALID_REQUEST' });
  for (const value of ['', '%%%bad', 'not-json', Buffer.from('{"PK":{"N":"1"}}').toString('base64url')]) assert.throws(() => decodeCursor(value), { code: 'INVALID_REQUEST' });
});

test('4.3 空ページでもLastEvaluatedKeyがあれば最後までQueryする', async () => {
  const inputs = [];
  const cursor = key('CAMPAIGN', '1');
  const pages = [{ Items: [], LastEvaluatedKey: cursor }, { Items: [marshall({ PK: 'CAMPAIGN', SK: '2' })] }];
  const output = [];
  for await (const page of queryPages({ query: async (input) => { inputs.push(input); return pages.shift(); } }, { TableName: 'table' })) output.push(page);
  assert.equal(output.length, 2);
  assert.deepEqual(inputs[1].ExclusiveStartKey, cursor);
  assert.equal(output[1].items[0].SK, '2');
});

test('繰り返すカーソルは無限ループにしない', async () => {
  await assert.rejects(async () => {
    for await (const page of queryPages({ query: async () => ({ LastEvaluatedKey: key('CAMPAIGN', 'x') }) }, {})) void page;
  }, /Repeated/);
});

test('DDB補助は条件なし更新・監査更新を拒否し、競合をAppErrorにする', async () => {
  const inputs = [];
  const repository = createDdb({ tableName: 'table', ddb: {
    getItem: async (input) => { inputs.push(input); return { Item: marshall({ PK: 'CAMPAIGN', SK: '1' }) }; },
    putItem: async (input) => { inputs.push(input); },
    updateItem: async () => { throw Object.assign(new Error(), { name: 'ConditionalCheckFailedException' }); },
  } });
  assert.equal((await repository.get('CAMPAIGN', '1')).SK, '1');
  assert.equal(inputs[0].ConsistentRead, true);
  await repository.put({ PK: 'AUDIT#202611', SK: 'entry' });
  assert.equal(inputs[1].ConditionExpression, 'attribute_not_exists(PK)');
  await assert.rejects(repository.update('CAMPAIGN', '1', {}), TypeError);
  await assert.rejects(repository.update('AUDIT#202611', '1', { ConditionExpression: 'x' }), TypeError);
  await assert.rejects(repository.update('CAMPAIGN', '1', { ConditionExpression: 'x' }), { code: 'STATE_CONFLICT' });
  await assert.rejects(repository.update('SETTINGS', 'ORG', { ConditionExpression: 'x' }), { code: 'VERSION_CONFLICT' });
});
