import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeEmail, maskEmail, encodeRfc2047, formatFrom } from '../../src/common/email.js';

test('4.2 大文字小文字・前後空白とGmailのorig', () => {
  assert.deepEqual(normalizeEmail('  Member@Example.COM  '), { email: 'member@example.com' });
  assert.deepEqual(normalizeEmail(' Taro.Yamada+fc@Googlemail.com '), { email: 'taroyamada@gmail.com', orig: 'Taro.Yamada+fc@Googlemail.com' });
  assert.deepEqual(normalizeEmail('a.b+c@gmail.com'), { email: 'ab@gmail.com', orig: 'a.b+c@gmail.com' });
  assert.deepEqual(normalizeEmail('ab@gmail.com'), { email: 'ab@gmail.com' });
  assert.deepEqual(normalizeEmail('A.B+c@workspace.example'), { email: 'a.b+c@workspace.example' });
});

for (const value of ['.a@example.com', 'a.@example.com', 'a..b@example.com', 'a..b@gmail.com']) {
  test(`4.2 NONSTANDARD_ADDRESS: ${value}`, () => {
    assert.throws(() => normalizeEmail(value), { code: 'NONSTANDARD_ADDRESS', status: 422 });
  });
}

test('4.2 ASCII・atext・Punycode・ドメインの境界', () => {
  assert.equal(normalizeEmail("a!#$%&'*+-/=?^_`{|}~@xn--r8jz45g.xn--zckzah").email, "a!#$%&'*+-/=?^_`{|}~@xn--r8jz45g.xn--zckzah");
  const domain = `${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(61)}`;
  const longest = `${'a'.repeat(64)}@${domain}`;
  assert.equal(longest.length, 254);
  assert.equal(normalizeEmail(longest).email, longest);
  for (const value of [longest + 'c', `${'a'.repeat(65)}@example.com`, `a@${'x'.repeat(64)}.com`, 'a@-example.com', 'a@example-.com', 'a@example.123', 'a@example..com', 'a@localhost', 'a@@example.com', 'あ@example.com', 'K@example.com', 'a@例.jp', 'a b@example.com', '"ab"@example.com', '+tag@gmail.com', '', null, 'a\r\nb@example.com']) {
    assert.throws(() => normalizeEmail(value), { code: 'INVALID_ADDRESS' });
  }
});

test('9.3 閲覧者用の伏せ字', () => {
  assert.equal(maskEmail('abcdefz@example.com'), 'a***z@example.com');
  assert.equal(maskEmail('a@example.com'), 'a***@example.com');
  assert.equal(maskEmail('ab@example.com'), 'a***b@example.com');
});

test('6.8 RFC 2047: 各語75文字以下でUTF-8を文字境界で分割', () => {
  for (const source of ['日本語の表示名', 'あ'.repeat(64), '😀あA𠮷'.repeat(60), 'a'.repeat(201), '']) {
    const encoded = encodeRfc2047(source);
    assert.doesNotMatch(encoded, /[\r\n]/);
    const words = encoded ? encoded.split(' ') : [];
    let decoded = '';
    for (const word of words) {
      assert.ok(word.length <= 75);
      assert.match(word, /^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/);
      decoded += new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(word.slice(10, -2), 'base64'));
    }
    assert.equal(decoded, source);
  }
  assert.throws(() => encodeRfc2047('name\r\nBcc: other'), { code: 'INVALID_REQUEST' });
  assert.throws(() => encodeRfc2047('\ud800'), { code: 'INVALID_REQUEST' });
});

test('6.8 Fromは日本語をBエンコードし、ASCII表示名を引用', () => {
  assert.equal(formatFrom('HT2', 'info', 'example.com'), '"HT2" <info@example.com>');
  assert.equal(formatFrom('Post\\line', 'info', 'example.com'), '"Post\\\\line" <info@example.com>');
  assert.match(formatFrom('会報', 'info', 'example.com'), /^=\?UTF-8\?B\?.+\?= <info@example.com>$/);
  for (const name of ['x\n', 'x<', 'x>', 'x"', '{{x}}', '', 'a'.repeat(65)]) assert.throws(() => formatFrom(name, 'info', 'example.com'));
});
