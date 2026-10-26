import test from "node:test";
import assert from "node:assert/strict";
import { expectedSplit, judgeRefundMirror, judgeSale, run, signBody } from "../live/sandbox-purchase.mjs";
import { byName } from "../lib/catalog.mjs";

const REPORTER = "11111111-1111-4111-8111-111111111111";
const sale = (platform, contributors, over = {}) => [
  { kind: "provider_clearing", owner_id: null, state: null, currency: "USD", amount: platform + contributors },
  { kind: "platform_revenue", owner_id: null, state: null, currency: "USD", amount: -platform },
  { kind: "contributor_payable", owner_id: REPORTER, state: "pending", currency: "USD", amount: -contributors, ...over },
];
const ctx = { total: 10001n, currency: "USD", bp: 3000, reporterId: REPORTER };

test("the split is the largest remainder, independent of the server's code", () => {
  assert.deepEqual(expectedSplit(10001n, 3000), { platform: 3000n, contributors: 7001n });
  assert.deepEqual(expectedSplit(10000n, 3000), { platform: 3000n, contributors: 7000n });
  assert.deepEqual(expectedSplit(3n, 5000), { platform: 1n, contributors: 2n }, "a tie on the remainder goes to the smaller key (contributors)");
  for (const total of [1n, 7n, 99n, 10001n, 123456789n]) for (const bp of [0, 1, 3000, 3333, 10000]) {
    const s = expectedSplit(total, bp);
    assert.equal(s.platform + s.contributors, total);
  }
});

test("a correct sale entry has no problems; each wrong share, imbalance, extra line or wrong account is named", () => {
  assert.deepEqual(judgeSale(sale(3000n, 7001n), ctx), []);
  assert.ok(judgeSale(sale(2999n, 7001n), ctx).some((p) => /unbalanced|platform revenue/.test(p)), "off by one on the platform");
  assert.ok(judgeSale(sale(3001n, 7000n), ctx).some((p) => /platform revenue/.test(p)), "split moved by one unit keeps the entry balanced but is wrong");
  assert.ok(judgeSale([...sale(3000n, 7001n), { kind: "taxes", owner_id: null, state: null, currency: "USD", amount: 0n }], ctx).some((p) => /lines/.test(p)));
  assert.ok(judgeSale(sale(3000n, 7001n, { state: "available" }), ctx).some((p) => /reporter pending/.test(p)), "the reporter's balance must be pending");
  assert.ok(judgeSale(sale(3000n, 7001n, { owner_id: "22222222-2222-4222-8222-222222222222" }), ctx).some((p) => /reporter pending/.test(p)));
  assert.ok(judgeSale(sale(3000n, 7001n).slice(0, 2), ctx).length > 0);
});

test("a refund entry must mirror the sale on the same accounts", () => {
  const s = sale(3000n, 7001n);
  const mirror = s.map((l) => ({ ...l, amount: -l.amount }));
  assert.deepEqual(judgeRefundMirror(s, mirror), []);
  assert.ok(judgeRefundMirror(s, mirror.map((l, i) => (i === 1 ? { ...l, amount: l.amount + 1n } : l))).length > 0);
  assert.ok(judgeRefundMirror(s, mirror.map((l) => (l.kind === "contributor_payable" ? { ...l, state: "available" } : l))).some((p) => /did not/.test(p)));
  assert.ok(judgeRefundMirror(s, mirror.slice(1)).length > 0);
});

test("the signature is the sandbox provider's: v1=HMAC-SHA256(timestamp.body), hex", () => {
  const sig = signBody("s".repeat(32), 1760000000, Buffer.from("{}"));
  assert.match(sig, /^v1=[0-9a-f]{64}$/);
  assert.notEqual(sig, signBody("s".repeat(32), 1760000001, Buffer.from("{}")));
  assert.notEqual(sig, signBody("t".repeat(32), 1760000000, Buffer.from("{}")));
});

test("without its environment the script measures nothing and exits 2; the row is in the catalog", async () => {
  assert.deepEqual(await run(["--dry-run"], {}), { code: 2, doc: null });
  assert.deepEqual(await run(["--dry-run"], { SP_API_URL: "x", SP_ROOT_URL: "x", SP_DATABASE_URL: "x", SP_WEBHOOK_SECRET: "x", SP_TOKENS: "{}" }), { code: 2, doc: null });
  assert.ok(byName("sandbox-purchase"));
});
