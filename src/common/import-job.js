import { updateRecord, timestamp } from './records.js';

export async function reconcileImport(runtime, record, { admin = false, actor = 'SYSTEM', requestId = 'daily' } = {}) {
  const lock = await runtime.contactLock.get();
  if (!record.job_id || record.status !== 'IMPORTING' && !(lock?.owner === record.import_id && ['DONE', 'FAILED'].includes(record.status))) return record;
  const job = await runtime.ses.getImportJob({ JobId: record.job_id });
  if (!['COMPLETED', 'FAILED', 'CANCELLED'].includes(job.JobStatus)) return record;
  const status = job.JobStatus === 'COMPLETED' ? 'DONE' : 'FAILED';
  const saved = record.status === status ? record : await updateRecord(runtime, 'IMPORT', record.import_id, record, {
    status, completed_at: timestamp(runtime), processed: job.ProcessedRecordsCount ?? 0, failed: job.FailedRecordsCount ?? 0,
  });
  await runtime.audit.write({ actor_sub: actor, action: 'IMPORT_COMPLETE', target: record.import_id, result: status, request_id: requestId, details: { processed: saved.processed, failed: saved.failed } });
  if (lock?.owner === record.import_id && (status === 'DONE' || admin)) await runtime.contactLock.change(record.import_id, {}, true);
  if (status === 'FAILED' && !admin) await runtime.notify?.('IMPORT_FAILED', record.import_id);
  return saved;
}
