import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  normalizePath, contractRoutes, controllerRoutes, compareRoutes, routeKey, formatReport, run,
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
