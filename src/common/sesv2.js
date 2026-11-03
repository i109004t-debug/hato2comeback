import { AWS_APIS } from './aws.js';
import { key, marshall, unmarshall } from './ddb.js';
import { AppError } from './http.js';
import { createTime } from './time.js';

export function createSesv2(deps) {
  const { ses, ddb, tableName, metrics } = deps;
  const { now, sleep } = createTime(deps);
  const rateKey = key('RATE', 'SES_CONTROL');
  const acquire = async () => {
    for (;;) {
      const response = await ddb.getItem({ TableName: tableName, Key: rateKey, ConsistentRead: true });
      const item = response.Item ? unmarshall(response.Item) : undefined;
      if (item && (!Number.isSafeInteger(item.version) || item.version < 0 || item.version >= Number.MAX_SAFE_INTEGER || !Number.isSafeInteger(item.next_allowed_at_ms) || item.next_allowed_at_ms < 0)) throw new AppError('CONFIGURATION_INVALID', 503, 'SESの制御記録が不正です。');
      const wait = (item?.next_allowed_at_ms ?? 0) - now();
      if (wait > 0) { await sleep(wait); continue; }
      const time = now();
      try {
        await ddb.updateItem({
          TableName: tableName, Key: rateKey,
          UpdateExpression: 'SET #next = :next, #version = :version',
          ConditionExpression: item ? '#version = :old AND #next <= :now' : 'attribute_not_exists(PK)',
          ExpressionAttributeNames: { '#next': 'next_allowed_at_ms', '#version': 'version' },
          ExpressionAttributeValues: marshall({ ':next': time + 1100, ':version': (item?.version ?? 0) + 1, ...(item ? { ':old': item.version, ':now': time } : {}) }),
        });
        return;
      } catch (error) {
        if (error.name !== 'ConditionalCheckFailedException') throw error;
      }
    }
  };
  const control = async (method, input) => {
    for (let attempt = 0; ; attempt += 1) {
      await acquire();
      try { return await ses[method](input); } catch (error) {
        if (error.name !== 'TooManyRequestsException') throw error;
        metrics?.emit('SesBusy', 1);
        if (attempt === 5) throw new AppError('SES_BUSY', 503, 'SESが混み合っています。時間をおいて再度お試しください。');
        await sleep(1000 * 2 ** attempt);
      }
    }
  };
  return Object.freeze(Object.fromEntries(AWS_APIS.ses.operations.map((operation) => {
    const method = operation[0].toLowerCase() + operation.slice(1);
    return [method, method === 'sendEmail' ? (input) => ses.sendEmail(input) : (input) => control(method, input)];
  })));
}
