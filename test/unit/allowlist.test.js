import test from 'node:test';
import assert from 'node:assert/strict';
import { createConfig, validateConfig } from '../../src/common/config.js';

test('large nonproduction allowlist uses a private S3 object with a small SSM value', async () => {
  const addresses = Array.from({ length: 10000 }, (_, i) => `success+${i}@simulator.amazonses.com`);
  const input = { nonprod_allowlist_s3_key: 'allowlists/simulator.json' };
  const json = JSON.stringify(input);
  assert.ok(Buffer.byteLength(json) < 4096);
  assert.ok(Buffer.byteLength(JSON.stringify(addresses)) > 8192);
  let time = 0;
  let fail = false;
  let calls = 0;
  const config = createConfig({ env: 'stg', dataBucket: 'private-data', now: () => time,
    ssm: { getParameter: async () => ({ Parameter: { Value: json } }) },
    s3: { getObject: async (request) => {
      calls += 1;
      assert.deepEqual(request, { Bucket: 'private-data', Key: input.nonprod_allowlist_s3_key });
      if (fail) throw new Error('Unavailable');
      return { Body: (async function* () { const json = JSON.stringify(addresses); yield Buffer.from(json.slice(0, 200)); yield Buffer.from(json.slice(200)); })() };
    } },
  });
  const first = await config.get();
  assert.equal(first.nonprod_allowlist.length, 10000);
  first.nonprod_allowlist.length = 0;
  assert.equal((await config.get()).nonprod_allowlist.length, 10000);
  assert.equal(calls, 1);
  time = 30000;
  fail = true;
  await assert.rejects(config.get(), { code: 'CONFIGURATION_INVALID' });
});

test('external allowlists fail closed on production, path, type, count, bytes and SSM size', async () => {
  for (const key of ['elsewhere/a.json', 'allowlists/../a.json', 'allowlists//a.json', 'allowlists/a.txt', 's3://other/a.json']) {
    assert.throws(() => validateConfig({ nonprod_allowlist_s3_key: key }, 'dev'), { code: 'CONFIGURATION_INVALID' });
  }
  assert.throws(() => validateConfig({ nonprod_allowlist_s3_key: 'allowlists/a.json' }, 'prod'), { code: 'CONFIGURATION_INVALID' });
  assert.throws(() => validateConfig({ nonprod_allowlist_s3_key: 'allowlists/a.json', nonprod_allowlist: ['a@example.com'] }, 'dev'), { code: 'CONFIGURATION_INVALID' });
  for (const Body of ['{}', '["invalid"]', JSON.stringify(Array(20001).fill('a@example.com')), ' '.repeat(2 * 1024 * 1024 + 1), (async function* () { yield ' '.repeat(2 * 1024 * 1024); yield 'x'; })()]) {
    const config = createConfig({ env: 'dev', dataBucket: 'private', ssm: { getParameter: async () => ({ Parameter: { Value: '{"nonprod_allowlist_s3_key":"allowlists/a.json"}' } }) }, s3: { getObject: async () => ({ Body }) } });
    await assert.rejects(config.get(), { code: 'CONFIGURATION_INVALID' });
  }
  const config = createConfig({ env: 'dev', ssm: { getParameter: async () => ({ Parameter: { Value: JSON.stringify({ nonprod_allowlist: Array(300).fill('a@example.com') }) } }) } });
  await assert.rejects(config.get(), { code: 'CONFIGURATION_INVALID' });
});
