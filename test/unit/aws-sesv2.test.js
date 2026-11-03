import test from 'node:test';
import assert from 'node:assert/strict';
import { createAwsAdapters, AWS_APIS } from '../../src/common/aws.js';
import { createSesv2 } from '../../src/common/sesv2.js';
import { marshall, unmarshall } from '../../src/common/ddb.js';

test('12.6 AWSアダプターはSDKを遅延読込し、許可するAPIだけを公開', async () => {
  const loaded = [];
  const sent = [];
  const configs = [];
  const load = async (name) => {
    loaded.push(name);
    const definition = Object.values(AWS_APIS).find((entry) => entry.package === name);
    const sdk = { [definition.client]: class {
      constructor(config) { configs.push({ name, config }); }
      async send(command, options) { sent.push({ name, command, options }); return { ok: true }; }
    } };
    for (const operation of definition.operations) sdk[`${operation}Command`] = class { constructor(input) { this.operation = operation; this.input = input; } };
    return sdk;
  };
  const adapters = createAwsAdapters({ region: 'ap-northeast-1', load, timeoutSignal: (ms) => ({ timeout: ms }) });
  assert.equal(loaded.length, 0);
  const expectedMethods = {
    kms: 'generateMac describeKey',
    ses: 'getAccount getEmailIdentity getConfigurationSet getConfigurationSetEventDestinations getContactList listContacts getContact createContact updateContact deleteContact getSuppressedDestination createImportJob getImportJob createEmailTemplate getEmailTemplate testRenderEmailTemplate deleteEmailTemplate sendEmail',
    ddb: 'getItem putItem updateItem deleteItem query transactWriteItems batchGetItem',
    s3: 'putObject getObject headObject',
    sfn: 'startExecution describeExecution sendTaskSuccess sendTaskFailure',
    scheduler: 'createSchedule deleteSchedule getSchedule',
    cognito: 'adminGetUser adminListGroupsForUser',
    cloudwatch: 'getMetricData describeAlarms',
    sns: 'publish', ssm: 'getParameter', secrets: 'getSecretValue', lambda: 'invoke',
  };
  assert.deepEqual(Object.keys(adapters).sort(), Object.keys(expectedMethods).sort());
  for (const [name, methods] of Object.entries(expectedMethods)) assert.deepEqual(Object.keys(adapters[name]).sort(), methods.split(' ').sort());
  for (const [service, definition] of Object.entries(AWS_APIS)) {
    for (const operation of definition.operations) {
      const method = operation[0].toLowerCase() + operation.slice(1);
      const input = service === 'ddb' && ['PutItem', 'UpdateItem', 'DeleteItem'].includes(operation) ? { ConditionExpression: 'attribute_not_exists(PK)' } : {};
      assert.deepEqual(await adapters[service][method](input), { ok: true });
      assert.equal(sent.at(-1).command.operation, operation);
      assert.equal(sent.at(-1).command.input, input);
    }
  }
  assert.equal(loaded.length, Object.keys(AWS_APIS).length);
  assert.ok(configs.every(({ config }) => config.maxAttempts === 1));
  const sesConfig = configs.find(({ name }) => name === 'sesv2').config;
  assert.equal(sesConfig.requestHandler.requestTimeout, 10000);
  assert.ok(sent.filter(({ name }) => name === 'sesv2').every(({ options }) => options.abortSignal.timeout === 10000));
  assert.equal(adapters.ses.sendBulkEmail, undefined);
  assert.equal(adapters.ses.updateEmailTemplate, undefined);
  assert.equal(adapters.ses.deleteSuppressedDestination, undefined);
  assert.equal(adapters.s3.headObject instanceof Function, true);
  assert.equal(adapters.sns.publish instanceof Function, true);
});

test('AWSアダプターの同時初期化は1回、条件なしのDDB更新はSDK読込前に拒否', async () => {
  let loads = 0;
  const adapters = createAwsAdapters({ load: async () => {
    loads += 1;
    return { DynamoDBClient: class { async send() { return {}; } }, GetItemCommand: class {} };
  } });
  await assert.rejects(adapters.ddb.updateItem({}), TypeError);
  await assert.rejects(adapters.ddb.transactWriteItems({ TransactItems: [{ Update: {} }] }), TypeError);
  assert.equal(loads, 0);
  await Promise.all([adapters.ddb.getItem({}), adapters.ddb.getItem({})]);
  assert.equal(loads, 1);
});

function fixture({ failures = 0, failName = 'TooManyRequestsException', conflicts = 0, seed } = {}) {
  let time = 100000;
  let record = seed;
  let remaining = failures;
  const calls = [];
  const waits = [];
  const updates = [];
  const busy = [];
  const deps = {
    tableName: 'test', now: () => time,
    sleep: async (ms) => { waits.push(ms); time += ms; },
    metrics: { emit: (name, value) => busy.push({ name, value }) },
    ddb: {
      getItem: async (input) => {
        assert.equal(input.ConsistentRead, true);
        assert.deepEqual(unmarshall(input.Key), { PK: 'RATE', SK: 'SES_CONTROL' });
        return record ? { Item: marshall(record) } : {};
      },
      updateItem: async (input) => {
        updates.push(input);
        const values = unmarshall(input.ExpressionAttributeValues);
        if (conflicts > 0) {
          conflicts -= 1;
          record = { version: (record?.version ?? 0) + 1, next_allowed_at_ms: time + 1100 };
          throw Object.assign(new Error(), { name: 'ConditionalCheckFailedException' });
        }
        const success = !record ? input.ConditionExpression === 'attribute_not_exists(PK)' : values[':old'] === record.version && values[':now'] >= record.next_allowed_at_ms;
        if (!success) throw Object.assign(new Error(), { name: 'ConditionalCheckFailedException' });
        record = { version: values[':version'], next_allowed_at_ms: values[':next'] };
        return {};
      },
    },
    ses: {
      getAccount: async () => {
        calls.push(time);
        if (remaining-- > 0) throw Object.assign(new Error('private@example.com'), { name: failName });
        return { SendingEnabled: true };
      },
      sendEmail: async () => { calls.push(time); throw Object.assign(new Error('timeout'), { name: 'TimeoutError' }); },
    },
  };
  return { deps, calls, waits, updates, busy, getRecord: () => record };
}

