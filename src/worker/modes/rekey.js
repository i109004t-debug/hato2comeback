import { createHash, randomUUID } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { addressHash } from '../../common/log.js';
import { normalizeEmail } from '../../common/email.js';
import { AppError, invalid } from '../../common/http.js';
import { contactAttributes } from '../../common/contact-metadata.js';
import { isErased } from '../../common/erase.js';
import { marshall, createExpressions, encodeCursor, decodeCursor } from '../../common/ddb.js';
import { updateRecord, timestamp, objectText } from '../../common/records.js';
import { jstDate } from '../../common/time.js';

const digest = (key) => createHash('sha256').update(key).digest('hex');
const missing = () => new AppError('BACKUP_ATTRIBUTES_MISSING', 503, '属性と停止状態を復元できません。');
const validDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;

function match(item) {
  const expressions = createExpressions();
  const ConditionExpression = `${expressions.equals('kid', item.kid)} AND ${expressions.equals('version', item.version)}`;
  return { ConditionExpression, ...expressions.attributes() };
}

async function move(runtime, secret, contact, source) {
  const email = normalizeEmail(contact.EmailAddress).email;
  const SK = addressHash(email, secret.key);
  const current = await runtime.store.get('CONTACT_META', SK);
  if (current && (current.kid !== secret.kid || !Number.isSafeInteger(current.version))) throw new AppError('CONFIGURATION_INVALID', 503, '宛先の鍵の版を確認してください。');
  const erased = await isErased(runtime, email);
  if (source === 'BACKUP') {
    if (erased || current) return false;
    if (contact.HT2MetadataStatus === 'MISSING' || !contact.AttributesData) throw missing();
    await updateRecord(runtime, 'CONTACT_META', SK, undefined, {
      kid: secret.kid, attributes: contactAttributes(contact), blocked_all: contact.UnsubscribeAll === true,
      blocked_topics: (contact.TopicPreferences ?? []).filter((entry) => entry.SubscriptionStatus === 'OPT_OUT').map((entry) => entry.TopicName).sort(),
    });
    return true;
  }
  const oldSK = addressHash(email, secret.previous.key);
  const old = await runtime.store.get('CONTACT_META', oldSK);
  if (!old) {
    if (current || erased) return false;
    throw missing();
  }
  if (old.kid !== secret.previous.kid || !Number.isSafeInteger(old.version)) throw missing();
  if (current) {
    // 途中再開で新しい項目がある場合も、停止状態の欠落を許さない。
    if (old.blocked_all && !current.blocked_all || old.erased && !current.erased || (old.blocked_topics ?? []).some((topic) => !current.blocked_topics?.includes(topic))) throw missing();
  }
  const next = current ? { ...current, version: current.version + 1, updated_at: timestamp(runtime) } : {
    ...old, PK: 'CONTACT_META', SK, kid: secret.kid, version: 1, updated_at: timestamp(runtime),
    ...(old.attributes ? { attributes: contactAttributes({ AttributesData: JSON.stringify(old.attributes) }) } : {}),
    ...(old.pending_attributes ? { pending_attributes: contactAttributes({ AttributesData: JSON.stringify(old.pending_attributes) }) } : {}),
    ...(erased ? { erased: true, blocked_all: true, blocked_topics: [] } : {}),
  };
  if (next.erased || erased) {
    next.erased = true; next.blocked_all = true; next.blocked_topics = [];
    delete next.attributes; delete next.pending_attributes;
  }
  const putCondition = current ? match(current) : { ConditionExpression: 'attribute_not_exists(PK)' };
  // コピーと旧項目の削除を一度で確定し、停止操作との競合時は何も変えない。
  await runtime.ddb.transactWriteItems({ TransactItems: [
    { Put: { TableName: runtime.tableName, Item: marshall(next), ...putCondition } },
    { Delete: { TableName: runtime.tableName, Key: marshall({ PK: 'CONTACT_META', SK: oldSK }), ...match(old) } },
  ] });
  return !current;
}

