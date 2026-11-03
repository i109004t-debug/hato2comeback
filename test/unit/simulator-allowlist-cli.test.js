import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { validateConfig } from '../../src/common/config.js';

test('simulator generator creates a valid ten-thousand-address allowlist and refuses overwrites', () => {
  const parent = resolve(tmpdir());
  const directory = mkdtempSync(join(parent, 'postline-allowlist-'));
  const file = join(directory, 'allowlist.json');
  const script = fileURLToPath(new URL('../../scripts/create-simulator-allowlist.mjs', import.meta.url));
  const run = (count) => spawnSync(process.execPath, [script, '--count', String(count), '--output', file], { encoding: 'utf8' });
  try {
    assert.equal(run(20001).status, 1);
    assert.equal(run(10000).status, 0);
    const before = readFileSync(file, 'utf8');
    const addresses = JSON.parse(before);
    assert.equal(validateConfig({ nonprod_allowlist: addresses }, 'stg').nonprod_allowlist.length, 10000);
    assert.equal(new Set(addresses).size, 10000);
    assert.ok(addresses.every((address) => /^success\+postline\d+@simulator\.amazonses\.com$/.test(address)));
    assert.equal(run(1).status, 1);
    assert.equal(readFileSync(file, 'utf8'), before);
  } finally {
    assert.equal(dirname(resolve(directory)), parent);
    rmSync(directory, { recursive: true });
  }
});
