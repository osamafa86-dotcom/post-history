import test from "node:test";
import assert from "node:assert/strict";
import { analyze, crashCommand, run } from "../scripts/availability.mjs";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateMeasurement } from "../lib/measurement.mjs";

const quiet = async (fn) => { const l = console.log; console.log = () => {}; try { return await fn(); } finally { console.log = l; } };
const ok = (t) => ({ t, ok: true }), bad = (t) => ({ t, ok: false });

test("analyze: downtime runs from the first failure after the action to the first success that stays", () => {
  const s = [ok(0), ok(50), ok(100), bad(150), bad(200), bad(250), ok(300), ok(350), ok(400), ok(450), ok(500)];
  const a = analyze(s, 120);
  assert.equal(a.dipped, true);
  assert.equal(a.recovered, true);
  assert.equal(a.failures, 3);
  assert.equal(a.first_failure_ms, 30);
  assert.equal(a.downtime_s, 0.15);
});

test("analyze: a failure that is still going at the end is not a recovery; a clean run has no downtime", () => {
  const stuck = analyze([ok(0), bad(100), bad(150), bad(200), bad(250), bad(300)], 50);
  assert.equal(stuck.recovered, false);
  assert.equal(stuck.downtime_s, null);
  const clean = analyze([ok(0), ok(50), ok(100), ok(150), ok(200), ok(250)], 50);
  assert.deepEqual([clean.dipped, clean.recovered, clean.downtime_s, clean.failures], [false, true, 0, 0]);
  // a flap: recovered, failed again, recovered: downtime counts to the last good stretch
  const flap = analyze([ok(0), bad(100), ok(150), bad(200), ok(250), ok(300), ok(350), ok(400), ok(450)], 50);
  assert.equal(flap.downtime_s, 0.15);
});

function fakeStack() {
  const state = { down: false, writes: 0 };
  const res = (status, body) => ({ status, text: async () => JSON.stringify(body), headers: new Headers({ "content-type": "application/json" }) });
  const fetchImpl = async (url, opts = {}) => {
    const path = new URL(url).pathname.replace(/^\/v1/, "") + new URL(url).search;
    if (path === "/forms/current") return res(200, { version: 1 });
    if (path === "/auth/me") return res(200, { email: "Acceptance@Example.invalid" });
    if (opts.method === "POST" && path === "/materials/m-1/transitions") { state.rejected = JSON.parse(opts.body).to === "rejected" && JSON.parse(opts.body).reason === "availability_canary"; return res(200, {}); }
    if (opts.method === "POST" && path === "/materials") { state.writes++; return res(201, { id: "m-1" }); }
    if (state.down) return res(503, { error: "down" });
    if (path.startsWith("/materials/m-1")) return res(200, { id: "m-1", title: "[كناري] x", editorial_state: state.rejected ? "rejected" : "inbox" });
    return res(200, { items: [] });
  };
  const exec = async () => { state.down = true; setTimeout(() => { state.down = false; }, 200); };
  return { state, fetchImpl, exec };
}
const quick = { AVAIL_API_URL: "http://api.test/v1", AVAIL_TOKEN: "t", AVAIL_COMPOSE: "compose", AVAIL_LOAD: "2", AVAIL_GAP_MS: "5", AVAIL_BASELINE_MS: "60", AVAIL_SETTLE_MS: "150", AVAIL_TIMEOUT_MS: "5000" };

test("availability: three scenarios under load, partial without a declared target and the trial-host statement", async () => {
  const { fetchImpl, exec, state } = fakeStack();
  const { code, doc } = await quiet(() => run(["--dry-run"], quick, { fetchImpl, exec }));
  assert.equal(code, 0);
  assert.equal(doc.result, "partial");
  assert.equal(state.writes, 1, "one marker material");
  for (const k of ["api_kill", "db_kill", "deploy"]) {
    // the fake stack is down for 200 ms by a timer; a loaded runner delays the probes, so only 'measured and short' is asserted
    assert.ok(doc.metrics[`${k}_downtime_s`] >= 0.02 && doc.metrics[`${k}_downtime_s`] < 2, `${k} downtime ${doc.metrics[`${k}_downtime_s`]}`);
    assert.ok(doc.metrics[`${k}_failed_requests`] > 0);
  }
  assert.equal(doc.metrics.marker_intact, true);
  assert.equal(doc.metrics.target_s, -1);
  assert.equal(validateMeasurement(doc).ok, true);
});

