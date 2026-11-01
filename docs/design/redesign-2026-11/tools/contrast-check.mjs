// فحص تباين أزواج الألوان المعلنة في نموذج الاتجاه (WCAG 2.1).
// الاستعمال: node contrast-check.mjs <file.html> [...]
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const MIN = { text: 4.5, large: 3, ui: 3 };

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
    .filter((p) => p.ratio < MIN[p.role]);
  return { ok: failures.length === 0, failures, total: pairs.length };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let bad = 0;
  for (const f of process.argv.slice(2)) {
    const r = checkFile(f);
    console.log(`${r.ok ? 'OK  ' : 'FAIL'} ${f} (${r.total - r.failures.length}/${r.total})`);
    for (const p of r.failures) console.log(`     ${p.name ?? ''} ${p.fg} on ${p.bg} ${p.ratio.toFixed(2)} < ${MIN[p.role]} (${p.role})`);
    if (!r.ok) bad++;
  }
  process.exit(bad ? 1 : 0);
}
