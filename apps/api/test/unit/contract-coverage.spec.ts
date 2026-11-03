import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { controllerFiles, serverRoutes } = require('../../scripts/contract-coverage.js') as {
  controllerFiles: (dir: string) => string[];
  serverRoutes: (dist: string) => Set<string>;
};

// جرد تغطية العقد يقرأ المتحكم أينما كان ملفه: commerce/licenses.ts وrefunds.ts وcommission-rules.ts تجاور خدماتها، فكان
// الجرد بلاحقة .controller.js وحدها يعدّ عملياتها الثماني «غير منفَّذة». ولا يحمّل ملفًا بلا مزخرف (main.js يقلع الخادم).
describe('contract coverage scan', () => {
  const common = JSON.stringify(require.resolve('@nestjs/common'));
  const compiled = (base: string, method: 'Get' | 'Post', sub: string) => `"use strict";
const common_1 = require(${common});
class C { handle() {} }
Reflect.decorate([(0, common_1.${method})(${JSON.stringify(sub)})], C.prototype, 'handle', Object.getOwnPropertyDescriptor(C.prototype, 'handle'));
exports.C = Reflect.decorate([(0, common_1.Controller)(${JSON.stringify(base)})], C);
`;
  let dist: string;
  beforeAll(() => {
    dist = mkdtempSync(join(tmpdir(), 'coverage-dist-'));
    mkdirSync(join(dist, 'commerce'));
    mkdirSync(join(dist, 'cli'));
    writeFileSync(join(dist, 'commerce', 'orders.controller.js'), compiled('orders', 'Get', ':orderId'));
    writeFileSync(join(dist, 'commerce', 'licenses.js'), compiled('licenses', 'Post', ':licenseId/download-url'));
    writeFileSync(join(dist, 'commerce', 'money.js'), '"use strict";\nexports.add = (a, b) => a + b;\n');
    writeFileSync(join(dist, 'main.js'), '"use strict";\nthrow new Error("main.js must not be loaded by the scan");\n');
    writeFileSync(join(dist, 'cli', 'create-user.js'), '"use strict";\nthrow new Error("cli must not be loaded by the scan");\n');
  });
  afterAll(() => rmSync(dist, { recursive: true, force: true }));

  it('finds controllers that live beside their service and loads nothing else', () => {
    expect(controllerFiles(dist).map((f) => f.slice(dist.length)).sort()).toEqual(['/commerce/licenses.js', '/commerce/orders.controller.js']);
    expect([...serverRoutes(dist)].sort()).toEqual(['get /orders/{}', 'post /licenses/{}/download-url']);
  });
});
