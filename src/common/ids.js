import { randomBytes } from 'node:crypto';
import { now as defaultNow } from './time.js';

const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function createUlid({ now = defaultNow, random = randomBytes } = {}) {
  let lastTime = -1;
  let lastRandom = 0n;
  return () => {
    const current = now();
    if (!Number.isInteger(current) || current < 0 || current > 0xffffffffffff) throw new RangeError('Invalid ULID timestamp');
    const time = Math.max(current, lastTime);
    let entropy;
    if (time === lastTime) {
      entropy = lastRandom + 1n;
      if (entropy >= (1n << 80n)) throw new RangeError('ULID entropy overflow');
    } else {
      const bytes = random(10);
      if (bytes.length !== 10) throw new RangeError('ULID requires 10 random bytes');
      entropy = BigInt(`0x${Buffer.from(bytes).toString('hex')}`);
    }
    let value = (BigInt(time) << 80n) | entropy;
    let id = '';
    for (let i = 0; i < 26; i += 1) {
      id = alphabet[Number(value & 31n)] + id;
      value >>= 5n;
    }
    lastTime = time;
    lastRandom = entropy;
    return id;
  };
}

export const ulid = createUlid();
export const isUlid = (value) => typeof value === 'string' && /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(value);
