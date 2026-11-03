import { AppError } from './http.js';
import { now as defaultNow } from './time.js';

function validateSecret(name, value) {
  const fail = () => { throw new AppError('CONFIGURATION_INVALID', 503, '秘密情報の形式を確認してください。'); };
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
  if (name === 'origin-verify') {
    if (Object.keys(value).some((key) => !['current', 'previous'].includes(key)) || typeof value.current !== 'string' || !value.current || (value.previous !== undefined && typeof value.previous !== 'string')) fail();
  } else if (Object.keys(value).length !== 1 || typeof value.key !== 'string' || Buffer.from(value.key, 'base64').length !== 32 || Buffer.from(value.key, 'base64').toString('base64') !== value.key) fail();
  return value;
}

export function createSecrets({ secrets, env, now = defaultNow }) {
  if (!['dev', 'stg', 'prod'].includes(env)) throw new TypeError('Invalid environment');
  const cache = new Map();
  const pending = new Map();
  return {
    async get(name) {
      if (!['origin-verify', 'erase-hmac'].includes(name)) throw new TypeError('Unknown secret');
      const hit = cache.get(name);
      if (hit && now() < hit.expires) return structuredClone(hit.value);
      if (!pending.has(name)) {
        const started = now();
        pending.set(name, (async () => {
          const response = await secrets.getSecretValue({ SecretId: `/postline/${env}/${name}` });
          let value;
          try {
            const text = response.SecretString ?? new TextDecoder('utf-8', { fatal: true }).decode(response.SecretBinary);
            value = JSON.parse(text);
          } catch { throw new AppError('CONFIGURATION_INVALID', 503, '秘密情報の形式を確認してください。'); }
          value = validateSecret(name, value);
          cache.set(name, { value, expires: started + 300000 });
          return value;
        })());
      }
      try { return structuredClone(await pending.get(name)); } finally { pending.delete(name); }
    },
  };
}
