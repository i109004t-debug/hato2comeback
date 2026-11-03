import assert from 'node:assert/strict';
import { createDdb, marshall, unmarshall } from '../../src/common/ddb.js';
import { configDefaults } from '../../src/common/config.js';
import { sendingConfigHash, REQUIRED_EVENTS, DELIVERY_CASES } from '../../src/common/precheck.js';
import { monitoringAlarmNames } from '../../src/common/monitoring.js';
import { createHandler } from '../../src/worker/handler.js';

export const ID = '01K9542S00AAAAAAAAAAAAAAAA';
export const ID2 = '01K9542S00BBBBBBBBBBBBBBBB';
export const ARN = 'arn:aws:states:ap-northeast-1:123456789012:execution:postline:test';
export const failure = (name, status, message = name) => Object.assign(new Error(message), { name, ...(status ? { $metadata: { httpStatusCode: status } } : {}) });

function expression(input, item) {
  const names = input.ExpressionAttributeNames ?? {};
  const values = unmarshall(input.ExpressionAttributeValues ?? {});
  const tokens = input.ConditionExpression.match(/attribute_not_exists|attribute_exists|\bIN\b|\bAND\b|\bOR\b|[#:][\w]+|[\w]+|<=|>=|<>|[=<>(),.]/g);
  let i = 0;
  const value = () => {
    const token = tokens[i++];
    if (token.startsWith(':')) return values[token];
    let result = item[names[token] ?? token];
    while (tokens[i] === '.') { i += 1; const part = tokens[i++]; result = result?.[names[part] ?? part]; }
    return result;
  };
  const atom = () => {
    if (tokens[i] === '(') { i += 1; const result = or(); assert.equal(tokens[i++], ')'); return result; }
    if (['attribute_not_exists', 'attribute_exists'].includes(tokens[i])) {
      const fn = tokens[i++]; assert.equal(tokens[i++], '('); const result = value(); assert.equal(tokens[i++], ')');
      return fn === 'attribute_exists' ? result !== undefined : result === undefined;
    }
    const left = value();
    const operation = tokens[i++];
    if (operation === 'IN') {
      assert.equal(tokens[i++], '('); const values = [value()];
      while (tokens[i] === ',') { i += 1; values.push(value()); }
      assert.equal(tokens[i++], ')'); return values.includes(left);
    }
    const right = value();
    return ({ '=': () => left === right, '<>': () => left !== right, '<': () => left < right, '>': () => left > right, '<=': () => left <= right, '>=': () => left >= right })[operation]();
  };
  const and = () => { let result = atom(); while (tokens[i] === 'AND') { i += 1; const next = atom(); result = result && next; } return result; };
  const or = () => { let result = and(); while (tokens[i] === 'OR') { i += 1; const next = and(); result = result || next; } return result; };
  const result = or();
  assert.equal(i, tokens.length, input.ConditionExpression);
  return result;
}

export function memoryDdb() {
  const items = new Map();
  const calls = [];
  const name = (key) => `${key.PK}/${key.SK}`;
  const api = {
    items, calls, beforeUpdate: undefined, afterUpdate: undefined,
    set(item) { items.set(name(item), structuredClone(item)); },
    get(PK, SK) { return structuredClone(items.get(`${PK}/${SK}`)); },
    async getItem(input) {
      assert.equal(input.ConsistentRead, true);
      const item = items.get(name(unmarshall(input.Key)));
      return item ? { Item: marshall(structuredClone(item)) } : {};
    },
    async putItem(input) {
      const item = unmarshall(input.Item);
      assert.ok(input.ConditionExpression);
      if (!expression(input, items.get(name(item)) ?? {})) throw failure('ConditionalCheckFailedException', 400);
      api.set(item); calls.push(structuredClone(input)); return {};
    },
    async updateItem(input) {
      await api.beforeUpdate?.(input);
      const key = unmarshall(input.Key);
      const current = items.get(name(key)) ?? {};
      assert.ok(input.ConditionExpression);
      if (!expression(input, current)) throw failure('ConditionalCheckFailedException', 400);
      const next = { ...key, ...structuredClone(current) };
      const names = input.ExpressionAttributeNames ?? {};
      const values = unmarshall(input.ExpressionAttributeValues ?? {});
      const field = (token) => names[token] ?? token;
      for (const clause of input.UpdateExpression.matchAll(/\b(SET|ADD|REMOVE)\s+([\s\S]*?)(?=\s+(?:SET|ADD|REMOVE)\s+|$)/g)) {
        for (const entry of clause[2].split(',').map((part) => part.trim())) {
          const tokens = entry.split(/\s*=\s*|\s+/);
          const path = tokens[0].split('.').map(field);
          let target = next;
          for (const segment of path.slice(0, -1)) target = target[segment] ??= {};
          const attr = path.at(-1);
          if (clause[1] === 'REMOVE') delete target[attr];
          else if (clause[1] === 'ADD') target[attr] = (target[attr] ?? 0) + values[tokens[1]];
          else target[attr] = structuredClone(values[tokens[1]]);
        }
      }
      api.set(next); calls.push(structuredClone(input));
      await api.afterUpdate?.(input, next);
      return { Attributes: marshall(next) };
    },
    async query(input) {
      const pk = input.ExpressionAttributeValues[':pk'].S;
      let rows = [...items.values()].filter((item) => item.PK === pk).sort((a, b) => a.SK.localeCompare(b.SK));
      if (input.ScanIndexForward === false) rows.reverse();
      if (input.ExclusiveStartKey) { const start = unmarshall(input.ExclusiveStartKey); rows = rows.slice(rows.findIndex((row) => row.SK === start.SK) + 1); }
      const page = rows.slice(0, input.Limit ?? rows.length);
      return { Items: page.map(marshall), ...(page.length < rows.length ? { LastEvaluatedKey: marshall({ PK: pk, SK: page.at(-1).SK }) } : {}) };
    },
    async batchGetItem(input) {
      const Responses = {};
      for (const [table, request] of Object.entries(input.RequestItems)) {
        assert.equal(request.ConsistentRead, true);
        assert.ok(request.Keys.length <= 100);
        Responses[table] = request.Keys.flatMap((key) => { const item = items.get(name(unmarshall(key))); return item ? [marshall(item)] : []; });
      }
      return { Responses };
    },
    async transactWriteItems(input) {
      const puts = input.TransactItems.map((item) => item.Put);
      if (puts.some((put) => !expression(put, items.get(name(unmarshall(put.Item))) ?? {}))) throw failure('TransactionCanceledException', 400);
      puts.forEach((put) => { api.set(unmarshall(put.Item)); calls.push(structuredClone(put)); });
      return {};
    },
  };
  return api;
}

export function fixture({ count = 45, env = 'stg', batchSize = 200, cap = 1000, time = Date.parse('2026-11-03T10:00:00Z') } = {}) {
  const ddb = memoryDdb();
  const files = new Map();
  const sends = [];
  const sleeps = [];
  const notices = [];
  const metrics = [];
  const controls = [];
  let remaining = 900000;
  let clock = time;
  const addresses = Array.from({ length: count }, (_, i) => `member${i}@example.com`);
  const settings = { ...configDefaults(env), sending_enabled: true, nonprod_allowlist: addresses, batch_size: batchSize, progress_every: Math.min(20, batchSize), daily_send_cap: cap };
  const org = { PK: 'SETTINGS', SK: 'ORG', from_local: 'info', from_name: '会報', reply_to: 'support@example.com', legal: { sender_name: '会', address: '東京', contact: 'https://example.com' }, max_rate_per_sec: 10, version: 0, test_recipients: addresses.slice(0, 5) };
  const deps = {
    env, region: 'ap-northeast-1', accountId: '123456789012', senderDomain: 'example.com', contactList: 'postline', configSet: `postline-${env}`, dataBucket: 'data', tableName: 'postline',
    eventStreamArn: 'arn:aws:firehose:ap-northeast-1:123456789012:deliverystream/postline',
    now: () => clock, sleep: async (ms) => { sleeps.push(ms); clock += ms; await f.onSleep?.(ms); }, random: () => 0,
    ddb, config: { get: async () => structuredClone(settings) },
    metrics: { emit: (name, value, dimensions) => metrics.push({ name, value, dimensions }) },
    notify: async (code, id) => notices.push({ code, id }), logger: { error: (...args) => f.logs.push(args) },
    secretsProvider: { get: async () => ({ key: '7'.repeat(64) }) },
    s3: {
      putObject: async (input) => { await f.onPut?.(input); files.set(input.Key, input.Body); return {}; },
      getObject: async (input) => { if (!files.has(input.Key)) throw failure('NoSuchKey', 404); return { Body: files.get(input.Key) }; },
      headObject: async (input) => { if (!files.has(input.Key)) throw failure('NotFound', 404); return {}; },
    },
    ses: {
      getAccount: async () => { controls.push({ op: 'account', time: clock }); if (f.accountError) throw f.accountError; return structuredClone(f.account); },
      getEmailIdentity: async () => structuredClone(f.identity),
      getConfigurationSet: async () => structuredClone(f.configuration),
      getConfigurationSetEventDestinations: async () => structuredClone(f.destinations),
      listContacts: async (input) => { f.listInputs.push(input); return f.contactPages ? f.contactPages[Number(input.NextToken ?? 0)] : { Contacts: f.contacts }; },
      getContact: async (input) => { const contact = f.contacts.find((item) => item.EmailAddress === input.EmailAddress); if (!contact) throw failure('NotFoundException', 404); return contact; },
      sendEmail: async (input) => {
        sends.push({ time: clock, input: structuredClone(input) });
        if (f.onSend) return f.onSend(input, sends.length);
        return { MessageId: `m${sends.length}` };
      },
    },
    cloudwatch: {
      describeAlarms: async () => { if (f.alarmError) throw f.alarmError; return { MetricAlarms: f.alarms }; },
      getMetricData: async (input) => { if (f.metricError) throw f.metricError; return { MetricDataResults: input.MetricDataQueries.map(({ Id }) => ({ Id, StatusCode: 'Complete', Values: f.metricValues[Id] ?? [] })) }; },
    },
  };
  const f = {
    deps, ddb, files, sends, sleeps, notices, metrics, controls, settings, org, addresses, logs: [], listInputs: [], metricValues: {},
    account: { SendingEnabled: true, ProductionAccessEnabled: true, EnforcementStatus: 'HEALTHY', SuppressionAttributes: { SuppressedReasons: ['BOUNCE', 'COMPLAINT'] }, SendQuota: { Max24HourSend: 100000, SentLast24Hours: 0, MaxSendRate: 100 } },
    identity: { VerifiedForSendingStatus: true, DkimAttributes: { SigningEnabled: true, Status: 'SUCCESS', CurrentSigningKeyLength: 'RSA_2048_BIT' }, MailFromAttributes: { MailFromDomain: 'bounce.example.com', MailFromDomainStatus: 'SUCCESS', BehaviorOnMxFailure: 'REJECT_MESSAGE' } },
    configuration: { SendingOptions: { SendingEnabled: true }, DeliveryOptions: { TlsPolicy: 'REQUIRE' }, ReputationOptions: { ReputationMetricsEnabled: true } },
    destinations: { EventDestinations: [
      { Enabled: true, MatchingEventTypes: REQUIRED_EVENTS, CloudWatchDestination: { DimensionConfigurations: [{ DimensionName: 'campaign', DimensionValueSource: 'MESSAGE_TAG', DefaultDimensionValue: 'none' }] } },
      { Enabled: true, MatchingEventTypes: REQUIRED_EVENTS, KinesisFirehoseDestination: { DeliveryStreamArn: deps.eventStreamArn, IamRoleArn: 'arn:aws:iam::123456789012:role/events' } },
    ] },
    contacts: addresses.map((EmailAddress) => ({ EmailAddress, UnsubscribeAll: false, TopicPreferences: [{ TopicName: 'news', SubscriptionStatus: 'OPT_IN' }] })),
    alarms: [...settings.reputation_alarms, ...monitoringAlarmNames(env)].map((AlarmName) => ({ AlarmName, StateValue: 'OK' })),
    advance(ms) { clock += ms; remaining -= ms; }, setTime(value) { clock = value; }, setRemaining(value) { remaining = value; },
    context: { awsRequestId: 'req', getRemainingTimeInMillis: () => remaining },
    getCampaign: (id = ID) => ddb.get('CAMPAIGN', id),
    setCampaign: (set, id = ID) => ddb.set({ ...f.getCampaign(id), ...set }),
    event: (mode, extra = {}) => ({ mode, campaign_id: ID, execution_arn: ARN, ...extra }),
  };
  const hashSettings = {
    env, region: deps.region, accountId: deps.accountId, senderDomain: deps.senderDomain, contactList: deps.contactList, configSet: deps.configSet, eventStreamArn: deps.eventStreamArn,
    from_local: org.from_local, from_name: org.from_name, reply_to: org.reply_to, legal: org.legal, monitoringAlarms: monitoringAlarmNames(env),
  };
  f.configHash = sendingConfigHash(hashSettings);
  f.auth = { PK: 'SETTINGS', SK: 'AUTH_STATUS', checked_at: new Date(clock).toISOString(), domain: deps.senderDomain, config_hash: f.configHash, dns_config_hash: 'd'.repeat(64), status: 'PASS' };
  f.delivery = { status: 'PASS', passed_at: new Date(clock).toISOString(), by: 'admin', note: '承認上限はSSMの日次上限。観測不足を確認済み。', evidence_key: 'delivery-checks/check/evidence.json', cases: Object.fromEntries(DELIVERY_CASES.map((id) => [id, 'PASS'])), config_hash: f.configHash, dns_config_hash: f.auth.dns_config_hash };
  if (env === 'prod') { org.delivery_check = f.delivery; files.set(f.delivery.evidence_key, '{}'); }
  ddb.set(org); ddb.set(f.auth);
  ddb.set({ PK: 'CAMPAIGN', SK: ID, campaign_id: ID, status: 'QUEUED', version: 0, topic: 'news', from: '=?UTF-8?B?5Lya5aCx?= <info@example.com>', reply_to: org.reply_to, template_name: `pl-c-${ID}-1`, created_at: new Date(clock).toISOString() });
  f.store = createDdb(deps);
  f.handler = createHandler(deps);
  f.prepare = (extra) => f.handler(f.event('prepare', extra), f.context);
  f.send = () => f.handler(f.event('send'), f.context);
  f.finish = (outcome, extra = {}) => f.handler(f.event('finish', { outcome, ...extra }), f.context);
  return f;
}
