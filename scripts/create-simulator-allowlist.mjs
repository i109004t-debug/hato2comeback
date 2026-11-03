import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
const options = {};
for (let i = 0; i < args.length; i += 2) {
  if (!['--count', '--output'].includes(args[i]) || !args[i + 1] || options[args[i]]) throw new Error('Usage: node scripts/create-simulator-allowlist.mjs --count 10000 --output build/simulator-allowlist.json');
  options[args[i]] = args[i + 1];
}
const count = Number(options['--count']);
if (!Number.isSafeInteger(count) || count < 1 || count > 20000 || !options['--output']) throw new Error('Count must be 1..20000 and --output is required');
const addresses = Array.from({ length: count }, (_, index) => `success+postline${String(index + 1).padStart(5, '0')}@simulator.amazonses.com`);
const output = resolve(options['--output']);
// 既存のファイルを上書きせず、AWSには接続しない。
await writeFile(output, JSON.stringify(addresses) + '\n', { flag: 'wx', encoding: 'utf8' });
process.stdout.write(`Created ${count} simulator addresses: ${output}\n`);
