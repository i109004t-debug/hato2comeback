import { objectText } from './records.js';

export async function deliveryEvents(runtime, rid, { campaignId, type, limit = 200 } = {}) {
  const items = [];
  for await (const page of runtime.store.queryPages({ KeyConditionExpression: 'PK = :pk', ExpressionAttributeValues: { ':pk': { S: `ADDR#${rid}` } }, ScanIndexForward: false })) {
    for (const record of page.items) {
      if (Date.parse(record.occurred_at) < runtime.now() - 180 * 86400000 || campaignId && record.campaign_id !== campaignId || type && record.type !== type) continue;
      const { PK, SK, expires_at, ...value } = record;
      items.push(value);
      if (items.length >= limit) return items;
    }
  }
  return items;
}

export async function countAccepted(runtime, campaign) {
  const ids = new Set();
  for (const key of campaign.result_keys ?? []) {
    if (!new RegExp(`^results/${campaign.campaign_id}/[0-9]{5}-[0-9]{3}\\.jsonl$`).test(key)) throw new Error('Invalid result key');
    const text = await objectText(await runtime.s3.getObject({ Bucket: runtime.dataBucket, Key: key }));
    for (const row of text.trimEnd().split('\n').filter(Boolean).map((line) => JSON.parse(line))) if (row.r === 'UNKNOWN' && /^[a-f0-9]{64}$/.test(row.a ?? '')) ids.add(row.a);
  }
  let count = 0;
  for (const rid of ids) if ((await deliveryEvents(runtime, rid, { campaignId: campaign.campaign_id, type: 'Send', limit: 1 })).length) count += 1;
  return count;
}
