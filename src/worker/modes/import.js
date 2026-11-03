import { validateImportCsv, writeSesImport } from '../../common/csv.js';
import { addressHash } from '../../common/log.js';
import { marshall, unmarshall } from '../../common/ddb.js';
import { normalizeEmail } from '../../common/email.js';
import { contactPages, objectText, updateRecord, timestamp, conflict } from '../../common/records.js';

export async function importContacts(event, runtime) {
  let record = await runtime.store.get('IMPORT', event.import_id);
  if (!record || record.status !== 'RECEIVED') return { status: record?.status ?? 'NOT_FOUND' };
  try { record = await updateRecord(runtime, 'IMPORT', record.import_id, record, { status: 'VALIDATING' }); } catch (error) {
    if (conflict(error)) return { status: 'ALREADY_CLAIMED' };
    throw error;
  }
  let acquired = false;
  try {
    const source = await objectText(await runtime.s3.getObject({ Bucket: runtime.dataBucket, Key: `imports/staging/${record.import_id}.csv` }));
    const definition = await runtime.ses.getContactList({ ContactListName: runtime.contactList });
    const topics = (definition.Topics ?? []).map((topic) => topic.TopicName);
    const parsed = validateImportCsv(source, { topics, importId: record.import_id, now: runtime.now });
    const secret = await runtime.secrets.get('erase-hmac');
    const hmacKey = Buffer.from(secret.key, 'base64');
    // 完全削除との競合も避けるため、HMAC照合の直前から排他を保持する。
    await runtime.contactLock.acquire(record.import_id);
    acquired = true;
    const erased = new Set();
    for (let offset = 0; offset < parsed.rows.length; offset += 100) {
      const hashes = parsed.rows.slice(offset, offset + 100).map((row) => addressHash(row.email, hmacKey));
      const response = await runtime.ddb.batchGetItem({ RequestItems: { [runtime.tableName]: { Keys: hashes.map((SK) => marshall({ PK: 'ERASED', SK })), ConsistentRead: true } } });
      // 未処理キーがあれば一致なしとみなさず、登録前に止める。
      if (Object.values(response.UnprocessedKeys ?? {}).some((item) => item.Keys?.length)) throw new Error('Unprocessed erased keys');
      for (const item of response.Responses?.[runtime.tableName] ?? []) erased.add(unmarshall(item).SK);
    }
    const existing = new Set();
    for await (const contacts of contactPages(runtime)) for (const contact of contacts) existing.add(normalizeEmail(contact.EmailAddress).email);
    const config = await runtime.config.get();
    const rejected = [...parsed.rejected];
    const accepted = parsed.rows.filter((row) => {
      const code = erased.has(addressHash(row.email, hmacKey)) ? 'ERASED_SKIPPED' : existing.has(row.email) ? 'EXISTING_SKIPPED' : runtime.env !== 'prod' && !config.nonprod_allowlist.includes(row.email) ? 'NOT_ALLOWED_IN_ENV' : null;
      if (code) rejected.push({ row: row.row, code });
      return !code;
    });
    rejected.sort((a, b) => a.row - b.row);
    const report = { total: parsed.rows.length + parsed.rejected.length, ready: accepted.length, rows: rejected };
    await runtime.s3.putObject({ Bucket: runtime.dataBucket, Key: `imports/report/${record.import_id}.json`, ContentType: 'application/json', Body: JSON.stringify(report) });
    const skipped = rejected.filter((row) => ['ERASED_SKIPPED', 'EXISTING_SKIPPED', 'NOT_ALLOWED_IN_ENV'].includes(row.code)).length;
    runtime.metrics.emit('ImportRows', report.total);
    runtime.metrics.emit('ImportSkipped', skipped);
    runtime.metrics.emit('ImportRejected', rejected.length - skipped);
    if (!accepted.length) {
      await updateRecord(runtime, 'IMPORT', record.import_id, record, { status: 'DONE', ...report, completed_at: timestamp(runtime) });
      await runtime.record(record.import_id, 'IMPORT_COMPLETE', 'DONE');
      await runtime.contactLock.change(record.import_id, {}, true);
      return { status: 'DONE' };
    }
    const readyKey = `imports/ready/${record.import_id}.csv`;
    await runtime.s3.putObject({ Bucket: runtime.dataBucket, Key: readyKey, ContentType: 'text/csv; charset=utf-8', Body: writeSesImport(accepted, topics) });
    // 呼出し前に不明状態を永続化し、応答を失っても再ジョブを作らない。
    record = await updateRecord(runtime, 'IMPORT', record.import_id, record, { status: 'SUBMITTING', total: report.total, ready: report.ready });
    await runtime.contactLock.change(record.import_id, { state: 'SUBMITTING' });
    const job = await runtime.ses.createImportJob({
      ImportDestination: { ContactListDestination: { ContactListName: runtime.contactList, ContactListImportAction: 'PUT' } },
      ImportDataSource: { S3Url: `s3://${runtime.dataBucket}/${readyKey}`, DataFormat: 'CSV' },
    });
    if (!job.JobId) throw new Error('Missing import job ID');
    await runtime.contactLock.change(record.import_id, { state: 'IMPORTING', job_id: job.JobId });
    await updateRecord(runtime, 'IMPORT', record.import_id, record, { status: 'IMPORTING', job_id: job.JobId });
    await runtime.record(record.import_id, 'IMPORT_START', 'IMPORTING');
    return { status: 'IMPORTING', import_id: record.import_id };
  } catch (error) {
    const current = await runtime.store.get('IMPORT', record.import_id);
    if (current && !['DONE', 'IMPORTING'].includes(current.status)) await updateRecord(runtime, 'IMPORT', record.import_id, current, { status: acquired ? 'NEEDS_REVIEW' : 'FAILED', error_code: error.code ?? 'INTERNAL' });
    await runtime.record(record.import_id, 'IMPORT_FAILED', error.code ?? 'INTERNAL');
    if (acquired) await runtime.notify('IMPORT_NEEDS_REVIEW', record.import_id);
    throw error;
  }
}
