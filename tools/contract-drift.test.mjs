import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  normalizePath, contractRoutes, controllerRoutes, unparsedControllers, compareRoutes, routeKey, formatReport, run,
} from "./contract-drift.mjs";

test("normalizes parameter names and trailing slashes without adding the runtime prefix", () => {
  assert.equal(normalizePath("/materials/{id}/files/{file_id}/"), "/materials/{}/files/{}");
  assert.equal(normalizePath("materials/:id/files/:fileId"), "/materials/{}/files/{}");
});

test("reads only HTTP operations below OpenAPI paths", () => {
  const routes = contractRoutes(`openapi: 3.1.0\npaths:\n  /materials/{id}:\n    parameters:\n      - name: id\n    get:\n      responses: {}\n    post:\n      responses: {}\n  '/health':\n    head:\n      responses: {}\ncomponents: {}\n`);
  assert.deepEqual(routes.map(routeKey), ["GET /materials/{}", "POST /materials/{}", "HEAD /health"]);
});

test("reads multiple Nest controllers and joins empty and decorated paths", () => {
  const routes = controllerRoutes(`
@Controller('materials')
class Materials {
  @Get(':id/files/:fileId/download-url')
  one() {}
  @Post()
  two() {}
}
@Controller("health")
class Health {
  @Get()
  three() {}
}
`);
  assert.deepEqual(routes.map(routeKey), [
    "GET /materials/{}/files/{}/download-url",
    "POST /materials",
    "GET /health",
  ]);
  assert.deepEqual(routes.map((route) => route.line), [4, 6, 11]);
});

test("comparison separates contract-only and controller-only routes after normalization", () => {
  const result = compareRoutes(
    [{ method: "get", path: "/materials/{id}" }, { method: "post", path: "/uploads" }],
    [{ method: "get", path: "/materials/:materialId", file: "memory", line: 1 }, { method: "delete", path: "/uploads/:id", file: "memory", line: 2 }],
  );
  assert.deepEqual(result.contractOnly.map(routeKey), ["POST /uploads"]);
  assert.deepEqual(result.controllerOnly.map(routeKey), ["DELETE /uploads/{}"]);
  assert.match(formatReport({ contract: [], controllers: [], ...result }), /CONTRACT_ONLY POST \/uploads/);
});

