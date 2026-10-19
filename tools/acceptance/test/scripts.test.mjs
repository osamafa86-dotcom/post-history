import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { startMockTus } from "./mock-tus.mjs";
import { run as uploadResume } from "../scripts/upload-resume.mjs";
import { run as piiLeak, liveChecks } from "../scripts/pii-leak.mjs";
import { buildMatrix, execute } from "../scripts/tenant-isolation.mjs";
import { scan, CHANNEL_KEYS } from "../lib/pii.mjs";
import { validateMeasurement } from "../lib/measurement.mjs";

const quiet = async (fn) => { const l = console.log; console.log = () => {}; try { return await fn(); } finally { console.log = l; } };
const env = (url) => ({ UPLOAD_ENDPOINT: url, UPLOAD_SIZE_MB: "12", UPLOAD_CHUNK_MB: "2" });

test("upload-resume succeeds against a conforming server (partial below the 5 GiB gate size) with a valid measurement", async () => {
  const s = await startMockTus();
  const { code, doc } = await quiet(() => uploadResume(["--dry-run"], env(s.url)));
  s.close();
  assert.equal(code, 0);
  assert.equal(doc.result, "partial", "12 MiB is below the 5 GiB criterion, so it cannot claim pass");
  assert.equal(doc.metrics.interruptions, 3);
  assert.equal(doc.metrics.restarts_from_zero, 0);
  assert.equal(doc.metrics.sha256_match, true);
  assert.ok(validateMeasurement(doc).ok);
});

test("upload-resume fails when the stored bytes differ", async () => {
  const s = await startMockTus({ corrupt: true });
  const { code, doc } = await quiet(() => uploadResume(["--dry-run"], env(s.url)));
  s.close();
  assert.equal(code, 1);
  assert.equal(doc.result, "fail");
  assert.equal(doc.metrics.sha256_match, false);
});

test("upload-resume does not claim a pass when the hash cannot be verified", async () => {
  const s = await startMockTus({ serveGet: false });
  const { code, doc } = await quiet(() => uploadResume(["--dry-run"], env(s.url)));
  s.close();
  assert.equal(code, 0);
  assert.equal(doc.result, "partial");
  assert.equal(doc.metrics.sha256_match, "unverified");
});

test("upload-resume reports an unreachable server as environment error, not a result", async () => {
  const { code, doc } = await quiet(() => uploadResume(["--dry-run"], env("http://127.0.0.1:9/files/")));
  assert.equal(code, 2);
  assert.equal(doc, null);
});

test("pii detector flags coordinates, device models and forbidden keys, and nothing in clean text", () => {
  const hit = scan({ payload: { gps: 1, note: "31.123456, 34.123456", dev: "iPhone15,2 / SM-S918B" } }, { keys: CHANNEL_KEYS });
  assert.deepEqual(hit.map((h) => h.kind).sort(), ["apple-model-id", "coordinate-pair", "forbidden-key", "samsung-model-id"]);
  assert.equal(scan({ title: "مادة عاجلة واردة #7b4a1f6e", priority: "urgent", version: "1.2.3" }).length, 0);
  assert.equal(JSON.stringify(hit).includes("31.123456"), false, "findings must not echo the leaked value");
});

test("pii-leak static run is partial (live not run), not pass", async () => {
  const { doc } = await quiet(() => piiLeak(["--dry-run"]));
  assert.equal(doc.metrics.live_checked, false);
  assert.notEqual(doc.result, "pass");
  assert.notEqual(doc.result, "fail");
  assert.equal(doc.metrics.detector_controls_missed, 0);
});

function fakeApi(handler) {
  const server = http.createServer((req, res) => { const r = handler(req); res.writeHead(r.status ?? 200, { "content-type": "application/json" }); res.end(JSON.stringify(r.body ?? {})); });
  return new Promise((ok) => server.listen(0, "127.0.0.1", () => ok({ url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() })));
}

