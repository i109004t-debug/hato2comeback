import { updateRecord, contactPages } from './records.js';
import { auditArchiveKey, readAuditArchive } from './audit-archive.js';
import { objectPages, deleteDeliveryIndex } from './storage.js';
import { contactIdentity, eraseContactMetadata } from './contact-metadata.js';
import { eraseMatch } from './erase.js';
import { assertRecoveryAudit } from './audit.js';

export function recoveryRedo(items) {
  const actions = new Set(['RECONSENT', 'CONTACTS_RECONSENT', 'CONTACT_UPDATE', 'CONTACTS_UPDATE', 'SETTINGS_UPDATE']);
  return items.filter((item) => actions.has(item.action)).map(({ action, ts, target, addr_id }) => ({ action, ts, target, ...(addr_id ? { addr_id } : {}) }));
}

export async function readRecoveryAudit(runtime, restorePoint, until) {
  const items = [];
  // 保管庫のaudit/だけを読み、内容のハッシュとキーの対応も検証する。
  for (let day = Date.parse(restorePoint.slice(0, 10)); day <= Date.parse(until.slice(0, 10)); day += 86400000) {
    const prefix = `audit/${new Date(day).toISOString().slice(0, 10).replaceAll('-', '/')}/`;
    for await (const page of objectPages(runtime, runtime.auditArchiveBucket, prefix)) {
      for (const { Key } of page) {
        const match = /^audit\/\d{4}\/\d{2}\/\d{2}\/([^/]+)\/([^/]+)\.json$/.exec(Key ?? '');
        if (!match || !Key.startsWith(prefix)) throw new Error('Invalid audit key');
        const PK = decodeURIComponent(match[1]);
        const SK = decodeURIComponent(match[2]);
        const identity = { PK, SK, ts: SK.split('#')[0] };
        if (auditArchiveKey(identity) !== Key) throw new Error('Audit key mismatch');
        const item = await readAuditArchive(runtime, identity);
        if (item.ts > restorePoint && item.ts <= until) items.push(item);
      }
    }
  }
  return items.sort((a, b) => a.SK.localeCompare(b.SK));
}

export async function addErased(runtime, addrId, mac, at) {
  if (!/^[a-f0-9]{64}$/.test(mac ?? '') || addrId !== undefined && !/^[a-f0-9]{64}$/.test(addrId)) throw new Error('Invalid erase audit');
  if (!await runtime.store.get('ERASED', mac)) {
    try { await runtime.store.put({ PK: 'ERASED', SK: mac, ...(addrId ? { addr_id: addrId } : {}), erased_at: at }); } catch (error) {
      if (error.name !== 'ConditionalCheckFailedException') throw error;
    }
  }
}

export async function replayContactAudit(runtime, items, { resolveAddrId = (item) => item.addr_id, contactFields = {} } = {}) {
  for (const item of items) assertRecoveryAudit(item);
  let stops = 0;
  let erasures = 0;
  const erased = new Set();
  const erasedMacs = new Set();
  for (const item of items) {
    if (!['CONTACT_STOP', 'ERASE'].includes(item.action)) continue;
    const id = resolveAddrId(item);
    if (id !== undefined && !/^[a-f0-9]{64}$/.test(id)) throw new Error('Invalid recovery identifier');
    const current = id && await runtime.store.get('CONTACT_META', id);
    if (item.action === 'ERASE') {
      await addErased(runtime, id, item.details.erase_mac, item.ts);
      erasedMacs.add(item.details.erase_mac);
      const fields = { ...contactFields, erased: true, blocked_all: true, blocked_topics: [] };
      if (id && (!current?.erased || current.attributes || current.pending_attributes)) await updateRecord(runtime, 'CONTACT_META', id, current, fields, current ? ['attributes', 'pending_attributes'] : []);
      await deleteDeliveryIndex(runtime, item.addr_id);
      if (id) erased.add(id);
      erasures += 1;
    } else {
      stops += 1;
      if (!id) continue;
      const topics = [...new Set([...(current?.blocked_topics ?? []), ...(item.details.scope === 'ALL' ? [] : [item.details.scope])])].sort();
      const all = current?.blocked_all === true || item.details.scope === 'ALL';
      const attributes = { ...(current?.attributes ?? {}) };
      if (all) delete attributes.name;
      if (!current || all !== current.blocked_all || JSON.stringify(topics) !== JSON.stringify(current.blocked_topics) || JSON.stringify(attributes) !== JSON.stringify(current.attributes)) {
        await updateRecord(runtime, 'CONTACT_META', id, current, { ...contactFields, blocked_all: all, blocked_topics: topics, ...(!current?.erased ? { attributes } : {}) });
      }
    }
  }
  if (erasedMacs.size) {
    const targets = [];
    for await (const contacts of contactPages(runtime)) {
      for (const contact of contacts) {
        const { addr_id: id } = await contactIdentity(runtime, contact.EmailAddress);
        if (!erased.has(id) && !erasedMacs.has(await eraseMatch(runtime, contact.EmailAddress))) continue;
        targets.push(contact.EmailAddress);
      }
    }
    // ページを読み終えてから消し、削除で一覧の続きが変わる影響を避ける。
    for (const email of targets) {
      // 照合値が現在の鍵でも一致することを確かめてSESの連絡先を消す。
      if (!await runtime.store.get('ERASED', await eraseMatch(runtime, email))) throw new Error('Erase audit mismatch');
      await eraseContactMetadata(runtime, email);
      try { await runtime.ses.deleteContact({ ContactListName: runtime.contactList, EmailAddress: email }); } catch (error) { if (error.name !== 'NotFoundException') throw error; }
      try { await runtime.ses.deleteSuppressedDestination({ EmailAddress: email }); } catch (error) { if (error.name !== 'NotFoundException') { await runtime.notify('ERASE_SUPPRESSION_FAILED', 'contact'); throw error; } }
    }
  }
  return { stops, erasures };
}
