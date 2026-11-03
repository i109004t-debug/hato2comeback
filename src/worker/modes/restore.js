import { createExpressions, unmarshall } from '../../common/ddb.js';
import { allRecords, updateRecord, contactPages, timestamp, objectText } from '../../common/records.js';
import { AppError, invalid } from '../../common/http.js';
import { isIsoDateTime } from '../../common/validate.js';
import { assertSupportedSchema } from '../../common/schema.js';
import { auditArchiveKey, readAuditArchive } from '../../common/audit-archive.js';
import { objectPages, deleteDeliveryIndex } from '../../common/storage.js';
import { contactIdentity, eraseContactMetadata } from '../../common/contact-metadata.js';
import { eraseMatch } from '../../common/erase.js';
import { jstDate } from '../../common/time.js';

const terminal = (item) => ['COMPLETED', 'CANCELLED'].includes(item.status);
const active = ['SCHEDULED', 'QUEUED', 'SENDING', 'PAUSED'];
const startActions = new Set(['CAMPAIGNS_START', 'CAMPAIGNS_RESUME', 'CAMPAIGNS_REVIEW', 'RESUME', 'REVIEW_DECISION']);
const redoActions = new Set(['RECONSENT', 'CONTACTS_RECONSENT', 'SETTINGS_UPDATE']);

function point(event, runtime) {
  if (!isIsoDateTime(event.restore_point) || Date.parse(event.restore_point) > runtime.now()) throw invalid('restore_point');
  return new Date(event.restore_point).toISOString();
}

async function stopped(runtime) {
  if ((await runtime.config.get({ force: true })).sending_enabled !== false) throw new AppError('SENDING_DISABLED', 503, '復元の前に全体の停止スイッチを切ってください。');
}

// 復元元に対してはScan/GetItemだけを使い、書き込まない。
async function* sourceRows(runtime, table) {
  let cursor;
  const seen = new Set();
  do {
    const page = await runtime.ddb.scan({ TableName: table, ConsistentRead: true, ...(cursor ? { ExclusiveStartKey: cursor } : {}) });
    for (const item of page.Items ?? []) yield unmarshall(item);
    cursor = page.LastEvaluatedKey;
    if (cursor && Object.keys(cursor).length) {
      const token = JSON.stringify(cursor);
      if (seen.has(token)) throw new Error('Repeated restore cursor');
      seen.add(token);
    }
  } while (cursor && Object.keys(cursor).length);
}

