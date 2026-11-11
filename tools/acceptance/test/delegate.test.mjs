import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runDelegated } from "../lib/delegate.mjs";
import { byName } from "../lib/catalog.mjs";
import { run as refund } from "../scripts/refund.mjs";
import { run as payout } from "../scripts/payout.mjs";

const quiet = async (fn) => { const l = console.log, e = console.error; console.log = console.error = () => {}; try { return await fn(); } finally { console.log = l; console.error = e; } };

test("a delegated row without its database is an environment error and starts nothing", async () => {
  let started = 0;
  const out = await quiet(() => runDelegated("refund", ["sandbox-purchase"], { env: {}, spawn: () => { started++; return { status: 0 }; } }));
  assert.deepEqual(out, { code: 2, doc: null });
  assert.equal(started, 0);
});

test("a delegated row starts live/run.mjs for exactly its scripts and returns its exit code", async () => {
  const calls = [];
  const out = await quiet(() => runDelegated("payout", ["payout-concurrent", "refund-after-payout"], { env: { DATABASE_URL: "postgres://x" }, spawn: (bin, args) => { calls.push(args); return { status: 1 }; } }));
  assert.equal(out.code, 1);
  assert.equal(calls.length, 1);
  assert.match(calls[0][0], /live\/run\.mjs$/);
  assert.equal(calls[0][1], "--only=payout-concurrent,refund-after-payout");
});

test("refund and payout rows are automated, and their scripts exit 2 without a database", async () => {
  assert.equal(byName("refund").mode, "automated");
  assert.equal(byName("payout").mode, "automated");
  const had = process.env.DATABASE_URL; delete process.env.DATABASE_URL;
  try {
    assert.equal((await quiet(() => refund())).code, 2);
    assert.equal((await quiet(() => payout())).code, 2);
  } finally { if (had !== undefined) process.env.DATABASE_URL = had; }
});

// live/run.mjs as the delegated rows and the workflow start it: a child process, judged by its exit code and what it prints
const live = (argv, env = {}) => {
  const { DATABASE_URL: _db, CORE_ACCEPTANCE: _core, ...rest } = process.env;
  return spawnSync(process.execPath, [fileURLToPath(new URL("../live/run.mjs", import.meta.url)), "--dry-run", ...argv], { env: { ...rest, ...env }, encoding: "utf8", timeout: 60_000 });
};

test("live/run.mjs refuses an --only name that is not one of its scripts: it names it, starts nothing and measures nothing", () => {
  // the database is given, as for a delegated row: without the refusal the run would start its server for a list that selects nothing
  const run = live(["--only=sandbox-purchase,no-such-script"], { DATABASE_URL: "postgres://127.0.0.1:9/acceptance_tmp" });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /^ENVIRONMENT: --only: not in this run: no-such-script; nothing measured$/m);
  assert.doesNotMatch(run.stderr, /api exited|did not become healthy|already serves/);
  assert.doesNotMatch(run.stdout, /live summary/);
});

test("live/run.mjs refuses a core-gate script while the gate is off, and lets the names of the run through to the environment check", () => {
  const off = live(["--only=admin-quorum"]);
  assert.equal(off.status, 2);
  assert.match(off.stderr, /^ENVIRONMENT: --only: not in this run: admin-quorum \(the core-gate scripts need CORE_ACCEPTANCE=1\); nothing measured$/m);
  for (const [argv, env] of [[["--only=admin-quorum"], { CORE_ACCEPTANCE: "1" }], [["--only=sandbox-purchase,refund-after-payout"], {}], [[], {}]]) {
    const run = live(argv, env);
    assert.equal(run.status, 2);
    assert.match(run.stderr, /^DATABASE_URL is required$/m);
    assert.doesNotMatch(run.stderr, /--only:/);
  }
});