test("availability: pass needs a declared target, the trial host and recovery within it; a miss against the target stays partial, a stack that never recovers fails", async () => {
  const a = fakeStack();
  const trial = { ...quick, AVAIL_TARGET_S: "5", AVAIL_TRIAL_HOST: "1", AVAIL_ACCEPTANCE_EMAIL: "acceptance@example.invalid", AVAIL_SUPERVISOR_TOKEN: "s" };
  const within = await quiet(() => run(["--dry-run", "--maintenance-window"], trial, { fetchImpl: a.fetchImpl, exec: a.exec }));
  assert.equal(within.doc.result, "pass");
  assert.equal(within.doc.metrics.canary_withdrawn, true);
  const b = fakeStack();
  const missed = await quiet(() => run(["--dry-run", "--maintenance-window"], { ...quick, AVAIL_TARGET_S: "0.01", AVAIL_TRIAL_HOST: "1", AVAIL_ACCEPTANCE_EMAIL: "acceptance@example.invalid", AVAIL_SUPERVISOR_TOKEN: "s" }, { fetchImpl: b.fetchImpl, exec: b.exec }));
  assert.equal(missed.doc.result, "partial");
  const c = fakeStack();
  const dead = await quiet(() => run(["--dry-run"], { ...quick, AVAIL_TIMEOUT_MS: "600" }, { fetchImpl: c.fetchImpl, exec: async () => { c.state.down = true; } }));
  assert.equal(dead.code, 1);
  assert.equal(dead.doc.result, "fail");
});

test("availability: without the environment it measures nothing", async () => {
  const { code, doc } = await quiet(() => run([], {}, {}));
  assert.deepEqual([code, doc], [2, null]);
});

test("availability on the trial host: refuses without --maintenance-window and for any account but the acceptance account; a canary that is not withdrawn blocks pass", async () => {
  const trial = { ...quick, AVAIL_TARGET_S: "5", AVAIL_TRIAL_HOST: "1", AVAIL_ACCEPTANCE_EMAIL: "acceptance@example.invalid" };
  const a = fakeStack();
  const noWindow = await quiet(() => run(["--dry-run"], trial, { fetchImpl: a.fetchImpl, exec: a.exec }));
  assert.deepEqual([noWindow.code, noWindow.doc], [2, null]);
  assert.equal(a.state.writes, 0, "nothing written when refused");
  const other = fakeStack();
  const wrong = await quiet(() => run(["--dry-run", "--maintenance-window"], { ...trial, AVAIL_ACCEPTANCE_EMAIL: "someone@else.invalid" }, { fetchImpl: other.fetchImpl, exec: other.exec }));
  assert.deepEqual([wrong.code, wrong.doc], [2, null]);
  assert.equal(other.state.writes, 0);
  const keep = fakeStack();
  const noSupervisor = await quiet(() => run(["--dry-run", "--maintenance-window"], trial, { fetchImpl: keep.fetchImpl, exec: keep.exec }));
  assert.equal(noSupervisor.doc.metrics.canary_withdrawn, false);
  assert.equal(noSupervisor.doc.result, "partial", "a canary left in the inbox is never pass");
});

test("crashCommand: the default is a host kill -9 of the container's PID (a crash), compose kill only on request, sudo on request", () => {
  const env = { AVAIL_COMPOSE: "infra/field-trial/trial.sh" };
  const cmd = crashCommand(env, "api");
  assert.match(cmd, /ps -q api/);
  assert.match(cmd, /docker inspect -f '\{\{\.State\.Pid\}\}'/);
  assert.match(cmd, /kill -9 "\$pid"/);
  assert.doesNotMatch(cmd, /kill -s KILL/, "docker compose kill counts as a manual stop: the restart policy would not bring it back");
  assert.match(crashCommand({ ...env, AVAIL_KILL_PREFIX: "sudo" }, "api"), /sudo kill -9/);
  assert.equal(crashCommand({ ...env, AVAIL_CRASH_MODE: "compose" }, "api"), "infra/field-trial/trial.sh kill -s KILL api");
});

test("crashCommand: run in a shell with a fake compose and docker, it kills exactly the PID docker reports, and fails when there is no container", { skip: process.platform === "win32" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "avail-kill-"));
  const victim = spawn("sleep", ["60"], { stdio: "ignore" });
  try {
    const compose = join(dir, "compose.sh"), docker = join(dir, "docker.sh");
    writeFileSync(compose, '#!/bin/sh\n[ "$1" = ps ] && [ "$2" = -q ] && [ "$3" = api ] && echo cid-api\n');
    writeFileSync(docker, `#!/bin/sh\n[ "$1" = inspect ] && echo ${victim.pid}\n`);
    chmodSync(compose, 0o755); chmodSync(docker, 0o755);
    const env = { AVAIL_COMPOSE: compose, AVAIL_DOCKER: docker };
    const none = spawnSync("sh", ["-c", crashCommand(env, "no-such-service")]);
    assert.notEqual(none.status, 0, "no container: the command fails instead of killing something");
    assert.equal(process.kill(victim.pid, 0), true, "the victim is still alive");
    const exited = new Promise((r) => victim.on("exit", (code, sig) => r(sig)));
    const done = spawnSync("sh", ["-c", crashCommand(env, "api")]);
    assert.equal(done.status, 0);
    assert.equal(await exited, "SIGKILL");
  } finally { try { victim.kill("SIGKILL"); } catch { /* gone */ } rmSync(dir, { recursive: true, force: true }); }
});