async function archive(runtime, restorePoint, until) {
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

async function replace(runtime, item, current) {
  const expressions = createExpressions();
  const condition = current ? Number.isSafeInteger(current.version) ? expressions.equals('version', current.version) : `attribute_exists(PK) AND ${expressions.notExists('version')}` : 'attribute_not_exists(PK)';
  await runtime.store.put({ ...item, version: (current?.version ?? 0) + 1, updated_at: timestamp(runtime) }, condition, expressions.attributes());
}

async function addErased(runtime, addrId, mac, at) {
  if (!/^[a-f0-9]{64}$/.test(mac ?? '') || addrId !== undefined && !/^[a-f0-9]{64}$/.test(addrId)) throw new Error('Invalid erase audit');
  if (!await runtime.store.get('ERASED', mac)) {
    try { await runtime.store.put({ PK: 'ERASED', SK: mac, ...(addrId ? { addr_id: addrId } : {}), erased_at: at }); } catch (error) {
      if (error.name !== 'ConditionalCheckFailedException') throw error;
    }
  }
}

async function replay(runtime, items) {
  let stops = 0;
  let erasures = 0;
  const erased = new Set();
  for (const item of items) {
    if (!['CONTACT_STOP', 'ERASE'].includes(item.action)) continue;
    if (!/^[a-f0-9]{64}$/.test(item.addr_id ?? '') || !item.details?.operation || !/^(?:ALL|[a-z0-9_]{1,20})$/.test(item.details.scope ?? '')) throw new Error('Incomplete restore audit');
    const current = await runtime.store.get('CONTACT_META', item.addr_id);
    if (item.action === 'ERASE') {
      await addErased(runtime, item.addr_id, item.details.erase_mac, item.ts);
      const fields = { erased: true, blocked_all: true, blocked_topics: [] };
      if (!current?.erased || current.attributes || current.pending_attributes) await updateRecord(runtime, 'CONTACT_META', item.addr_id, current, fields, current ? ['attributes', 'pending_attributes'] : []);
      await deleteDeliveryIndex(runtime, item.addr_id);
      erased.add(item.addr_id);
      erasures += 1;
    } else {
      const topics = [...new Set([...(current?.blocked_topics ?? []), ...(item.details.scope === 'ALL' ? [] : [item.details.scope])])].sort();
      const all = current?.blocked_all === true || item.details.scope === 'ALL';
      const attributes = { ...(current?.attributes ?? {}) };
      if (all) delete attributes.name;
      if (!current || all !== current.blocked_all || JSON.stringify(topics) !== JSON.stringify(current.blocked_topics) || JSON.stringify(attributes) !== JSON.stringify(current.attributes)) {
        await updateRecord(runtime, 'CONTACT_META', item.addr_id, current, { blocked_all: all, blocked_topics: topics, ...(!current?.erased ? { attributes } : {}) });
      }
      stops += 1;
    }
  }
  if (erased.size) {
    const targets = [];
    for await (const contacts of contactPages(runtime)) {
      for (const contact of contacts) {
        const { addr_id: id } = await contactIdentity(runtime, contact.EmailAddress);
        if (!erased.has(id)) continue;
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

async function authCheck(runtime) {
  const current = await runtime.store.get('SETTINGS', 'AUTH_STATUS');
  await updateRecord(runtime, 'SETTINGS', 'AUTH_STATUS', current, { status: 'UNKNOWN', checked_at: '', attempted_at: timestamp(runtime), reason_codes: ['AUTH_CHECK_STALE'] });
  runtime.precheck.invalidate();
  const response = await runtime.lambda.invoke({ FunctionName: runtime.workerFunctionArn, InvocationType: 'Event', Payload: Buffer.from('{"mode":"auth-check"}') });
  if (response.StatusCode !== 202) throw new Error('Auth check not accepted');
}

export async function restoreApply(event, runtime) {
  const restorePoint = point(event, runtime);
  if (!new RegExp(`^ht2-${runtime.env}-restore-[0-9]{12}$`).test(event.source_table ?? '') || !Array.isArray(event.types) || !event.types.length || event.types.some((type) => !['CONTACT_META', 'ERASED', 'CAMPAIGN', 'SETTINGS', 'SETTINGS/ORG', 'IMPORT', 'DAILY'].includes(type))) throw invalid('restore');
  await stopped(runtime);
  const restoreId = event.source_table.slice(-12);
  const stateKey = `RESTORE#${restoreId}`;
  const previous = await runtime.store.get('SETTINGS', stateKey);
  const types = [...new Set(event.types.map((type) => type === 'SETTINGS' ? 'SETTINGS/ORG' : type))].sort();
  if (previous && (previous.restore_point !== restorePoint || JSON.stringify(previous.types) !== JSON.stringify(types))) throw new AppError('STATE_CONFLICT', 409, '同じ復元IDの入力が異なります。');
  if (previous?.applied) return { status: 'APPLIED', restore_id: restoreId };
  const until = previous?.until ?? timestamp(runtime);
  const audits = await archive(runtime, restorePoint, until);
  const rows = [];
  for await (const item of sourceRows(runtime, event.source_table)) rows.push(item);
  if (types.includes('CONTACT_META')) {
    const secret = await runtime.secrets.get('address-hmac');
    if (rows.some((item) => item.PK === 'CONTACT_META' && item.kid && item.kid !== secret.kid)) throw new AppError('STATE_CONFLICT', 409, '復元元と宛先の鍵の版が異なります。鍵の入れ替えの復旧手順を確認してください。');
  }
  const tombstones = [...rows.filter((row) => row.PK === 'ERASED')];
  for await (const item of allRecords(runtime, 'ERASED')) tombstones.push(item);
  for (const audit of audits.filter((item) => item.action === 'ERASE')) tombstones.push({ SK: audit.details?.erase_mac, addr_id: audit.addr_id });
  const erasedIds = new Set(tombstones.map((item) => item.addr_id).filter(Boolean));
  const unidentified = tombstones.some((item) => !item.addr_id);
  let state = previous ?? await updateRecord(runtime, 'SETTINGS', stateKey, undefined, { restore_point: restorePoint, types, until, source_table: event.source_table });
  if (types.includes('ERASED')) for (const item of rows.filter((row) => row.PK === 'ERASED')) await addErased(runtime, item.addr_id, item.SK, item.erased_at ?? restorePoint);
  for (const item of rows) {
    const type = item.PK === 'SETTINGS' && item.SK === 'ORG' ? 'SETTINGS/ORG' : item.PK;
    if (type === 'ERASED' || !types.includes(type) || type === 'SETTINGS') continue;
    const current = await runtime.store.get(item.PK, item.SK);
    if (type === 'CONTACT_META') {
      const erased = current?.erased === true || item.erased === true || erasedIds.has(item.SK);
      const merged = { ...item, blocked_all: erased || unidentified || current?.blocked_all === true || item.blocked_all === true, blocked_topics: [...new Set([...(item.blocked_topics ?? []), ...(current?.blocked_topics ?? [])])].sort(), erased };
      if (erased || unidentified) { delete merged.attributes; delete merged.pending_attributes; }
      if (merged.blocked_all && merged.attributes) { merged.attributes = { ...merged.attributes }; delete merged.attributes.name; }
      await replace(runtime, merged, current);
    } else if (type === 'CAMPAIGN') {
      if (current && terminal(current)) continue;
      assertSupportedSchema(item); assertSupportedSchema(current);
      await replace(runtime, { ...item, status: 'NEEDS_REVIEW', review: { reason: 'RESTORED', restore_id: restoreId } }, current);
    } else if (type === 'DAILY') {
      await updateRecord(runtime, 'DAILY', item.SK, current, { reserved_attempts: Math.max(current?.reserved_attempts ?? 0, item.reserved_attempts ?? 0) });
    } else {
      if (type === 'IMPORT') { assertSupportedSchema(item); assertSupportedSchema(current); }
      await replace(runtime, item, current);
    }
  }
  await replay(runtime, audits);
  if (types.includes('SETTINGS/ORG')) await authCheck(runtime);
  state = await updateRecord(runtime, 'SETTINGS', stateKey, state, { applied: true, unidentified_erased: unidentified });
  return { status: 'APPLIED', restore_id: restoreId };
}

async function executions(runtime) {
  let token;
  const seen = new Set();
  const items = [];
  do {
    const page = await runtime.sfn.listExecutions({ stateMachineArn: runtime.stateMachineArn, ...(token ? { nextToken: token } : {}) });
    if (!Array.isArray(page.executions)) throw new Error('Invalid executions response');
    items.push(...page.executions);
    token = page.nextToken;
    if (token && seen.has(token)) throw new Error('Repeated execution cursor');
    if (token) seen.add(token);
  } while (token);
  return items;
}

function executionCampaign(item) {
  return /^([0-9A-HJKMNP-TV-Z]{26})(?:-(?:r[0-9]+|s[0-9]+))?$/.exec(item.name ?? '')?.[1];
}

export async function restoreCheck(event, runtime) {
  const restorePoint = point(event, runtime);
  await stopped(runtime);
  let applyState;
  for await (const item of allRecords(runtime, 'SETTINGS')) if (item.SK.startsWith('RESTORE#') && item.restore_point === restorePoint && item.source_table && (!applyState || item.SK > applyState.SK)) applyState = item;
  const restoreId = applyState?.source_table.slice(-12) ?? restorePoint.replace(/[-:T]/g, '').slice(0, 12);
  const key = `restore-reports/${restoreId}.json`;
  let state = await runtime.store.get('SETTINGS', `RESTORE_CHECK#${restoreId}`);
  if (state?.restore_point && state.restore_point !== restorePoint) throw new AppError('STATE_CONFLICT', 409, '復元IDが重複しています。');
  if (state?.complete) return JSON.parse(await objectText(await runtime.s3.getObject({ Bucket: runtime.dataBucket, Key: key })));
  const until = state?.until ?? timestamp(runtime);
  state ??= await updateRecord(runtime, 'SETTINGS', `RESTORE_CHECK#${restoreId}`, undefined, { restore_point: restorePoint, until });
  const audits = await archive(runtime, restorePoint, until);
  const report = { restore_id: restoreId, restore_point: restorePoint, checked_at: until, campaigns: [], reapplied: {}, redo: audits.filter((item) => redoActions.has(item.action)).map(({ action, ts, target }) => ({ action, ts, target })), warnings: [] };
  const list = await executions(runtime);
  const started = new Set(list.filter((item) => new Date(item.startDate).toISOString() > restorePoint).map(executionCampaign).filter(Boolean));
  for (const item of audits) if (startActions.has(item.action) && /^[0-9A-HJKMNP-TV-Z]{26}$/.test(item.target)) started.add(item.target);
  for await (let campaign of allRecords(runtime, 'CAMPAIGN')) {
    if (terminal(campaign)) continue;
    assertSupportedSchema(campaign);
    if (campaign.restore_check?.restore_id === restoreId) {
      report.campaigns.push(campaign.restore_check);
      continue;
    }
    let status;
    if (campaign.status === 'SCHEDULED' || campaign.review?.reason === 'RESTORED' && campaign.schedule_name) {
      const name = campaign.schedule_name ?? `ht2-${campaign.start_execution_name ?? campaign.campaign_id}`;
      // 日次処理や別の配信の予約を消さない。
      if (!new RegExp(`^ht2-${campaign.campaign_id}(?:-s[0-9]+)?$`).test(name)) throw new Error('Invalid campaign schedule');
      try {
        await runtime.scheduler.getSchedule({ Name: name, GroupName: runtime.scheduleGroup });
        // 削除の応答を失った場合は、再実行時に要確認へ倒す。
        await runtime.scheduler.deleteSchedule({ Name: name, GroupName: runtime.scheduleGroup });
        status = campaign.status === 'SCHEDULED' ? 'APPROVED' : 'NEEDS_REVIEW';
      } catch (error) { if (error.name !== 'ResourceNotFoundException') throw error; status = 'NEEDS_REVIEW'; }
    } else if (active.includes(campaign.status)) status = 'NEEDS_REVIEW';
    if (started.has(campaign.campaign_id)) status = 'NEEDS_REVIEW';
    if (!status && campaign.review?.reason === 'RESTORED') status = 'NEEDS_REVIEW';
    if (!status) continue;
    const change = { restore_id: restoreId, campaign_id: campaign.campaign_id, from: campaign.status, to: status };
    campaign = await updateRecord(runtime, 'CAMPAIGN', campaign.campaign_id, campaign, { status, restore_check: change, ...(status === 'NEEDS_REVIEW' ? { review: { reason: 'RESTORED', restore_id: restoreId } } : {}) }, ['task_token', 'schedule_name', 'scheduled_at']);
    report.campaigns.push(change);
  }
  // 予約削除と競合して開始した実行ももう一度拾う。
  const after = await executions(runtime);
  for (const item of after.filter((item) => new Date(item.startDate).toISOString() > restorePoint)) {
    const id = executionCampaign(item);
    const campaign = id && await runtime.store.get('CAMPAIGN', id);
    if (!campaign || terminal(campaign) || campaign.review?.reason === 'RESTORED') continue;
    const change = { restore_id: restoreId, campaign_id: id, from: campaign.restore_check?.from ?? campaign.status, to: 'NEEDS_REVIEW' };
    await updateRecord(runtime, 'CAMPAIGN', id, campaign, { status: 'NEEDS_REVIEW', review: { reason: 'RESTORED', restore_id: restoreId }, restore_check: change }, ['task_token']);
    report.campaigns = report.campaigns.filter((entry) => entry.campaign_id !== id).concat(change);
  }
  report.reapplied = await replay(runtime, audits);
  const account = await runtime.ses.getAccount({});
  const sent = account.SendQuota?.SentLast24Hours;
  if (!Number.isFinite(sent) || sent < 0) throw new Error('Invalid SES quota');
  const day = jstDate(runtime.now());
  const daily = await runtime.store.get('DAILY', day);
  if (!daily || daily.reserved_attempts < sent) await updateRecord(runtime, 'DAILY', day, daily, { reserved_attempts: Math.max(daily?.reserved_attempts ?? 0, Math.ceil(sent)) });
  if (!after.some((item) => item.status === 'RUNNING')) {
    const held = await runtime.lock.get();
    if (held?.owner) await runtime.lock.release(held.owner);
  } else report.warnings.push('RUNNING_EXECUTIONS');
  if (applyState?.unidentified_erased) report.warnings.push('UNIDENTIFIED_ERASED_ATTRIBUTES_BLOCKED');
  await authCheck(runtime);
  report.campaigns.sort((a, b) => a.campaign_id.localeCompare(b.campaign_id));
  await runtime.s3.putObject({ Bucket: runtime.dataBucket, Key: key, ContentType: 'application/json', Body: JSON.stringify(report) });
  await runtime.notify('RESTORE_CHECK_COMPLETED', restoreId);
  await updateRecord(runtime, 'SETTINGS', state.SK, state, { complete: true });
  return report;
}
