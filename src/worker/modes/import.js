import { validateImportCsv, writeSesImport } from '../../common/csv.js';
import { addressHash } from '../../common/log.js';
import { marshall, unmarshall } from '../../common/ddb.js';
import { normalizeEmail } from '../../common/email.js';
import { contactPages, objectText, updateRecord, timestamp, conflict } from '../../common/records.js';
import { ensureContactMetadata } from '../../common/contact-metadata.js';
import { AppError } from '../../common/http.js';
import { eraseMatch } from '../../common/erase.js';
import { reviewUnsupportedSchema } from '../../common/schema.js';

async function inspect(runtime, record, parsed, hmacKey) {
  const erased = new Set();
  const metadata = new Map();
  const eraseKeys = new Map();
  for (const row of parsed.rows) eraseKeys.set(row.email, await eraseMatch(runtime, row.email));
  for (let offset = 0; offset < parsed.rows.length; offset += 50) {
    const keys = parsed.rows.slice(offset, offset + 50).flatMap((row) => [marshall({ PK: 'ERASED', SK: eraseKeys.get(row.email) }), marshall({ PK: 'CONTACT_META', SK: addressHash(row.email, hmacKey) })]);
    const response = await runtime.ddb.batchGetItem({ RequestItems: { [runtime.tableName]: { Keys: keys, ConsistentRead: true } } });
    if (Object.values(response.UnprocessedKeys ?? {}).some((item) => item.Keys?.length)) throw new Error('Unprocessed erased keys');
    for (const item of response.Responses?.[runtime.tableName] ?? []) {
      const value = unmarshall(item);
      if (value.PK === 'ERASED') erased.add(value.SK);
      else metadata.set(value.SK, value);
    }
  }
  const existing = new Set();
  for await (const contacts of contactPages(runtime)) for (const contact of contacts) existing.add(normalizeEmail(contact.EmailAddress).email);
  const config = await runtime.config.get();
  return parsed.rows.map((row) => {
    const rid = addressHash(row.email, hmacKey);
    const meta = metadata.get(rid);
    const deleted = erased.has(eraseKeys.get(row.email)) || meta?.erased;
    if (record.mode !== 'UPDATE_EXISTING') {
      const code = deleted ? 'ERASED_SKIPPED' : existing.has(row.email) || meta ? 'EXISTING_SKIPPED' : runtime.env !== 'prod' && !config.nonprod_allowlist.includes(row.email) ? 'NOT_ALLOWED_IN_ENV' : 'READY';
      return { ...row, rid, code };
    }
    if (deleted) return { ...row, rid, code: 'ERASED' };
    if (!existing.has(row.email)) return { ...row, rid, code: 'NOT_FOUND' };
    if (!meta || meta.registration_state === 'PENDING' || !meta.attributes) return { ...row, rid, code: 'INVALID', reason: 'METADATA_REQUIRED' };
    const attributes = structuredClone(meta.attributes);
    const blocked_all = meta.blocked_all || row.stop === 'ALL';
    const blocked_topics = [...new Set([...(meta.blocked_topics ?? []), ...row.stopped])].sort();
    if (row.stop === 'ALL') delete attributes.name;
    else if (row.name) attributes.name = row.name;
    const nameChanged = attributes.name !== meta.attributes.name;
    const stopChanged = blocked_all !== meta.blocked_all || JSON.stringify(blocked_topics) !== JSON.stringify([...(meta.blocked_topics ?? [])].sort());
    return { ...row, rid, meta, set: { attributes, blocked_all, blocked_topics }, nameChanged, stopChanged, code: nameChanged || stopChanged ? 'UPDATED' : 'UNCHANGED' };
  });
}

