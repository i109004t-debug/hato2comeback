import { normalizeEmail } from './email.js';
import { AppError } from './http.js';

export async function eraseMatch(runtime, email) {
  try {
    const result = await runtime.kms.generateMac({ KeyId: runtime.eraseMacKeyId, MacAlgorithm: 'HMAC_SHA_256', Message: Buffer.from(normalizeEmail(email).email, 'utf8') });
    if (!(result.Mac instanceof Uint8Array) || result.Mac.length !== 32) throw new Error('Invalid MAC');
    return Buffer.from(result.Mac).toString('hex');
  } catch {
    throw new AppError('ERASE_CHECK_UNAVAILABLE', 503, '完全削除の記録と照合できません。');
  }
}

export async function isErased(runtime, email) {
  return Boolean(await runtime.store.get('ERASED', await eraseMatch(runtime, email)));
}