test("pii-leak live crawl catches a canary in a notification and ignores clean ones", async () => {
  const leaky = await fakeApi((req) => ({ body: req.url === "/notifications" ? { items: [{ title: "from canary-src-77" }] } : { items: [] } }));
  const bad = await liveChecks({ baseUrl: leaky.url, tokens: { producer: "t" }, canaries: ["canary-src-77"] });
  leaky.close();
  assert.equal(bad.findings.length, 1);
  assert.equal(bad.findings[0].kind, "canary");
  const clean = await fakeApi(() => ({ body: { items: [] } }));
  const ok = await liveChecks({ baseUrl: clean.url, tokens: { producer: "t" }, canaries: ["canary-src-77"] });
  clean.close();
  assert.equal(ok.findings.length, 0);
});

test("tenant matrix derives cases from the contract and catches a missing x-roles", () => {
  const api = {
    components: { schemas: { RoleName: { enum: ["reporter", "producer"] } } },
    paths: {
      "/materials/{id}": { get: { "x-roles": ["reporter"], responses: { 401: {}, 403: {} } } },
      "/open": { get: { responses: {} } },
    },
  };
  const m = buildMatrix(api);
  assert.equal(m.problems.length, 1);
  assert.equal(m.problems[0].kind, "missing-x-roles");
  assert.deepEqual(m.cases.filter((c) => c.kind === "role").map((c) => [c.role, c.expect]), [["reporter", "not-401-403"], ["producer", "403"]]);
  assert.ok(m.cases.some((c) => c.kind === "anonymous" && c.expect === "401"));
});

test("tenant execute: a server that serves another reporter's material fails the scope case", async () => {
  const cases = [{ kind: "scope", op: "GET /materials/{id}", method: "get", path: "/materials/{id}", role: "reporter", fixture: "other_reporter_material_id", expect: "404" }];
  const leaky = await fakeApi(() => ({ status: 200, body: { id: "x" } }));
  const bad = await execute(cases, { baseUrl: leaky.url, tokens: { reporter: "t" }, fixtures: { other_reporter_material_id: "abc" } });
  leaky.close();
  assert.equal(bad[0].outcome, "fail");
  const tight = await fakeApi((req) => ({ status: req.headers.authorization ? 404 : 401 }));
  const ok = await execute(cases, { baseUrl: tight.url, tokens: { reporter: "t" }, fixtures: { other_reporter_material_id: "abc" } });
  tight.close();
  assert.equal(ok[0].outcome, "pass");
});

// ---- form-conformance, field cards, results validator ----
import { runReference, judge, loadSuite } from "../form-conformance/run.mjs";
import { validate as reference } from "../form-conformance/reference.mjs";
import { cardToResult } from "../field/record-card.mjs";
import { checkResult } from "../validate-results.mjs";
import { readFileSync } from "node:fs";

test("form-conformance: reference matches every hand-written expectation", () => {
  const { suite, results } = runReference();
  assert.deepEqual(judge(results, suite), []);
  assert.ok(suite.cases.length >= 50);
});

test("form-conformance: cases catch an implementation that counts UTF-16 units or trims", () => {
  const { suite, forms } = loadSuite();
  const utf16 = (form, mt, values) => {
    const patched = { ...form, fields: form.fields.map((f) => f.key === "headline" ? { ...f, validation: { min_length: 3, max_length: 20 } } : f) };
    const v = { ...values }; if (typeof v.headline === "string") v.headline = v.headline.replace(/[\u{10000}-\u{10FFFF}]/gu, "��"); // each astral char becomes 2 units
    return reference(patched, mt, v);
  };
  const results = Object.fromEntries(suite.cases.map((c) => [c.id, utf16(forms[c.form], c.material_type, c.values)]));
  const wrong = judge(results, suite).map((w) => w.id);
  assert.ok(wrong.includes("length-counts-code-points-ok"));
  assert.ok(wrong.includes("length-counts-code-points-too-short"));
  const trimming = Object.fromEntries(suite.cases.map((c) => [c.id, reference(forms[c.form], c.material_type, Object.fromEntries(Object.entries(c.values).map(([k, v]) => [k, typeof v === "string" ? v.trim() : v])))]));
  assert.ok(judge(trimming, suite).some((w) => w.id === "length-no-trimming"));
});

