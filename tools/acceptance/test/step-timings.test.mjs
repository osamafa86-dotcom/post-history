import test from "node:test";
import assert from "node:assert/strict";
import { summarize, timingsDoc, run } from "../ci/step-timings.mjs";
import { validateMeasurement } from "../lib/measurement.mjs";
import { byName } from "../lib/catalog.mjs";

const job = {
  name: "media e2e", run_attempt: 1, started_at: "2026-10-26T07:10:52Z",
  steps: [
    { number: 1, name: "Set up job", started_at: "2026-10-26T07:10:53Z", completed_at: "2026-10-26T07:10:55Z", conclusion: "success" },
    { number: 6, name: "Start the stack (API from source, tusd)", started_at: "2026-10-26T07:11:25Z", completed_at: "2026-10-26T07:17:33Z", conclusion: "success" },
    { number: 7, name: "Skipped step", started_at: "2026-10-26T07:17:33Z", completed_at: "2026-10-26T07:17:33Z", conclusion: "skipped" },
    { number: 8, name: "Step timings", started_at: "2026-10-26T07:17:34Z", completed_at: null, conclusion: null },
  ],
};

test("summarize keeps finished, non-skipped steps and names the slowest", () => {
  const s = summarize(job);
  assert.deepEqual(s.steps.map((x) => [x.number, x.seconds]), [[1, 2], [6, 368]]);
  assert.equal(s.slowest.number, 6);
  assert.equal(s.total_s, 401);
});

test("the timings document passes measurement.json, is information not a verdict, and carries one metric per step", () => {
  const doc = timingsDoc(job, { RUNNER_NAME: "r1" });
  assert.equal(doc.result, "info");
  assert.deepEqual(validateMeasurement(doc).errors, []);
  assert.equal(doc.metrics.step_06_start_the_stack_api_from_source_tusd_s, 368);
  assert.equal(doc.metrics.slowest_step_s, 368);
  assert.ok(byName("ci-step-timings"));
});

test("outside CI it measures nothing and exits 2; a failed GitHub call also writes nothing", async () => {
  assert.deepEqual(await run(["--dry-run"], {}), { code: 2, doc: null });
  const env = { GITHUB_TOKEN: "t", GITHUB_REPOSITORY: "o/r", GITHUB_RUN_ID: "1", RUNNER_NAME: "r1" };
  assert.deepEqual(await run(["--dry-run"], env, async () => ({ ok: false, status: 403 })), { code: 2, doc: null });
  assert.deepEqual(await run(["--dry-run"], env, async () => ({ ok: true, json: async () => ({ jobs: [{ runner_name: "other", steps: [] }] }) })), { code: 2, doc: null });
  const out = await run(["--dry-run"], env, async () => ({ ok: true, json: async () => ({ jobs: [{ runner_name: "r1", ...job }] }) }));
  assert.equal(out.code, 0);
  assert.equal(out.doc.metrics.steps, 2);
});
