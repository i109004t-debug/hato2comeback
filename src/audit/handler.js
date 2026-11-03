import { createHash } from 'node:crypto';
import { createAwsAdapters } from '../common/aws.js';
import { unmarshall } from '../common/ddb.js';
import { createMetrics } from '../common/metrics.js';
import { createLogger } from '../common/log.js';
import { createTime } from '../common/time.js';
import { AppError } from '../common/http.js';
import { auditArchiveKey } from '../common/audit-archive.js';

const safe = (value) => value.replace(/[^A-Za-z0-9._-]/g, '_');

export function createHandler(deps = {}) {
  const environment = deps.environment ?? process.env;
  const runtime = { ...createAwsAdapters({ region: environment.AWS_REGION }), env: environment.ENV, auditArchiveBucket: environment.AUDIT_ARCHIVE_BUCKET, ...createTime(deps), ...deps };
  let metrics = deps.metrics;
  return async (event, context = {}) => {
    const logger = deps.logger ?? createLogger({ fn: 'audit', req_id: context.awsRequestId, now: runtime.now });
    try {
      if (!Array.isArray(event?.Records)) throw new Error('Invalid stream batch');
      for (const record of event.Records) {
        const keys = unmarshall(record.dynamodb?.Keys ?? {});
        if (!keys.PK?.startsWith('AUDIT#')) continue;
        if (record.eventName === 'REMOVE' && record.userIdentity?.type === 'Service' && record.userIdentity.principalId === 'dynamodb.amazonaws.com') continue;
        if (!['INSERT', 'MODIFY', 'REMOVE'].includes(record.eventName) || typeof record.eventID !== 'string' || !record.eventID) throw new Error('Invalid stream record');
        const before = record.dynamodb.OldImage ? unmarshall(record.dynamodb.OldImage) : null;
        const after = record.dynamodb.NewImage ? unmarshall(record.dynamodb.NewImage) : null;
        // 書換えられた日時で移動しないよう、変更前の記録日時を優先する。
        const item = before ?? after;
        if (!item || !Number.isFinite(Date.parse(item.ts)) || typeof keys.SK !== 'string' || !keys.SK) throw new Error('Invalid audit item');
        const ts = new Date(Date.parse(item.ts)).toISOString();
        const date = ts.slice(0, 10).replaceAll('-', '/');
        const insert = record.eventName === 'INSERT';
        if (insert && !after || record.eventName === 'MODIFY' && (!before || !after) || record.eventName === 'REMOVE' && !before) throw new Error('Missing audit image');
        const contents = insert ? { after } : { before, after };
        const sha256 = createHash('sha256').update(JSON.stringify(contents)).digest('hex');
        const stream_ts = Number.isFinite(record.dynamodb.ApproximateCreationDateTime) ? new Date(record.dynamodb.ApproximateCreationDateTime * 1000).toISOString() : ts;
        const body = { eventID: record.eventID, eventName: record.eventName, ts, stream_ts, ...contents, sha256 };
        if (item.PK !== keys.PK || item.SK !== keys.SK) throw new Error('Audit identity mismatch');
        const Key = insert ? auditArchiveKey({ PK: keys.PK, SK: keys.SK, ts }) : `tamper/${date}/${safe(record.eventID)}.json`;
        await runtime.s3.putObject({ Bucket: runtime.auditArchiveBucket, Key, ContentType: 'application/json', Body: JSON.stringify(body) });
        if (!insert) { metrics ??= createMetrics(runtime); metrics.emit('AuditTamper', 1); }
      }
      return { status: 'DONE' };
    } catch (error) {
      logger.error('Audit archive failed', { err: error });
      throw new AppError('INTERNAL', 500, '監査の保管庫への保存に失敗しました。');
    }
  };
}

export const handler = createHandler();