const goodCard = () => ({
  card_version: 1, test_name: "task-killers", performed_on: "2026-11-05", performed_by_role: "field_supervisor",
  device: { vendor: "xiaomi", model: "Redmi 12", os_version: "14", free_storage_mb: 3000 }, app_version: "0.1.0",
  network: { type: "wifi" }, upload: { path: "tusd", file_size_bytes: 1073741824, file_sha256: "a".repeat(64) },
  steps: { onboarding_completed: true, battery_percent_at_start: 80, locked_minutes: 31, interventions_before_complete: 0, completed: true, completed_minutes_after_start: 52, server_sha256_match: true },
  observations: "",
});

test("field card: complete passing card gives a valid partial (one vendor is not the criterion)", () => {
  const { doc } = cardToResult(goodCard());
  assert.equal(doc.result, "partial");
  assert.ok(validateMeasurement(doc).ok);
  assert.deepEqual(checkResult("2026-11-05-task-killers-xiaomi.json", doc), []);
});

test("field card: any intervention, short lock or hash mismatch is a fail; blanks and leaks are refused", () => {
  const c1 = goodCard(); c1.steps.interventions_before_complete = 1;
  assert.equal(cardToResult(c1).doc.result, "fail");
  const c2 = goodCard(); c2.steps.locked_minutes = 12;
  assert.equal(cardToResult(c2).doc.result, "fail");
  const c3 = goodCard(); c3.steps.server_sha256_match = false;
  assert.equal(cardToResult(c3).doc.result, "fail");
  const c4 = goodCard(); c4.steps.completed = null;
  assert.ok(cardToResult(c4).missing.length);
  const c5 = goodCard(); c5.observations = "seen at 31.123456, 34.123456"; c5.steps.completed_minutes_after_start = 1;
  const r5 = cardToResult(c5);
  assert.ok(r5.missing?.some((m) => m.includes("revealing")), "coordinates in free text must be refused");
});

test("results validator rejects bad names, unknown tests, pass-without-evidence and leaks", () => {
  const { doc } = cardToResult(goodCard());
  assert.ok(checkResult("bad-name.json", doc).some((e) => e.includes("name must be")));
  assert.ok(checkResult("2026-11-05-x.json", { ...doc, test_name: "nonsense" }).some((e) => e.includes("not a row")));
  assert.ok(checkResult("2026-11-05-x.json", { ...doc, result: "pass", metrics: { ...doc.metrics, sha256_match: "unverified" } }).some((e) => e.includes("result is pass")));
  assert.ok(checkResult("2026-11-05-x.json", { ...doc, notes: "at geo:31.5,34.4" }).some((e) => e.includes("revealing")));
  assert.deepEqual(checkResult("2026-11-05-x.json", { ...doc, device: { ...doc.device, model: "SM-S918B" } }), [], "device.model is allowed");
});

test("tenant execute: a route the server does not have is unimplemented, not a pass or a fail", async () => {
  const cases = [{ kind: "role", op: "GET /uploads/{id}", method: "get", path: "/uploads/{id}", role: "finance", expect: "403" }];
  const none = await fakeApi(() => ({ status: 404 }));
  const out = await execute(cases, { baseUrl: none.url, tokens: { finance: "t" }, fixtures: {} });
  none.close();
  assert.equal(out[0].outcome, "unimplemented");
});

import { setLogSource } from "../scripts/pii-leak.mjs";
import { canon } from "../lib/live.mjs";

test("pii-leak live crawl also scans the server logs for canaries", async () => {
  const clean = await fakeApi(() => ({ body: { items: [] } }));
  setLogSource(() => '{"msg":"request","path":"/v1/materials"}\n{"msg":"oops 12.34567891"}');
  const r = await liveChecks({ baseUrl: clean.url, tokens: { producer: "t" }, canaries: ["12.34567891"] });
  setLogSource(null);
  clean.close();
  assert.deepEqual(r.findings.map((f) => f.source), ["server logs"]);
});