test('3.8 SES制御APIは別インスタンスでもDDBの共有枠を1.1秒以上離す', async () => {
  const f = fixture();
  const first = createSesv2(f.deps);
  const second = createSesv2(f.deps);
  await first.getAccount({});
  await second.getAccount({});
  await first.getAccount({});
  assert.deepEqual(f.calls, [100000, 101100, 102200]);
  assert.deepEqual(f.waits, [1100, 1100]);
  assert.equal(f.getRecord().version, 3);
  assert.ok(f.updates.every((input) => input.ConditionExpression));
});

test('3.8 同時の条件更新競合は再読取し、他Lambdaの予約を待つ', async () => {
  const f = fixture({ conflicts: 1 });
  await createSesv2(f.deps).getAccount({});
  assert.equal(f.updates.length, 2);
  assert.deepEqual(f.calls, [101100]);
  assert.deepEqual(f.waits, [1100]);
});

test('3.8 同時に初回枠を要求した2つのLambdaを直列化', async () => {
  const f = fixture();
  await Promise.all([createSesv2(f.deps).getAccount({}), createSesv2(f.deps).getAccount({})]);
  assert.equal(f.calls.length, 2);
  assert.ok(f.calls[1] - f.calls[0] >= 1100);
  assert.equal(f.getRecord().version, 2);
});

test('3.8 429は1・2・4・8・16秒後に共有枠を通り、5回再試行後はSES_BUSY', async () => {
  const f = fixture({ failures: 6 });
  await assert.rejects(createSesv2(f.deps).getAccount({}), { code: 'SES_BUSY', status: 503 });
  assert.equal(f.calls.length, 6);
  assert.equal(f.updates.length, 6);
  assert.ok([1000, 2000, 4000, 8000, 16000].every((ms) => f.waits.includes(ms)));
  assert.ok(f.calls.slice(1).every((time, i) => time - f.calls[i] >= 1100));
  assert.equal(f.busy.length, 6);
});

test('3.8 一時的な制限から復帰し、それ以外の失敗は再試行しない', async () => {
  const recover = fixture({ failures: 2 });
  assert.deepEqual(await createSesv2(recover.deps).getAccount({}), { SendingEnabled: true });
  const failure = fixture({ failures: 1, failName: 'InternalServerErrorException' });
  await assert.rejects(createSesv2(failure.deps).getAccount({}), { name: 'InternalServerErrorException' });
  assert.equal(failure.calls.length, 1);
});

test('第8段階2 制御APIのThrottlingExceptionも待機後に再試行し、上限でSES_BUSY', async () => {
  const recover = fixture({ failures: 2, failName: 'ThrottlingException' });
  assert.deepEqual(await createSesv2(recover.deps).getAccount({}), { SendingEnabled: true });
  assert.equal(recover.calls.length, 3);
  assert.ok(recover.calls[1] - recover.calls[0] >= 1100);
  const exhausted = fixture({ failures: 6, failName: 'ThrottlingException' });
  await assert.rejects(createSesv2(exhausted.deps).getAccount({}), { code: 'SES_BUSY' });
  assert.equal(exhausted.calls.length, 6);
});

test('第8段階2 制御ラッパーはSendEmailのThrottlingExceptionを再試行しない', async () => {
  const f = fixture();
  let attempts = 0;
  f.deps.ses.sendEmail = async () => { attempts += 1; throw Object.assign(new Error(), { name: 'ThrottlingException' }); };
  await assert.rejects(createSesv2(f.deps).sendEmail({}), { name: 'ThrottlingException' });
  assert.equal(attempts, 1);
  assert.equal(f.updates.length, 0);
});

test('7.5 SendEmailは間引き対象外、タイムアウトでも自動再試行しない', async () => {
  const f = fixture();
  await assert.rejects(createSesv2(f.deps).sendEmail({}), { name: 'TimeoutError' });
  assert.equal(f.calls.length, 1);
  assert.equal(f.updates.length, 0);
  assert.equal(f.waits.length, 0);
});

test('不正な共有枠とDDB障害ではSESを呼び出さない', async () => {
  const malformed = fixture({ seed: { version: 'bad', next_allowed_at_ms: 0 } });
  await assert.rejects(createSesv2(malformed.deps).getAccount({}), { code: 'CONFIGURATION_INVALID' });
  assert.equal(malformed.calls.length, 0);
  const f = fixture();
  f.deps.ddb.updateItem = async () => { throw new Error('ddb unavailable'); };
  await assert.rejects(createSesv2(f.deps).getAccount({}), /ddb unavailable/);
  assert.equal(f.calls.length, 0);
});
