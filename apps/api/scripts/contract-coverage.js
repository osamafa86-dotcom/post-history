#!/usr/bin/env node
// جرد تغطية العقد: يقارن عمليات contracts/openapi.yaml بالمسارات المسجّلة في الخادم (من بيانات Nest الوصفية في
// المتحكمات المترجمة، dist/) ويطبع ما لم يُنفَّذ وما سُجّل خارج العقد. تحذير لا فشل، إلا مع --strict.
// الاستخدام: npm run build && node scripts/contract-coverage.js [--strict]
require('reflect-metadata');
const { readFileSync, readdirSync, statSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { parse } = require('yaml');

const ROOT = resolve(__dirname, '..');
const METHODS = ['get', 'post', 'put', 'patch', 'delete'];
// RequestMethod في @nestjs/common: GET=0 POST=1 PUT=2 DELETE=3 PATCH=4
const NEST_METHOD = { 0: 'get', 1: 'post', 2: 'put', 3: 'delete', 4: 'patch' };
// خارج العقد عمدًا: فحص الصحة التشغيلي
const OUTSIDE_CONTRACT = new Set(['get /health']);

const norm = (p) => ('/' + p).replace(/\/+/g, '/').replace(/\/$/, '').replace(/\{[^}]+\}|:[A-Za-z_]+/g, '{}') || '/';

function contractOperations() {
  const doc = parse(readFileSync(join(ROOT, '../../contracts/openapi.yaml'), 'utf8'));
  const ops = [];
  for (const [path, item] of Object.entries(doc.paths)) {
    for (const m of METHODS) if (item[m]) ops.push({ key: `${m} ${norm(path)}`, label: `${m.toUpperCase()} ${path}`, id: item[m].operationId });
  }
  return ops;
}

function controllerFiles(dir) {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return controllerFiles(p);
    return f.endsWith('.controller.js') ? [p] : [];
  });
}

function serverRoutes() {
  const routes = [];
  for (const file of controllerFiles(join(ROOT, 'dist'))) {
    for (const exported of Object.values(require(file))) {
      if (typeof exported !== 'function') continue;
      const base = Reflect.getMetadata('path', exported);
      if (base === undefined) continue;
      for (const name of Object.getOwnPropertyNames(exported.prototype)) {
        const handler = exported.prototype[name];
        const method = Reflect.getMetadata('method', handler);
        if (method === undefined) continue;
        const sub = Reflect.getMetadata('path', handler) ?? '';
        // البادئة /v1 لا تظهر في مسارات العقد (هي في servers)، والمستثنى منها (health، internal) مكتوب كما هو
        routes.push(`${NEST_METHOD[method]} ${norm(`${base}/${sub}`)}`);
      }
    }
  }
  return new Set(routes);
}

const ops = contractOperations();
const routes = serverRoutes();
const missing = ops.filter((o) => !routes.has(o.key));
const contractKeys = new Set(ops.map((o) => o.key));
const extra = [...routes].filter((r) => !contractKeys.has(r) && !OUTSIDE_CONTRACT.has(r));

console.log(`contract operations: ${ops.length}, implemented: ${ops.length - missing.length}, missing: ${missing.length}`);
for (const o of missing) console.log(`  missing  ${o.label}  (${o.id})`);
for (const r of extra) console.log(`  extra    ${r}  (registered in the server, not in the contract)`);
if (missing.length && !process.argv.includes('--strict')) console.log('::warning::contract operations not implemented: ' + missing.length);
process.exit(process.argv.includes('--strict') && (missing.length || extra.length) ? 1 : 0);
