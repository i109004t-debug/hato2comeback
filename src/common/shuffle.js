import { createHmac } from 'node:crypto';

export function shuffleRecipients(items, campaignId, key) {
  if (!campaignId || !key) throw new TypeError('Campaign ID and HMAC key are required');
  const seed = createHmac('sha256', key).update(campaignId).digest();
  let counter = 0n;
  let block = Buffer.alloc(0);
  let offset = 0;
  const next = () => {
    if (offset === block.length) {
      const input = Buffer.alloc(8);
      input.writeBigUInt64BE(counter++);
      block = createHmac('sha256', seed).update(input).digest();
      offset = 0;
    }
    const value = block.readUInt32BE(offset);
    offset += 4;
    return value;
  };
  const result = [...items];
  for (let i = result.length - 1; i > 0; i -= 1) {
    const range = i + 1;
    const ceiling = Math.floor(2 ** 32 / range) * range;
    let value;
    do { value = next(); } while (value >= ceiling);
    const j = value % range;
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}