async function backupRows(runtime, requestedDate) {
  let date = requestedDate;
  if (!date) {
    const backup = await runtime.store.get('SETTINGS', 'CONTACT_BACKUP');
    if (!backup?.complete || !Number.isFinite(Date.parse(backup.backed_up_at))) throw missing();
    date = jstDate(Date.parse(backup.backed_up_at));
  }
  const prefix = `backups/contacts/${date}`;
  const manifest = JSON.parse(await objectText(await runtime.s3.getObject({ Bucket: runtime.dataBucket, Key: `${prefix}.manifest.json` })));
  if (manifest.complete !== true || !/^[a-f0-9]{64}$/.test(manifest.sha256 ?? '')) throw missing();
  const response = await runtime.s3.getObject({ Bucket: runtime.dataBucket, Key: `${prefix}.jsonl.gz` });
  let body;
  if (response.Body instanceof Uint8Array) body = Buffer.from(response.Body);
  else if (response.Body?.transformToByteArray) body = Buffer.from(await response.Body.transformToByteArray());
  else {
    const parts = [];
    for await (const part of response.Body) parts.push(Buffer.from(part));
    body = Buffer.concat(parts);
  }
  if (digest(body) !== manifest.sha256) throw missing();
  const rows = gunzipSync(body).toString('utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  if (rows.length !== manifest.total) throw missing();
  return { date, sha256: manifest.sha256, rows };
}

export async function rekeyContacts(event, runtime, context = {}) {
  if (!['SES', 'BACKUP'].includes(event.source) || Object.keys(event).some((key) => !['mode', 'source', 'backup_date'].includes(key)) || event.backup_date !== undefined && (event.source !== 'BACKUP' || !validDate(event.backup_date))) throw invalid('source');
  const secret = await runtime.secrets.get('address-hmac');
  let state = await runtime.store.get('SETTINGS', 'REKEY');
  const owner = `rekey:${secret.kid}`;
  if (state?.kid === secret.kid && state.complete) {
    if (state.key_hash !== digest(secret.key)) throw new AppError('STATE_CONFLICT', 409, '同じkidで鍵を変更しないでください。');
    if (state.running_until_ms > runtime.now()) throw new AppError('CONTACT_IMPORT_IN_PROGRESS', 409, '鍵の入れ替えを処理中です。');
    if ((await runtime.contactLock.get())?.owner === owner) await runtime.contactLock.change(owner, {}, true);
    return { status: 'DONE', saved: 0, examined: 0 };
  }
  if ((await runtime.config.get()).sending_enabled !== false) throw new AppError('STATE_CONFLICT', 409, '全体の停止スイッチを切ってください。');
  // 中断後の再開は、同じ鍵・入力だけを受け付ける。
  if (state && !state.complete && (state.kid !== secret.kid || state.key_hash !== digest(secret.key) || state.source !== event.source || event.backup_date && event.backup_date !== state.backup_date || state.previous_key_hash && state.previous_key_hash !== (secret.previous ? digest(secret.previous.key) : ''))) throw new AppError('STATE_CONFLICT', 409, '処理中の鍵の入れ替えと入力が異なります。');
  if (state?.running_until_ms > runtime.now()) throw new AppError('CONTACT_IMPORT_IN_PROGRESS', 409, '鍵の入れ替えを処理中です。');
  const lock = await runtime.contactLock.get();
  if (lock?.owner !== owner) await runtime.contactLock.acquire(owner);
  const run = context.awsRequestId ?? randomUUID();
  state = await updateRecord(runtime, 'SETTINGS', 'REKEY', state, {
    ...(!state || state.complete ? { kid: secret.kid, key_hash: digest(secret.key), previous_key_hash: secret.previous ? digest(secret.previous.key) : '', source: event.source, backup_date: event.backup_date ?? '', backup_sha256: '', cursor: '', cleanup_cursor: '', index: 0, phase: 'COPY', complete: false, started_at: timestamp(runtime) } : {}),
    previous_key_hash: secret.previous ? digest(secret.previous.key) : '', run, running_until_ms: runtime.now() + 900000, status: 'RUNNING', error_code: '',
  });
  let saved = 0;
  let examined = 0;
  const started = runtime.now();
  const available = () => examined < 500 && runtime.now() - started < 600000 && (!context.getRemainingTimeInMillis || context.getRemainingTimeInMillis() > 120000);
  try {
    if (event.source === 'SES' && !secret.previous) throw new AppError('CONFIGURATION_INVALID', 503, 'SESからの鍵の入れ替えにはpreviousが必要です。');
    let backup;
    if (event.source === 'BACKUP' && state.phase === 'COPY') {
      backup = await backupRows(runtime, state.backup_date || undefined);
      if (state.backup_sha256 && state.backup_sha256 !== backup.sha256) throw missing();
      state = await updateRecord(runtime, 'SETTINGS', 'REKEY', state, { backup_date: backup.date, backup_sha256: backup.sha256 });
    }
    while (state.phase === 'COPY' && available()) {
      const page = event.source === 'SES' ? await runtime.ses.listContacts({ ContactListName: runtime.contactList, PageSize: 1000, ...(state.cursor ? { NextToken: state.cursor } : {}) }) : { Contacts: backup.rows };
      if (!Array.isArray(page.Contacts)) throw missing();
      // SES一覧はsnapshotではないので同じページを再点検し、移動済みのキーは除外する。
      let index = event.source === 'BACKUP' ? state.index : 0;
      while (index < page.Contacts.length && available()) {
        const contact = page.Contacts[index];
        const current = await runtime.store.get('CONTACT_META', addressHash(normalizeEmail(contact.EmailAddress).email, secret.key));
        if (event.source === 'SES' && current?.kid === secret.kid && !await runtime.store.get('CONTACT_META', addressHash(normalizeEmail(contact.EmailAddress).email, secret.previous.key))) { index += 1; continue; }
        if (await move(runtime, secret, contact, event.source)) saved += 1;
        examined += 1;
        index += 1;
        state = await updateRecord(runtime, 'SETTINGS', 'REKEY', state, { index });
      }
      if (index < page.Contacts.length) break;
      if (page.NextToken && page.NextToken === state.cursor) throw missing();
      state = await updateRecord(runtime, 'SETTINGS', 'REKEY', state, { cursor: page.NextToken ?? '', index: 0, phase: page.NextToken ? 'COPY' : 'CLEANUP' });
    }
    if (state.phase === 'CLEANUP') {
      const ExclusiveStartKey = state.cleanup_cursor ? decodeCursor(state.cleanup_cursor, 'CONTACT_META') : undefined;
      for await (const page of runtime.store.queryPages({ KeyConditionExpression: 'PK = :pk', ExpressionAttributeValues: { ':pk': { S: 'CONTACT_META' } }, ...(ExclusiveStartKey ? { ExclusiveStartKey } : {}), ConsistentRead: true })) {
        for (const item of page.items) {
          if (item.kid === secret.kid) continue;
          if (!available()) break;
          // SESで対応先を作れなかった項目は、バックアップによる復旧以外では捨てない。
          if (event.source === 'SES' && !item.erased) throw missing();
          if (!item.kid || !Number.isSafeInteger(item.version)) throw missing();
          await runtime.store.delete('CONTACT_META', item.SK, match(item));
          examined += 1;
          state = await updateRecord(runtime, 'SETTINGS', 'REKEY', state, { cleanup_cursor: encodeCursor(marshall({ PK: 'CONTACT_META', SK: item.SK })) });
        }
        if (!available()) break;
      }
      if (available()) state = await updateRecord(runtime, 'SETTINGS', 'REKEY', state, { complete: true, completed_at: timestamp(runtime) });
    }
    state = await updateRecord(runtime, 'SETTINGS', 'REKEY', state, { running_until_ms: 0, status: state.complete ? 'DONE' : 'MORE', saved_at: timestamp(runtime) });
    if (state.complete) {
      await runtime.record('contacts', 'REKEY', 'DONE');
      await runtime.contactLock.change(owner, {}, true);
    }
    return { status: state.complete ? 'DONE' : 'MORE', saved, examined };
  } catch (error) {
    const code = error instanceof AppError ? error.code : error.name === 'TransactionCanceledException' ? 'STATE_CONFLICT' : 'INTERNAL';
    // 失敗・途中では連絡先の排他を残し、同じ入力で再開できる。
    const latest = await runtime.store.get('SETTINGS', 'REKEY');
    if (latest?.run === run) await updateRecord(runtime, 'SETTINGS', 'REKEY', latest, { running_until_ms: 0, status: 'FAILED', error_code: code });
    await runtime.record('contacts', 'REKEY', code);
    return { status: 'FAILED', code, saved, examined };
  }
}