test("canon treats JSON bodies with different key order as the same response", () => {
  assert.equal(canon({ a: 1, b: { c: [1, { y: 2, x: 1 }] } }), canon({ b: { c: [1, { x: 1, y: 2 }] }, a: 1 }));
  assert.notEqual(canon({ a: 1 }), canon({ a: 2 }));
});

import { s3FromEnv, tusObjectKey } from "../lib/s3.mjs";
import { eventsOfType, percentile } from "../lib/live.mjs";
import { waitFor } from "../lib/hooks.mjs";

test("tusd object keys: prefix plus the id before the multipart '+', whatever the URL shape", () => {
  assert.equal(tusObjectKey("tus/", "http://h:8080/files/abc123+MULTIPART"), "tus/abc123");
  assert.equal(tusObjectKey("", "http://h/files/abc123/"), "abc123");
  assert.equal(s3FromEnv({}), null, "no S3 settings means no S3 client, never a half-configured one");
});

test("eventsOfType follows pages and throws on a non-200 instead of reporting an empty list", async () => {
  const pages = [{ items: [{ id: "1" }, { id: "2" }], next_after: "2" }, { items: [{ id: "3" }], next_after: "3" }, { items: [], next_after: "3" }];
  let i = 0;
  const ok = { get: async () => ({ status: 200, body: pages[i++] }) };
  assert.deepEqual((await eventsOfType(ok, "t", "x")).map((e) => e.id), ["1", "2", "3"]);
  await assert.rejects(eventsOfType({ get: async () => ({ status: 422, body: {} }) }, "t", "x"), /422/);
});

test("waitFor returns the value as soon as the probe has one, and null after the budget", async () => {
  let n = 0;
  const hit = await waitFor(async () => (++n >= 3 ? "ready" : null), { timeoutMs: 2000, everyMs: 5 });
  assert.equal(hit.value, "ready");
  const miss = await waitFor(async () => null, { timeoutMs: 50, everyMs: 10 });
  assert.equal(miss.value, null);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95), 10);
});

import { buildReport } from "../report.mjs";
import { RULES } from "../field/cards.mjs";

const fq = () => {
  const sc = (extra = {}) => ({ offset_before_bytes: 500_000_000, offset_after_resume_bytes: 490_000_000, completed: true, interventions_after_restart: 0, server_sha256_match: true, ...extra });
  return {
    card_version: 1, test_name: "force-quit-restart", performed_on: "2026-11-06", performed_by_role: "field_supervisor",
    device: { platform: "ios", vendor: "apple", model: "iPhone 13", os_version: "18.1" }, app_version: "0.2.0", network: { type: "wifi" },
    upload: { path: "tusd", file_size_bytes: 1073741824, file_sha256: "b".repeat(64), part_size_bytes: 16_777_216 },
    scenarios: { force_quit: sc(), battery_depleted: sc(), reboot: sc(), low_storage: sc({ free_storage_mb_at_start: 700 }) }, observations: "",
  };
};

test("force-quit-restart card: passes only when every scenario resumes from what arrived and completes", () => {
  const ok = cardToResult(fq());
  assert.equal(ok.doc.result, "partial");
  assert.ok(validateMeasurement(ok.doc).ok);
  const zero = fq(); zero.scenarios.reboot.offset_after_resume_bytes = 0;
  assert.match(cardToResult(zero).doc.notes, /reboot: restarted from zero/);
  const far = fq(); far.scenarios.force_quit.offset_after_resume_bytes = 400_000_000;
  assert.match(cardToResult(far).doc.notes, /more than one request \(16777216\)/);
  // iOS background sessions send bigger requests: a step back of 64 MiB is fine once the card records that request size, and still not past it
  const ios = fq(); ios.upload.request_bytes = 67_108_864; ios.scenarios.force_quit.offset_after_resume_bytes = 440_000_000;
  assert.equal(cardToResult(ios).doc.result, "partial");
  ios.scenarios.force_quit.offset_after_resume_bytes = 400_000_000;
  assert.match(cardToResult(ios).doc.notes, /more than one request \(67108864\)/);
  const badReq = fq(); badReq.upload.request_bytes = "64MiB";
  assert.ok(cardToResult(badReq).missing.some((m) => m.includes("request_bytes")));
  const roomy = fq(); roomy.scenarios.low_storage.free_storage_mb_at_start = 5000;
  assert.equal(cardToResult(roomy).doc.result, "fail");
  const blank = fq(); blank.scenarios.battery_depleted.completed = null;
  assert.ok(cardToResult(blank).missing.some((m) => m.includes("battery_depleted.completed")));
  assert.equal(RULES["force-quit-restart"].SCENARIOS.length, 4);
});

