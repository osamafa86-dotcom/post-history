import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { contrastRatio, checkFile } from './contrast-check.mjs';

test('white on logo teal fails as body text', () => {
  const r = contrastRatio('#FFFFFF', '#5CB0BE');
  assert.ok(r < 4.5 && r > 2, `got ${r}`);
});

test('deep ink on logo teal passes as body text', () => {
  assert.ok(contrastRatio('#0B1F26', '#5CB0BE') >= 4.5);
});

test('white on deep teal passes as large text', () => {
  assert.ok(contrastRatio('#FFFFFF', '#0E7C86') >= 3);
});

test('black on white is 21:1', () => {
  assert.equal(Math.round(contrastRatio('#000', '#FFFFFF') * 100) / 100, 21);
});

test('checkFile reports failing pairs by role', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cc-'));
  const f = join(dir, 'x.html');
  writeFileSync(f, `<html><script type="application/json" id="tokens">${JSON.stringify({ pairs: [
    { fg: '#FFFFFF', bg: '#5CB0BE', role: 'text', name: 'bad' },
    { fg: '#FFFFFF', bg: '#2E8F9C', role: 'ui', name: 'ok-ui' },
    { fg: '#0B1F26', bg: '#5CB0BE', role: 'text', name: 'ok' },
  ] })}</script></html>`);
  const res = checkFile(f);
  assert.equal(res.ok, false);
  assert.deepEqual(res.failures.map((p) => p.name), ['bad']);
});

test('checkFile fails when the tokens block is missing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cc-'));
  const f = join(dir, 'y.html');
  writeFileSync(f, '<html></html>');
  assert.throws(() => checkFile(f), /tokens/);
});

test('checkTokens resolves semantic refs per mode and reports failing pairs', async () => {
  const { checkTokens } = await import('./contrast-check.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'cc-'));
  const f = join(dir, 't.json');
  writeFileSync(f, JSON.stringify({
    color: {
      neutral: { 0: { $type: 'color', $value: '#FFFFFF' }, 900: { $type: 'color', $value: '#0D1524' } },
      brand: { 300: { $type: 'color', $value: '#5CB0BE' } },
      bg: { base: { $type: 'color', $value: { light: '{color.neutral.0}', dark: '{color.neutral.900}' } } },
      text: {
        primary: { $type: 'color', $value: { light: '{color.neutral.900}', dark: '{color.neutral.0}' } },
        link: { $type: 'color', $value: { light: '{color.brand.300}', dark: '{color.brand.300}' } },
      },
    },
    $extensions: { 'v2.contrastPairs': [['color.text.primary', 'color.bg.base', 'text'], ['color.text.link', 'color.bg.base', 'text']] },
  }));
  const res = checkTokens(f);
  assert.equal(res.ok, false);
  assert.equal(res.total, 4);
  assert.deepEqual(res.failures.map((p) => p.name), ['light color.text.link on color.bg.base']);
});

test('an unknown role is an error, not a silent pass', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cc-'));
  const f = join(dir, 'r.html');
  writeFileSync(f, `<html><script type="application/json" id="tokens">${JSON.stringify({ pairs: [{ fg: '#FFFFFF', bg: '#FFFFFF', role: 'txt', name: 'typo' }] })}</script></html>`);
  assert.throws(() => checkFile(f), /role/);
});
