import test from "node:test";
import assert from "node:assert/strict";
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