test("default mode warns successfully while strict mode returns one for drift", async () => {
  const dir = mkdtempSync(join(tmpdir(), "contract-drift-test-"));
  try {
    const api = join(dir, "api");
    mkdirSync(api);
    const openapi = join(dir, "openapi.yaml");
    writeFileSync(openapi, "paths:\n  /documented:\n    get:\n      responses: {}\n");
    writeFileSync(join(api, "sample.controller.ts"), "@Controller('actual')\nclass Actual { @Get() read() {} }\n");
    const env = { CONTRACT_DRIFT_OPENAPI: openapi, CONTRACT_DRIFT_CONTROLLERS: api };
    assert.equal((await run([], env)).code, 0);
    assert.equal((await run(["--strict"], env)).code, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("reads controllers from plain .ts files and skips generated/ and spec files", async () => {
  const dir = mkdtempSync(join(tmpdir(), "contract-drift-test-"));
  try {
    const api = join(dir, "api");
    mkdirSync(join(api, "generated"), { recursive: true });
    const openapi = join(dir, "openapi.yaml");
    // متحكم وخدمته في ملف واحد بلا اللاحقة .controller.ts، كوحدات commerce/ في الخادم
    writeFileSync(join(api, "billing.ts"), "@Controller('billing')\nclass Billing { @Get() list() {} }\n");
    writeFileSync(join(api, "generated", "client.ts"), "@Controller('ghost')\nclass Ghost { @Get() read() {} }\n");
    writeFileSync(join(api, "billing.spec.ts"), "@Controller('spec')\nclass Spec { @Get() read() {} }\n");
    writeFileSync(join(api, "plain.ts"), "// لا مزخرفات هنا\n");
    writeFileSync(openapi, "paths:\n  /billing:\n    get:\n      responses: {}\n");
    const env = { CONTRACT_DRIFT_OPENAPI: openapi, CONTRACT_DRIFT_CONTROLLERS: api };
    const { code, result } = await run([], env);
    assert.equal(code, 0);
    assert.equal(result.controllerFileCount, 1);
    assert.deepEqual(result.controllers.map(routeKey), ["GET /billing"]);
    assert.deepEqual(result.contractOnly, []);
    assert.deepEqual(result.controllerOnly, []);
    assert.deepEqual(result.unparsed, []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("counts the seven commerce routes as implemented when controller and service share one file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "contract-drift-test-"));
  try {
    const api = join(dir, "api");
    mkdirSync(api);
    // العمليات السبع التي أشار إليها تقرير الجودة في #346، بأسماء ملفات بلا اللاحقة
    writeFileSync(join(api, "commission-rules.ts"), "@Controller('commission-rules')\nclass CommissionRules { @Get() list() {} @Post() create() {} }\n");
    writeFileSync(join(api, "licenses.ts"), "@Controller('licenses')\nclass Licenses { @Get() list() {} @Get(':licenseId') read() {} @Post(':licenseId/download-url') grant() {} }\n");
    writeFileSync(join(api, "refunds.ts"), "@Controller('orders/:orderId/refunds')\nclass Refunds { @Get() list() {} @Post() create() {} }\n");
    const openapi = join(dir, "openapi.yaml");
    writeFileSync(openapi, [
      "paths:",
      "  /commission-rules:",
      "    get: { responses: {} }",
      "    post: { responses: {} }",
      "  /licenses:",
      "    get: { responses: {} }",
      "  /licenses/{license_id}:",
      "    get: { responses: {} }",
      "  /licenses/{license_id}/download-url:",
      "    post: { responses: {} }",
      "  /orders/{order_id}/refunds:",
      "    get: { responses: {} }",
      "    post: { responses: {} }",
      "",
    ].join("\n"));
    const env = { CONTRACT_DRIFT_OPENAPI: openapi, CONTRACT_DRIFT_CONTROLLERS: api };
    const { code, result } = await run(["--strict"], env);
    assert.equal(code, 0);
    assert.equal(result.controllers.length, 7);
    assert.deepEqual(result.contractOnly, []);
    assert.deepEqual(result.controllerOnly, []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("flags @Controller decorators with non-literal arguments instead of dropping them silently", async () => {
  const source = "@Controller({ path: 'object-form' })\nclass A {}\n@Controller(prefixVariable)\nclass B {}\n@Controller('literal')\nclass C {}\n";
  const unparsed = unparsedControllers(source, "memory.ts");
  assert.deepEqual(unparsed, [{ file: "memory.ts", line: 1 }, { file: "memory.ts", line: 3 }]);
  assert.deepEqual(controllerRoutes(source).map(routeKey), []);

  const dir = mkdtempSync(join(tmpdir(), "contract-drift-test-"));
  try {
    const api = join(dir, "api");
    mkdirSync(api);
    writeFileSync(join(api, "object-form.ts"), "@Controller({ path: 'hidden' })\nclass Hidden { @Get() read() {} }\n");
    const openapi = join(dir, "openapi.yaml");
    writeFileSync(openapi, "paths: {}\n");
    const env = { CONTRACT_DRIFT_OPENAPI: openapi, CONTRACT_DRIFT_CONTROLLERS: api };
    const relaxed = await run([], env);
    assert.equal(relaxed.code, 0);
    assert.equal(relaxed.result.unparsed.length, 1);
    assert.match(formatReport(relaxed.result), /UNPARSED_CONTROLLER .*object-form\.ts:1/);
    // المزخرف غير المحلَّل يعني أن المقارنة ناقصة، فيفشل الفحص الصارم حتى بلا فرق مسارات
    assert.equal((await run(["--strict"], env)).code, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
