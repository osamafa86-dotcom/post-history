#!/usr/bin/env node
// فحص تقريبي للموارد والنصوص العربية الحرفية؛ لا يحل محل مراجعة الترجمة.
import { readdir, readFile } from 'node:fs/promises';
import { resolve, relative, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
const arabic = /[\u0600-\u06ff]/;
async function files(dir) {
  let entries; try { entries = await readdir(dir, { withFileTypes: true }); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  const out = [];
  for (const e of entries) {
    if (e.name.startsWith('.') || ['node_modules', 'build', 'Pods'].includes(e.name)) continue;
    if (e.isDirectory()) out.push(...await files(resolve(dir, e.name)));
    else if (e.isFile()) out.push(resolve(dir, e.name));
  }
  return out.sort();
}
function flatten(value, prefix = '', out = new Set()) {
  for (const [k, v] of Object.entries(value)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, out);
    else out.add(key);
  }
  return out;
}
export async function check(root) {
  root = resolve(root);
  const missing = [], literals = [], errors = [], groups = new Map();
  const add = (group, lang, keys) => {
    const pair = groups.get(group) ?? { ar: new Set(), en: new Set() };
    for (const key of keys) pair[lang].add(key);
    groups.set(group, pair);
  };
  for (const pkg of ['web', 'android', 'ios']) {
    const list = await files(resolve(root, 'apps', pkg));
    for (const path of list) {
      const name = relative(root, path).replaceAll('\\', '/');
      const resource = /\/messages\/(ar|en)\.json$/.exec(name);
      const xml = /\/res\/values(-ar|-en)?\/([^/]+\.xml)$/.exec(name);
      const strings = /\/(ar|en)\.lproj\/([^/]+\.strings)$/.exec(name);
      if (!(resource || xml || strings || name.endsWith('.xcstrings') || /\.(tsx|kt|swift)$/.test(name))) continue;
      try {
        const text = await readFile(path, 'utf8');
        if (resource) add(`${pkg}:messages`, resource[1], flatten(JSON.parse(text)));
        else if (xml) {
          const clean = text.replace(/<!--[\s\S]*?-->/g, '');
          const keys = [...clean.matchAll(/<(?:string|plurals|string-array)\s+[^>]*name\s*=\s*["']([^"']+)["'][^>]*>/g)].map(m => m[1]);
          add(`${pkg}:${xml[2]}`, xml[1] === '-en' ? 'en' : 'ar', keys);
        } else if (strings) {
          const clean = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
          add(`${pkg}:${strings[2]}`, strings[1], [...clean.matchAll(/"((?:\\.|[^"\\])*)"\s*=\s*"(?:\\.|[^"\\])*"\s*;/g)].map(m => m[1]));
        } else if (name.endsWith('.xcstrings')) {
          const doc = JSON.parse(text);
          for (const [key, v] of Object.entries(doc.strings)) {
            if (v.shouldTranslate === false) continue;
            for (const lang of ['ar', 'en']) {
              const translated = v.localizations?.[lang];
              if (translated && !JSON.stringify(translated).includes('"state":"new"') || lang === doc.sourceLanguage) add(`${pkg}:${name}`, lang, [key]);
            }
          }
        } else {
          // التعليقات تُزال مع إبقاء فواصل الأسطر لتحديد السطر؛ النص نفسه لا يُطبع.
          const clean = text.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' ')).replace(/^\s*\/\/.*$/gm, '');
          const lines = clean.split('\n');
          for (let i = 0; i < lines.length; i++) {
            const code = lines[i].replace(/\/\/[^"'`]*$/, '');
            if (arabic.test(code) && (/(["'`])[^\n]*[\u0600-\u06ff]/.test(code) || />[^<]*[\u0600-\u06ff]/.test(code))) literals.push({ file: name, line: i + 1 });
          }
        }
      } catch { errors.push({ file: name, error: 'resource_parse_failed' }); }
    }
    if (![...groups.keys()].some(k => k.startsWith(`${pkg}:`))) errors.push({ file: `apps/${pkg}`, error: 'resources_not_found' });
  }
  for (const [group, pair] of groups) for (const lang of ['ar', 'en']) for (const key of [...pair[lang]].sort()) {
    const other = lang === 'ar' ? 'en' : 'ar';
    if (!pair[other].has(key)) missing.push({ group, key, missingLanguage: other });
  }
  return { missing, literals, errors, ok: !missing.length && !literals.length && !errors.length };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const result = await check(args.find(a => !a.startsWith('--')) ?? resolve(fileURLToPath(new URL('..', import.meta.url))));
  if (args.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else {
    for (const x of result.missing) console.log(`${x.group}: ${x.key} missing ${x.missingLanguage}`);
    for (const x of result.literals) console.log(`${x.file}:${x.line}: Arabic literal`);
    for (const x of result.errors) console.log(`${x.file}: ${x.error}`);
  }
  process.exitCode = result.ok ? 0 : 1;
}
