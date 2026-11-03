import { createHash } from 'node:crypto';
import { objectText } from './records.js';

export function auditArchiveKey({ PK, SK, ts }) {
  if (typeof PK !== 'string' || !PK.startsWith('AUDIT#') || typeof SK !== 'string' || !SK || !Number.isFinite(Date.parse(ts))) throw new TypeError('Invalid audit identity');
  const day = new Date(ts).toISOString().slice(0, 10).replaceAll('-', '/');
  return `audit/${day}/${encodeURIComponent(PK)}/${encodeURIComponent(SK)}.json`;
}

// 復元で再適用する側も、PKを含む同じキーと内容の照合を使う。
export async function readAuditArchive(runtime, identity) {
  const record = JSON.parse(await objectText(await runtime.s3.getObject({ Bucket: runtime.auditArchiveBucket, Key: auditArchiveKey(identity) })));
  const item = record.after;
  if (record.eventName !== 'INSERT' || item?.PK !== identity.PK || item?.SK !== identity.SK || item?.ts !== identity.ts || record.sha256 !== createHash('sha256').update(JSON.stringify({ after: item })).digest('hex')) throw new Error('Invalid audit archive');
  return item;
}
