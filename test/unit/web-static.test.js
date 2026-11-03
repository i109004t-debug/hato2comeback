import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';

const root = new URL('../../web/', import.meta.url);
const names = readdirSync(root, { recursive: true }).map((name) => name.replaceAll('\\', '/')).filter((name) => /\.(?:js|css|html)$/.test(name));
const read = (name) => readFileSync(new URL(name, root), 'utf8');
const html = read('index.html');

test('9.1 必須ファイル・画面テンプレート・UI-01〜11の項目が存在', () => {
  for (const name of ['index.html', 'callback.html', 'app.css', 'js/app.js', 'js/auth.js', 'js/api.js', 'js/dom.js', ...['send', 'contacts', 'history', 'settings'].map((name) => `js/views/${name}.js`)]) assert.ok(existsSync(new URL(name, root)), name);
  for (const id of ['login', 'send', 'contacts', 'history', 'settings', 'preview', 'confirm']) assert.match(html, new RegExp(`<template id="${id}-template">`));
  for (const attr of ['data-from', 'data-reply', 'name="topic"', 'name="subject"', 'name="body_text"', 'data-footer', 'data-preview', 'data-test', 'data-mode', 'data-at', 'data-primary', 'data-primary-reason', 'data-progress', 'data-next-at', 'data-pause', 'data-resume', 'data-cancel']) assert.ok(html.includes(attr), attr);
});

test('9.5・12.3 HTML文字列の挿入・評価・永続トークン保管を使わない', () => {
  for (const name of names) {
    const text = read(name);
    assert.doesNotMatch(text, /\b(?:innerHTML|outerHTML|insertAdjacentHTML|DOMParser|localStorage|indexedDB)\b|document\s*\.\s*write\s*\(|\beval\s*\(|new\s+Function\s*\(/, name);
  }
  assert.match(read('js/dom.js'), /textContent/);
  assert.match(read('js/dom.js'), /content\.firstElementChild\.cloneNode\(true\)/);
});

test('HTMLのテンプレート・フォーム・ラベルの開始終了と入れ子が対応する', () => {
  const voidTags = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
  for (const name of names.filter((name) => name.endsWith('.html'))) {
    const stack = [];
    for (const match of read(name).matchAll(/<(\/?)([A-Za-z][A-Za-z0-9-]*)\b[^>]*>/g)) {
      const [, closing, tag] = match;
      if (voidTags.has(tag)) continue;
      if (closing) assert.equal(stack.pop(), tag, `${name} ${match[0]}`);
      else stack.push(tag);
    }
    assert.deepEqual(stack, [], name);
  }
});

test('12.3 インラインスクリプト・スタイル・イベント属性と外部資源を読まない', () => {
  for (const name of names.filter((name) => name.endsWith('.html'))) {
    const text = read(name);
    assert.doesNotMatch(text, /\son[a-z]+\s*=|\sstyle\s*=|<style\b|javascript:|<base\b|<iframe\b|<object\b/i, name);
    for (const script of text.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
      assert.match(script[1], /type="module"/);
      assert.match(script[1], /src="\.\/js\/app\.js"/);
      assert.equal(script[2].trim(), '');
    }
    for (const attr of text.matchAll(/\b(?:src|href|action)="([^"]*)"/g)) {
      assert.doesNotMatch(attr[1], /^(?:[a-z]+:|\/\/)/i, `${name} ${attr[1]}`);
      if (!attr[1].startsWith('#')) assert.ok(existsSync(new URL(attr[1], root)), `${name} ${attr[1]}`);
    }
  }
  assert.doesNotMatch(read('app.css'), /@import|url\s*\(/i);
});

test('9.5 ESモジュールはweb内のファイルだけを読み込む', () => {
  for (const name of names.filter((name) => name.endsWith('.js'))) {
    const text = read(name);
    assert.doesNotMatch(text, /import\s*\(|require\s*\(/, name);
    for (const match of text.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)) {
      assert.match(match[1], /^\.\.?\//, name);
      const target = new URL(match[1], new URL(name, root));
      assert.ok(target.href.startsWith(root.href), name);
      assert.ok(existsSync(target), `${name} ${match[1]}`);
    }
    assert.doesNotMatch(text, /['"`]https?:\/\//i, name);
    if (!['js/auth.js', 'js/api.js', 'js/app.js'].includes(name)) assert.doesNotMatch(text, /\b(?:fetch|XMLHttpRequest|WebSocket|EventSource)\s*\(/);
  }
});

test('9.5 両HTMLはreferrerを抑制し、コールバックにインライン処理を置かない', () => {
  for (const name of ['index.html', 'callback.html']) assert.match(read(name), /<meta name="referrer" content="no-referrer">/);
  assert.match(read('js/app.js'), /historyApi\.replaceState\(null, '', '\/callback.html'\)/);
  assert.doesNotMatch(read('js/auth.js'), /id_token|cognito:groups/);
});

test('9.2 中止・要確認・完全削除は確認ダイアログを通る', () => {
  assert.match(read('js/views/send.js'), /name === 'cancel' && !await confirmDialog/);
  assert.match(read('js/views/send.js'), /confirmDialog\(q\('\[data-review-risk\]'/);
  assert.match(read('js/views/contacts.js'), /operation === 'erase' && !await confirmDialog/);
  assert.match(html, /data-close type="button" autofocus/);
});

test('web内の全ファイルはUTF-8・BOMなし・LF', () => {
  for (const name of names) {
    const bytes = readFileSync(new URL(name, root));
    assert.notDeepEqual([...bytes.subarray(0, 3)], [239, 187, 191], name);
    assert.doesNotThrow(() => new TextDecoder('utf-8', { fatal: true }).decode(bytes), name);
    assert.doesNotMatch(bytes.toString('utf8'), /\r/, name);
  }
});