test("timestamp-alignment card: ten VFR files with gaps within 40 ms is a full pass; one outlier fails the card", () => {
  const files = Array.from({ length: 10 }, (_, i) => ({ model: `phone-${i}`, vfr: true, has_gaps: true, offset_ms: i % 2 ? -20 : 12 }));
  const card = { card_version: 1, test_name: "timestamp-alignment", performed_on: "2026-11-09", measured_by: "media-align 0.1", files, observations: "" };
  const ok = cardToResult(card);
  assert.equal(ok.doc.result, "pass");
  assert.deepEqual(checkResult("2026-11-09-timestamp-alignment-ten-files.json", ok.doc), []);
  const bad = structuredClone(card); bad.files[3].offset_ms = 55;
  assert.match(cardToResult(bad).doc.notes, /files\[3\]: offset 55 ms/);
  const few = structuredClone(card); few.files.length = 9;
  assert.ok(cardToResult(few).missing.some((m) => m.includes("at least 10")));
  const unmeasured = structuredClone(card); delete unmeasured.measured_by;
  assert.ok(cardToResult(unmeasured).missing.some((m) => m.includes("measured_by")));
});

test("unified report lists every acceptance row, keeps the latest result per profile and never invents a pass", () => {
  const mk = (test_name, result, started_at, extra = {}) => ({ doc: { schema_version: 1, tool: "acceptance", role: "qa", test_name, started_at, ended_at: started_at, result, metrics: { n: 1 }, ...extra }, file: `docs/measurements/acceptance/${test_name}-${started_at.slice(0, 10)}.json` });
  const md = buildReport([
    mk("pii-leak", "partial", "2026-10-19T10:00:00Z"),
    mk("pii-leak", "fail", "2026-10-20T10:00:00Z"),
    mk("upload-resume", "pass", "2026-10-20T10:00:00Z", { metrics: { sha256_match: true } }),
  ], new Date("2026-10-21T00:00:00Z"));
  assert.match(md, /\| pii-leak \| automated \| ❌ fail/, "the latest run decides, and a fail pulls the row down");
  assert.match(md, /\| upload-resume \| automated \| ✅ pass/);
  assert.match(md, /\| payout \| pending \| — لا نتيجة/, "rows without a result are listed, not hidden");
  assert.match(md, /pass 1، partial 0، fail 1/);
});

test("report shows the netlab stage (a) numbers: loss mode, efficiency against Mathis and bytes lost on resume", () => {
  const entry = { doc: { schema_version: 1, tool: "netlab", role: "infra", test_name: "field-network-upload", started_at: "2026-10-20T08:00:00Z", ended_at: "2026-10-20T08:20:00Z", result: "partial", network: { profile: "field-weak" }, metrics: { loss_mode: "netem", efficiency_vs_mathis: 0.82, bytes_lost_on_resume: 0, upload_complete: true, checksum_match: true, goodput_kbps: 300 } }, file: "docs/measurements/netlab/x.json" };
  const md = buildReport([entry], new Date("2026-10-21T00:00:00Z"));
  assert.match(md, /loss_mode=netem، efficiency_vs_mathis=0\.82، bytes_lost_on_resume=0/);
  assert.match(md, /\| field-network-upload \| pending \| ◐ partial/);
});
