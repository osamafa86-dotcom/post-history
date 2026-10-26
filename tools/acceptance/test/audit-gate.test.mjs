import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { advisoriesOf, gate, multerUnused } from "../scripts/audit-gate.mjs";

const adv = (id, name, severity) => ({ source: 1, name, title: `${name} problem`, url: `https://github.com/advisories/${id}`, severity });
const audit = (...vias) => ({ vulnerabilities: Object.fromEntries(vias.map((v) => [v.name, { name: v.name, severity: v.severity, via: [v] }])) });
const MULTER = "GHSA-q7qp-rjg7-q26m";
const list = (extra = {}) => ({ entries: [{ id: MULTER, package: "multer", dir: "apps/api", guard: "multer-unused", adr: "0085", expires: "2026-12-15", removeWhen: "fixed multer installed", ...extra }] });
const ok = () => ({ ok: true }), notOk = () => ({ ok: false, why: "used" });
const run = (a, al, g = ok, now = new Date("2026-11-01")) => gate({ audit: a, allowlist: al, dir: "apps/api", now, guards: { "multer-unused": g } });

test("advisories: high and above only, by their id, once", () => {
  const a = audit(adv(MULTER, "multer", "high"), adv("GHSA-aaaa-bbbb-cccc", "x", "moderate"), adv("GHSA-dddd-eeee-ffff", "y", "critical"));
  a.vulnerabilities.parent = { name: "parent", severity: "high", via: ["multer", adv(MULTER, "multer", "high")] };
  assert.deepEqual(advisoriesOf(a).map((x) => x.id).sort(), [MULTER, "GHSA-dddd-eeee-ffff"].sort());
});

test("an allowlisted advisory with a passing guard and a live entry passes, and is reported", () => {
  const r = run(audit(adv(MULTER, "multer", "high")), list());
  assert.deepEqual(r.problems, []);
  assert.equal(r.allowed[0].id, MULTER);
});

test("an unlisted high advisory fails; a moderate one does not", () => {
  assert.equal(run(audit(adv(MULTER, "multer", "high"), adv("GHSA-dddd-eeee-ffff", "body-parser", "high")), list()).problems.length, 1);
  assert.deepEqual(run(audit(adv("GHSA-aaaa-bbbb-cccc", "fast-uri", "moderate")), { entries: [] }).problems, []);
});

test("mutation: each condition of the exception is needed", () => {
  const a = audit(adv(MULTER, "multer", "high"));
  assert.match(run(a, list(), notOk).problems[0], /guard multer-unused fails/);
  assert.match(run(a, list(), ok, new Date("2027-01-01")).problems[0], /expired/);
  assert.match(run(a, list({ dir: "apps/web" })).problems[0], /not allowlisted/);
  assert.match(run(audit(), list()).problems[0], /no longer reported/);
});

test("multer-unused sees every way in, and the API source has none", () => {
  const dir = mkdtempSync(join(tmpdir(), "gate-"));
  try {
    mkdirSync(join(dir, "nested"));
    assert.equal(multerUnused(dir).ok, true);
    for (const [i, body] of ["import multer from 'multer';", "@UseInterceptors(FileInterceptor('f'))", "@UploadedFile() f", "MulterModule.register({})", "consumes: 'multipart/form-data'"].entries()) {
      writeFileSync(join(dir, "nested", `f${i}.ts`), body);
      assert.equal(multerUnused(dir).ok, false, body);
      rmSync(join(dir, "nested", `f${i}.ts`));
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
  assert.deepEqual(multerUnused(join(import.meta.dirname, "../../../apps/api/src")), { ok: true });
});
