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
