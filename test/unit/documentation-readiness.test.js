import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { configDefaults, validateConfig } from '../../src/common/config.js';
import { validateImportCsv } from '../../src/common/csv.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const guides = ['README.md', 'docs/AWS導入手順書.md', 'docs/利用者操作手順書.md', 'docs/構築手順書.md', 'docs/運用手順書.md'];
const read = (path) => readFileSync(resolve(root, path), 'utf8');

test('onboarding links and the deployed quick-help assets resolve locally', () => {
  for (const file of guides) {
    for (const match of read(file).matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
      const destination = match[1].split('#')[0];
      if (!destination || /^[a-z]+:/i.test(destination)) continue;
      assert.ok(existsSync(resolve(root, dirname(file), destination)), `${file}: ${destination}`);
    }
  }
  for (const match of read('web/help.html').matchAll(/(?:href|src)="([^"]+)"/g)) {
    if (match[1].startsWith('#')) continue;
    assert.ok(!/^[a-z]+:/i.test(match[1]), 'help must not load external assets');
    assert.ok(existsSync(resolve(root, 'web', match[1])), match[1]);
  }
});

test('the user-guide CSV example passes the actual import validator', () => {
  const csv = read('docs/利用者操作手順書.md').match(/```csv\r?\n([\s\S]*?)```/)?.[1];
  assert.ok(csv);
  const result = validateImportCsv(csv, { topics: ['kaiho', 'event'], importId: 'documentation-example', now: () => Date.parse('2026-11-03T00:00:00Z') });
  assert.equal(result.rows.length, 2);
  assert.deepEqual(result.rejected, []);
  assert.deepEqual(result.rows[1].topics, ['kaiho', 'event']);
});

test('the documented T-33 local commands produce importable batches and preserve safety settings', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'postline-docs-'));
  try {
    mkdirSync(join(workspace, 'build'));
    const original = { ...configDefaults('stg'), daily_send_cap: 4321, max_rate_per_sec: 3, sending_enabled: false };
    writeFileSync(join(workspace, 'build/config.stg.json'), JSON.stringify(original));
    execFileSync(process.execPath, [resolve(root, 'scripts/create-simulator-allowlist.mjs'), '--count', '10000', '--output', 'build/simulator-allowlist.json'], { cwd: workspace });
    const snippets = [...read('docs/構築手順書.md').matchAll(/node --input-type=module <<'JS'\r?\n([\s\S]*?)\r?\nJS/g)].map((match) => match[1]);
    const configSnippet = snippets.find((source) => source.includes("const path = 'build/config.stg.json'"));
    const csvSnippet = snippets.find((source) => source.includes("const addresses = JSON.parse(readFileSync('build/simulator-allowlist.json'"));
    assert.ok(configSnippet && csvSnippet, 'executable setup examples are required');
    for (const source of [configSnippet, csvSnippet]) execFileSync(process.execPath, ['--input-type=module'], { input: source, cwd: workspace });
    const next = JSON.parse(readFileSync(join(workspace, 'build/config.stg.json'), 'utf8'));
    assert.deepEqual(validateConfig(next, 'stg'), { ...original, nonprod_allowlist_s3_key: 'allowlists/simulator.json' });
    assert.ok(Buffer.byteLength(JSON.stringify(next)) < 4096);
    let total = 0;
    for (const part of [1, 2]) {
      const csv = readFileSync(join(workspace, `build/simulator-${part}.csv`), 'utf8');
      const result = validateImportCsv(csv, { topics: ['kaiho'], importId: `documentation-${part}` });
      assert.deepEqual(result.rejected, []);
      assert.equal(result.rows.length, 5000);
      total += result.rows.length;
    }
    assert.equal(total, 10000);
  } finally {
    assert.ok(resolve(workspace).startsWith(resolve(tmpdir()) + (process.platform === 'win32' ? '\\' : '/')));
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('the documented restore verification rejects an incomplete or mismatched snapshot', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'postline-docs-restore-'));
  try {
    const directory = join(workspace, 'build/restore-prod-2026-12-01');
    mkdirSync(directory, { recursive: true });
    const data = gzipSync('{}\n');
    writeFileSync(join(directory, 'contacts.jsonl.gz'), data);
    const manifest = { complete: true, attributes_missing: 0, bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') };
    const source = [...read('docs/運用手順書.md').matchAll(/node --input-type=module <<'JS'\r?\n([\s\S]*?)\r?\nJS/g)].map((match) => match[1]).find((text) => text.includes('Backup integrity verified'));
    assert.ok(source);
    const verify = (value) => {
      writeFileSync(join(directory, 'contacts.manifest.json'), JSON.stringify(value));
      return execFileSync(process.execPath, ['--input-type=module'], { input: source, cwd: workspace, stdio: ['pipe', 'pipe', 'pipe'] }).toString();
    };
    assert.match(verify(manifest), /Backup integrity verified/);
    assert.throws(() => verify({ ...manifest, complete: false }));
    assert.throws(() => verify({ ...manifest, sha256: '0'.repeat(64) }));
    assert.throws(() => verify({ ...manifest, bytes: data.length + 1 }));
  } finally {
    assert.ok(resolve(workspace).startsWith(resolve(tmpdir()) + (process.platform === 'win32' ? '\\' : '/')));
    rmSync(workspace, { recursive: true, force: true });
  }
});
