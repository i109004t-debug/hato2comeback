import test from 'node:test';
import assert from 'node:assert/strict';
import { createConfig, configDefaults, validateConfig } from '../../src/common/config.js';
import { createSecrets } from '../../src/common/secrets.js';

test('12.7 SSM設定JSONを5秒キャッシュし、変更の反映・参照の分離・同時取得を保証', async () => {
  let time = 0;
  let calls = 0;
  let enabled = true;
  const config = createConfig({ env: 'prod', now: () => time, ssm: { getParameter: async (input) => {
    calls += 1;
    assert.equal(input.Name, '/ht2/prod/config');
    return { Parameter: { Value: JSON.stringify({ sending_enabled: enabled }) } };
  } } });
  const [a, b] = await Promise.all([config.get(), config.get()]);
  assert.equal(calls, 1);
  assert.equal(a.sending_enabled, true);
  a.nonprod_allowlist.push('bad');
  b.reputation_alarms.length = 0;
  enabled = false;
  time = 4999;
  const cached = await config.get();
  assert.equal(cached.sending_enabled, true);
  assert.deepEqual(cached.nonprod_allowlist, []);
  assert.equal(cached.reputation_alarms.length, 2);
  time = 5000;
  assert.equal((await config.get()).sending_enabled, false);
  assert.equal(calls, 2);
});

test('12.7 設定の全既定値と安全側の欠落・不正値の扱い', () => {
  const config = validateConfig({}, 'prod');
  assert.equal(config.sending_enabled, false);
  assert.equal(config.max_rate_per_sec, 10);
  assert.equal(config.batch_size, 200);
  assert.equal(config.progress_every, 20);
  assert.equal(config.daily_send_cap, 1000);
  assert.equal(config.health_check_seconds, 60);
  assert.equal(config.auth_status_max_age_hours, 26);
  assert.equal(config.delivery_check_max_age_days, 90);
  assert.equal(config.event_log_stale_seconds, 900);
  assert.equal(configDefaults('dev').delivery_check_required, false);
  assert.deepEqual(validateConfig({ nonprod_allowlist: ['A.B@gmail.com', 'ab@googlemail.com'] }, 'stg').nonprod_allowlist, ['ab@gmail.com']);
  for (const input of [{ sending_enabled: 'true' }, { batch_size: 201 }, { progress_every: 21 }, { max_rate_per_sec: 0 }, { daily_send_cap: -1 }, { ses_rate_safety_factor: 1.1 }, { health_check_seconds: 61 }, { delivery_check_required: false }, { unknown: 1 }, { nonprod_allowlist: ['bad'] }, { reputation_alarms: [] }, null]) assert.throws(() => validateConfig(input, 'prod'), { code: 'CONFIGURATION_INVALID' });
});

test('13.7 復元の停止点検は5秒以内でも設定を取り直し、取得失敗を隠さない', async () => {
  let input = '{"sending_enabled":false}';
  const config = createConfig({ env: 'stg', now: () => 0, ssm: { getParameter: async () => {
    if (input instanceof Error) throw input;
    return { Parameter: { Value: input } };
  } } });
  assert.equal((await config.get()).sending_enabled, false);
  input = '{"sending_enabled":true}';
  assert.equal((await config.get({ force: true })).sending_enabled, true);
  input = new Error('SSM unavailable');
  await assert.rejects(config.get({ force: true }), /SSM unavailable/);
});

test('キャッシュ期限後の取得失敗・不正JSONに古い送信許可を返さない', async () => {
  let time = 0;
  let input = '{"sending_enabled":true}';
  const config = createConfig({ env: 'stg', now: () => time, ssm: { getParameter: async () => {
    if (input instanceof Error) throw input;
    return { Parameter: { Value: input } };
  } } });
  assert.equal((await config.get()).sending_enabled, true);
  time = 5000;
  input = new Error('ssm unavailable');
  await assert.rejects(config.get(), /ssm unavailable/);
  input = '{bad';
  await assert.rejects(config.get(), { code: 'CONFIGURATION_INVALID' });
  input = '{"sending_enabled":false}';
  assert.equal((await config.get()).sending_enabled, false);
});

test('12.7 シークレットは名前ごとに5分キャッシュ・同時取得を共有', async () => {
  let time = 0;
  let calls = 0;
  let current = 'current';
  const secrets = createSecrets({ env: 'prod', now: () => time, secrets: { getSecretValue: async (input) => {
    calls += 1;
    return { SecretString: JSON.stringify(input.SecretId.endsWith('address-hmac') ? { kid: 'k1', key: '1'.repeat(64) } : { current, previous: 'previous' }) };
  } } });
  const [a, b] = await Promise.all([secrets.get('origin-verify'), secrets.get('origin-verify')]);
  assert.equal(calls, 1);
  a.current = 'mutated';
  assert.equal(b.current, 'current');
  current = 'next';
  time = 49999;
  assert.equal((await secrets.get('origin-verify')).current, 'current');
  await secrets.get('address-hmac');
  assert.equal(calls, 2);
  time = 300000;
  assert.equal((await secrets.get('origin-verify')).current, 'next');
  assert.equal(calls, 3);
});

test('シークレットの不正JSON・鍵長を拒否し、期限後の障害で古い値を返さない', async () => {
  let time = 0;
  let text = '{"current":"ok"}';
  const secrets = createSecrets({ env: 'stg', now: () => time, secrets: { getSecretValue: async () => {
    if (text instanceof Error) throw text;
    return { SecretString: text };
  } } });
  await secrets.get('origin-verify');
  time = 300000;
  text = new Error('unavailable');
  await assert.rejects(secrets.get('origin-verify'), /unavailable/);
  for (const value of ['not-json', '{}', '{"current":""}', '{"current":"ok","extra":"bad"}']) {
    text = value;
    await assert.rejects(secrets.get('origin-verify'), { code: 'CONFIGURATION_INVALID' });
  }
  text = '{"key":"short"}';
  await assert.rejects(secrets.get('address-hmac'), { code: 'CONFIGURATION_INVALID' });
  await assert.rejects(secrets.get('unknown'), TypeError);
});

test('12.7 address-hmacは32文字以上のUTF-8文字列を復号せず保持する', async () => {
  for (const key of ['x'.repeat(32), 'a'.repeat(64), '鍵'.repeat(32), 'A'.repeat(43) + '=']) {
    const provider = createSecrets({ env: 'dev', secrets: { getSecretValue: async () => ({ SecretString: JSON.stringify({ kid: 'k1', key }) }) } });
    assert.equal((await provider.get('address-hmac')).key, key);
  }
  for (const key of ['', 'x'.repeat(31), '鍵'.repeat(31), null, 123]) {
    const provider = createSecrets({ env: 'dev', secrets: { getSecretValue: async () => ({ SecretString: JSON.stringify({ kid: 'k1', key }) }) } });
    await assert.rejects(provider.get('address-hmac'), { code: 'CONFIGURATION_INVALID' });
  }
});
