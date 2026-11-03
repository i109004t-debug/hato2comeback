import { ensureContactMetadata, contactMetadataKey } from '../../common/contact-metadata.js';
import { marshall, unmarshall } from '../../common/ddb.js';
import { updateRecord, timestamp } from '../../common/records.js';

// 既存SES連絡先の属性を、Lambdaの制限内で再開可能な単位に分けて移す。
export async function backfillContacts(event, runtime, context = {}) {
  let state = await runtime.store.get('SETTINGS', 'CONTACT_BACKFILL');
  if (state?.complete && event.restart !== true) return { status: 'DONE', saved: 0, examined: 0 };
  if (!state || event.restart === true) state = await updateRecord(runtime, 'SETTINGS', 'CONTACT_BACKFILL', state, { cursor: '', index: 0, complete: false, started_at: timestamp(runtime) });
  let saved = 0;
  let examined = 0;
  const started = runtime.now();
  while (saved < 500 && runtime.now() - started < 600000 && (!context.getRemainingTimeInMillis || context.getRemainingTimeInMillis() > 120000)) {
    const page = await runtime.ses.listContacts({ ContactListName: runtime.contactList, PageSize: 1000, ...(state.cursor ? { NextToken: state.cursor } : {}) });
    if (!Array.isArray(page.Contacts)) throw new Error('Invalid contacts response');
    const hashes = [];
    for (const contact of page.Contacts) hashes.push(await contactMetadataKey(runtime, contact.EmailAddress));
    const known = new Set();
    for (let offset = 0; offset < hashes.length; offset += 100) {
      const response = await runtime.ddb.batchGetItem({ RequestItems: { [runtime.tableName]: { Keys: hashes.slice(offset, offset + 100).map((SK) => marshall({ PK: 'CONTACT_META', SK })), ConsistentRead: true } } });
      if (Object.values(response.UnprocessedKeys ?? {}).some((item) => item.Keys?.length)) throw new Error('Unprocessed contact metadata keys');
      for (const item of response.Responses?.[runtime.tableName] ?? []) known.add(unmarshall(item).SK);
    }
    // ListContactsはsnapshotではない。前回のindexでは再開せず、保存済みHMACを除外する。
    let index = 0;
    while (index < page.Contacts.length && saved < 500 && runtime.now() - started < 600000 && (!context.getRemainingTimeInMillis || context.getRemainingTimeInMillis() > 120000)) {
      const contact = page.Contacts[index];
      if (!known.has(hashes[index])) {
        try {
          const full = await runtime.ses.getContact({ ContactListName: runtime.contactList, EmailAddress: contact.EmailAddress });
          await ensureContactMetadata(runtime, { ...full, EmailAddress: contact.EmailAddress });
          saved += 1;
        } catch (error) {
          if (error.name !== 'NotFoundException' && error.code !== 'ERASED_ADDRESS') throw error;
        }
      }
      index += 1;
      examined += 1;
    }
    const finishedPage = index >= page.Contacts.length;
    const complete = finishedPage && !page.NextToken;
    if (finishedPage && page.NextToken && page.NextToken === state.cursor) throw new Error('Repeated contacts cursor');
    state = await updateRecord(runtime, 'SETTINGS', 'CONTACT_BACKFILL', state, { cursor: finishedPage ? page.NextToken ?? '' : state.cursor, index: finishedPage ? 0 : index, complete, saved_at: timestamp(runtime) });
    if (complete) break;
  }
  return { status: state.complete ? 'DONE' : 'MORE', saved, examined };
}
