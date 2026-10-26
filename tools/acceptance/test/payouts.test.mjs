import test from "node:test";
import assert from "node:assert/strict";
import { DEBIT_BALANCE_SQL, balanceOf, expectedAccepted, judgeDebitBalances } from "../live/payout-fixtures.mjs";
import { run as runConcurrent } from "../live/payout-concurrent.mjs";
import { run as runRefund } from "../live/refund-after-payout.mjs";
import { byName } from "../lib/catalog.mjs";

test("the expected number of accepted simultaneous requests is what the balance can serve, never more than were sent", () => {
  assert.equal(expectedAccepted(7001n, 2000n, 5), 3);
  assert.equal(expectedAccepted(7001n, 4000n, 2), 1);
  assert.equal(expectedAccepted(9000n, 2000n, 3), 3);
  assert.equal(expectedAccepted(1999n, 2000n, 5), 0);
  assert.equal(expectedAccepted(5n, 0n, 5), 0);
});

test("a payable account on the debit side is named; none is none", () => {
  assert.deepEqual(judgeDebitBalances([]), []);
  const out = judgeDebitBalances([{ id: "a1", state: "available", balance: "17" }]);
  assert.equal(out.length, 1);
  assert.match(out[0], /a1 \(available\) is 17 on the debit side/);
  assert.match(DEBIT_BALANCE_SQL, /contributor_payable/);
});

test("balances are read per currency as integers, and a currency the reporter has no account in is null", () => {
  const e = { balances: [{ currency: "USD", pending: { amount_minor: 1 }, available: { amount_minor: 7001 }, in_payout: { amount_minor: 0 }, paid: { amount_minor: 2 }, requestable: { amount_minor: 7001 }, minimum: { amount_minor: 1000 } }] };
  assert.deepEqual(balanceOf(e), { pending: 1n, available: 7001n, in_payout: 0n, paid: 2n, requestable: 7001n, minimum: 1000n });
  assert.equal(balanceOf(e, "ILS"), null);
  assert.equal(balanceOf({}), null);
});

test("without their environment both scripts measure nothing and exit 2; both are named tests of the catalog", async () => {
  const quiet = async (fn) => { const log = console.log, err = console.error; console.log = () => {}; console.error = () => {}; try { return await fn(); } finally { console.log = log; console.error = err; } };
  for (const run of [runConcurrent, runRefund]) { const r = await quiet(() => run(["--dry-run"], {})); assert.equal(r.code, 2); assert.equal(r.doc, null); }
  assert.ok(byName("payout-concurrent") && byName("refund-after-payout"));
});
