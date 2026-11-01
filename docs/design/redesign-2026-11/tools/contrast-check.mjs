// فحص تباين أزواج الألوان المعلنة في نموذج الاتجاه (WCAG 2.1).
// الاستعمال: node contrast-check.mjs <file.html> [...]
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const MIN = { text: 4.5, large: 3, ui: 3 };
const need = (p) => { if (!(p.role in MIN)) throw new Error(`unknown role «${p.role}» in ${p.name ?? p.fg}`); return MIN[p.role]; };

function channel(v) {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function luminance(hex) {
  let h = hex.replace('#', '');
  if (h.length === 3) h = [...h].map((x) => x + x).join('');
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function contrastRatio(fgHex, bgHex) {
  const [a, b] = [luminance(fgHex), luminance(bgHex)].sort((x, y) => y - x);
  return (a + 0.05) / (b + 0.05);
}

export function checkFile(path) {
  const html = readFileSync(path, 'utf8');
  const m = html.match(/<script type="application\/json" id="tokens">([\s\S]*?)<\/script>/);
  if (!m) throw new Error(`${path}: no tokens block`);
  const { pairs } = JSON.parse(m[1]);
  const failures = pairs
    .map((p) => ({ ...p, ratio: contrastRatio(p.fg, p.bg) }))
    .filter((p) => p.ratio < need(p));
  return { ok: failures.length === 0, failures, total: pairs.length };
}

// ملف رموز W3C: يحلّ المراجع لكل وضع ويفحص الأزواج المعلنة في $extensions["v2.contrastPairs"].
export function checkTokens(path) {
  const doc = JSON.parse(readFileSync(path, 'utf8'));
  const at = (ref) => ref.split('.').reduce((o, k) => o?.[k], doc);
  const resolve = (ref, mode, depth = 0) => {
    const node = at(ref);
    if (!node || depth > 8) throw new Error(`${path}: unresolved ${ref}`);
    let v = node.$value;
    if (v && typeof v === 'object') v = v[mode];
    const m = typeof v === 'string' && v.match(/^\{(.+)\}$/);
    return m ? resolve(m[1], mode, depth + 1) : v;
  };
  const pairs = doc.$extensions?.['v2.contrastPairs'];
  if (!pairs) throw new Error(`${path}: no v2.contrastPairs`);
  const all = ['light', 'dark'].flatMap((mode) => pairs.map(([fg, bg, role]) => {
    const p = { name: `${mode} ${fg} on ${bg}`, fg: resolve(fg, mode), bg: resolve(bg, mode), role };
    return { ...p, ratio: contrastRatio(p.fg, p.bg) };
  }));
  const failures = all.filter((p) => p.ratio < need(p));
  return { ok: failures.length === 0, failures, total: all.length };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let bad = 0;
  for (const f of process.argv.slice(2)) {
    const r = f.endsWith('.json') ? checkTokens(f) : checkFile(f);
    console.log(`${r.ok ? 'OK  ' : 'FAIL'} ${f} (${r.total - r.failures.length}/${r.total})`);
    for (const p of r.failures) console.log(`     ${p.name ?? ''} ${p.fg} on ${p.bg} ${p.ratio.toFixed(2)} < ${MIN[p.role]} (${p.role})`);
    if (!r.ok) bad++;
  }
  process.exit(bad ? 1 : 0);
}