const publicRow = (row) => ({ row: row.row, code: row.code, ...(row.reason ? { reason: row.reason } : {}) });
function reportFor(record, evaluated, rejected) {
  const all = [...rejected, ...evaluated.map(publicRow)].sort((a, b) => a.row - b.row);
  const summary = {};
  for (const row of all) summary[row.code] = (summary[row.code] ?? 0) + 1;
  return { total: all.length, ready: evaluated.filter((row) => ['READY', 'UPDATED'].includes(row.code)).length, summary, changes: { name: evaluated.filter((row) => row.code === 'UPDATED' && row.nameChanged).length, stop: evaluated.filter((row) => row.code === 'UPDATED' && row.stopChanged).length }, rows: all };
}

export async function importContacts(event, runtime) {
  let record = await runtime.store.get('IMPORT', event.import_id);
  if (await reviewUnsupportedSchema(runtime, record)) return { status: 'NEEDS_REVIEW', reason: 'UNSUPPORTED_SCHEMA' };
  const applying = ['SUBMITTING', 'APPLYING'].includes(record?.status) && !record.applying_started_at;
  if (!record || record.status !== 'RECEIVED' && !applying) return { status: record?.status ?? 'NOT_FOUND' };
  try {
    record = await updateRecord(runtime, 'IMPORT', record.import_id, record, applying ? { applying_started_at: timestamp(runtime) } : { status: 'VALIDATING' });
  } catch (error) { if (conflict(error)) return { status: 'ALREADY_CLAIMED' }; throw error; }
  try {
    if ((await runtime.ses.getAccount({})).ProductionAccessEnabled !== true) throw new AppError('IMPORT_REQUIRES_PRODUCTION', 422, 'SESのサンドボックスではCSV取込を使えません。1件ずつ登録してください。');
    if (applying && (await runtime.contactLock.get())?.owner !== record.import_id) throw new AppError('CONTACT_IMPORT_IN_PROGRESS', 409, '取込の排他を確認してください。');
    const source = await objectText(await runtime.s3.getObject({ Bucket: runtime.dataBucket, Key: `imports/staging/${record.import_id}.csv` }));
    const topics = ((await runtime.ses.getContactList({ ContactListName: runtime.contactList })).Topics ?? []).map((topic) => topic.TopicName);
    const parsed = validateImportCsv(source, { topics, importId: record.import_id, now: runtime.now, mode: record.mode });
    const hmacKey = (await runtime.secrets.get('address-hmac')).key;
    let evaluated = await inspect(runtime, record, parsed, hmacKey);
    if (!applying) {
      const report = reportFor(record, evaluated, parsed.rejected);
      await runtime.s3.putObject({ Bucket: runtime.dataBucket, Key: `imports/preview/${record.import_id}.json`, ContentType: 'application/json', Body: JSON.stringify(evaluated.map((row) => ({ row: row.row, code: row.code, ...(row.meta ? { version: row.meta.version } : {}) }))) });
      await runtime.s3.putObject({ Bucket: runtime.dataBucket, Key: `imports/report/${record.import_id}.json`, ContentType: 'application/json', Body: JSON.stringify(report) });
      await updateRecord(runtime, 'IMPORT', record.import_id, record, { status: 'PREVIEW', total: report.total, ready: report.ready, summary: report.summary, changes: report.changes, preview_expires_at: new Date(runtime.now() + 86400000).toISOString() });
      runtime.metrics.emit('ImportRows', report.total);
      runtime.metrics.emit('ImportSkipped', report.total - report.ready - parsed.rejected.length);
      runtime.metrics.emit('ImportRejected', parsed.rejected.length);
      return { status: 'PREVIEW', import_id: record.import_id };
    }
    const preview = new Map(JSON.parse(await objectText(await runtime.s3.getObject({ Bucket: runtime.dataBucket, Key: `imports/preview/${record.import_id}.json` }))).map((row) => [row.row, row]));
    evaluated = evaluated.map((row) => {
      const old = preview.get(row.row);
      if (row.code !== old?.code || row.meta && old.version !== row.meta.version) return { ...row, code: record.mode === 'UPDATE_EXISTING' ? 'INVALID' : row.code === 'READY' ? 'PREVIEW_CHANGED' : row.code, reason: 'STATE_CHANGED' };
      return row;
    });
    if (record.mode === 'UPDATE_EXISTING') {
      for (const row of evaluated.filter((row) => row.code === 'UPDATED')) {
        // 監査を先に残し、復元時にも停止を失わない。
        if (row.stop) for (const scope of row.stop === 'ALL' ? ['ALL'] : row.stopped) await runtime.audit.write({ actor_sub: record.confirmed_by, action: 'CONTACT_STOP', target: 'contact', result: 'SUCCESS', request_id: record.import_id, addr_id: row.rid, details: { scope, operation: 'IMPORT' } });
        try { await updateRecord(runtime, 'CONTACT_META', row.rid, row.meta, row.set); } catch (error) {
          if (!conflict(error)) throw error;
          row.code = 'INVALID'; row.reason = 'STATE_CHANGED';
        }
      }
    }
    const report = reportFor(record, evaluated, parsed.rejected);
    await runtime.s3.putObject({ Bucket: runtime.dataBucket, Key: `imports/report/${record.import_id}.json`, ContentType: 'application/json', Body: JSON.stringify(report) });
    const accepted = evaluated.filter((row) => row.code === 'READY');
    if (record.mode === 'UPDATE_EXISTING' || !accepted.length) {
      await updateRecord(runtime, 'IMPORT', record.import_id, record, { status: 'DONE', total: report.total, ready: report.ready, summary: report.summary, changes: report.changes, completed_at: timestamp(runtime) });
      await runtime.audit.write({ actor_sub: record.confirmed_by, action: 'IMPORT_COMPLETE', target: record.import_id, result: 'DONE', request_id: record.import_id, details: { mode: record.mode, total: report.total, name_changed_count: report.changes.name, stop_changed_count: report.changes.stop } });
      await runtime.contactLock.change(record.import_id, {}, true);
      return { status: 'DONE' };
    }
    for (let offset = 0; offset < accepted.length; offset += 20) {
      const results = await Promise.allSettled(accepted.slice(offset, offset + 20).map((row) => ensureContactMetadata(runtime, { EmailAddress: row.email, AttributesData: JSON.stringify(row.attributes) })));
      const failed = results.find((result) => result.status === 'rejected');
      if (failed) throw failed.reason;
    }
    const readyKey = `imports/ready/${record.import_id}.jsonl`;
    await runtime.s3.putObject({ Bucket: runtime.dataBucket, Key: readyKey, ContentType: 'application/x-ndjson', Body: writeSesImport(accepted, topics) });
    record = await updateRecord(runtime, 'IMPORT', record.import_id, record, { total: report.total, ready: report.ready });
    await runtime.contactLock.change(record.import_id, { state: 'SUBMITTING' });
    const job = await runtime.ses.createImportJob({ ImportDestination: { ContactListDestination: { ContactListName: runtime.contactList, ContactListImportAction: 'PUT' } }, ImportDataSource: { S3Url: `s3://${runtime.dataBucket}/${readyKey}`, DataFormat: 'JSON' } });
    if (!job.JobId) throw new Error('Missing import job ID');
    await runtime.contactLock.change(record.import_id, { state: 'IMPORTING', job_id: job.JobId });
    await updateRecord(runtime, 'IMPORT', record.import_id, record, { status: 'IMPORTING', job_id: job.JobId });
    await runtime.record(record.import_id, 'IMPORT_START', 'IMPORTING');
    return { status: 'IMPORTING', import_id: record.import_id };
  } catch (error) {
    const current = await runtime.store.get('IMPORT', record.import_id);
    if (current && !['DONE', 'IMPORTING'].includes(current.status)) await updateRecord(runtime, 'IMPORT', record.import_id, current, { status: applying ? 'NEEDS_REVIEW' : 'FAILED', error_code: error.code ?? 'INTERNAL' });
    await runtime.record(record.import_id, 'IMPORT_FAILED', error.code ?? 'INTERNAL');
    if (applying) await runtime.notify('IMPORT_NEEDS_REVIEW', record.import_id);
    throw error;
  }
}
