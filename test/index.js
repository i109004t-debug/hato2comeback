import { readdirSync } from 'node:fs';

// Node.js 24で指定された `node --test test/` から全試験を読み込む。
const files = readdirSync(new URL('.', import.meta.url), { recursive: true })
  .filter((name) => name.endsWith('.test.js'))
  .sort();
for (const file of files) {
  await import(new URL(file.replaceAll('\\', '/'), import.meta.url));
}
