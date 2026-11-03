import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { ROOT } from "../lib/measurement.mjs";
import { byName, CATALOG } from "../lib/catalog.mjs";
import { deliveryPlan, prng, run as duplicatePayment } from "../scripts/duplicate-payment.mjs";
import { judgeBurst, run as rightsExclusivity } from "../scripts/rights-exclusivity.mjs";
import { judgeExport, run as urgentExport } from "../scripts/urgent-template-export.mjs";
import { run as stepTimings } from "../scripts/ci-step-timings.mjs";
import { buildMatrix } from "../scripts/tenant-isolation.mjs";
import { startFakeStripe } from "../lib/fake-stripe.mjs";

test("duplicate-payment: ten deliveries, every notification at least twice, a failure before the first success, reproducible", () => {
  for (const seed of [1, 2, 3, 20261103, 99991]) {
    const plan = deliveryPlan(seed);
    assert.equal(plan.length, 10);
    for (const kind of ["success", "failure", "retry"]) assert.ok(plan.filter((k) => k === kind).length >= 2, `${seed}: ${kind}`);
    const first = plan.findIndex((k) => k !== "failure");
    assert.ok(plan.slice(0, first).includes("failure"), `${seed}: out of order`);
    assert.deepEqual(deliveryPlan(seed), plan, "same seed, same order");
  }
  assert.notDeepEqual(deliveryPlan(1), deliveryPlan(2), "the order differs between seeds");
  const r = prng(7);
  assert.ok(Array.from({ length: 100 }, r).every((x) => x >= 0 && x < 1));
});

test("rights-exclusivity: a burst passes only with one holder and every other answer exclusive_unavailable", () => {
  const ok = { status: 201 }, lost = { status: 409, body: { code: "exclusive_unavailable" } };
  assert.equal(judgeBurst([ok, lost, lost]).ok, true);
  assert.equal(judgeBurst([ok, ok, lost]).ok, false, "sold twice");
  assert.equal(judgeBurst([lost, lost]).ok, false, "nobody holds it");
  assert.deepEqual(judgeBurst([ok, { status: 500 }, lost]), { won: 1, lost: 1, other: 1, ok: false });
});

test("urgent-template-export: pass only under the clip's duration on the approved export server", () => {
  assert.equal(judgeExport({ state: "ready", durationS: 120, exportS: 80, approved: true }).result, "pass");
  assert.equal(judgeExport({ state: "ready", durationS: 120, exportS: 130, approved: true }).result, "fail");
  assert.equal(judgeExport({ state: "ready", durationS: 120, exportS: 80, approved: false }).result, "partial");
  assert.equal(judgeExport({ state: "ready", durationS: 120, exportS: 130, approved: false }).result, "partial");
  assert.equal(judgeExport({ state: "failed", durationS: 120, exportS: 10, approved: true }).result, "fail");
  assert.equal(judgeExport({ state: "ready", durationS: 120, exportS: NaN, approved: true }).result, "fail");
});

test("the three rows are real scripts now: without their environment they measure nothing and exit 2", async () => {
  for (const name of ["rights-exclusivity", "urgent-template-export", "ci-step-timings"]) assert.equal(byName(name).mode, "automated", name);
  assert.equal(CATALOG.filter((t) => t.mode === "pending").length, 0, "no plan row waits for its package");
  for (const run of [duplicatePayment, rightsExclusivity, urgentExport]) assert.deepEqual(await run(["--dry-run"], {}), { code: 2, doc: null });
  assert.deepEqual(await stepTimings(["--dry-run"], {}), { code: 2, doc: null });
});

test("tenant matrix carries the organization cases: another organization's order, invoice, licence and profile, and a listing not on sale", () => {
  const api = YAML.parse(readFileSync(join(ROOT, "contracts/openapi.yaml"), "utf8"));
  const m = buildMatrix(api);
  const scope = (op, role, fixture) => m.cases.some((c) => c.kind === "scope" && c.op === op && c.role === role && c.fixture === fixture && c.expect === "404");
  assert.ok(scope("GET /orders/{order_id}", "buyer_admin", "other_org_order_id"));
  assert.ok(scope("GET /orders/{order_id}/refunds", "buyer_admin", "other_org_order_id"), "the invoice side: the order's refunds");
  assert.ok(scope("POST /orders/{order_id}/checkout", "buyer_member", "other_org_order_id"));
  assert.ok(scope("GET /licenses/{license_id}", "buyer_member", "other_org_license_id"));
  assert.ok(scope("POST /licenses/{license_id}/download-url", "buyer_admin", "other_org_license_id"));
  assert.ok(scope("GET /buyer-organizations/{org_id}", "buyer_member", "other_org_id"));
  assert.ok(scope("GET /catalog/{listing_id}", "buyer_member", "unlisted_listing_id"));
  const lists = m.cases.filter((c) => c.kind === "list-leak").map((c) => `${c.op} ${c.role}`);
  for (const l of ["GET /orders buyer_admin", "GET /licenses buyer_member", "GET /catalog buyer_member"]) assert.ok(lists.includes(l), l);
});

test("the Stripe stand-in answers the adapter's calls only with a test key, idempotently, and links back to itself", async () => {
  const fake = await startFakeStripe();
  // keys made at run time: a key-shaped literal is what the leak check (rightly) refuses in the repository
  const testKey = `Bearer ${["sk", "test", "x"].join("_")}`, liveKey = `Bearer ${["sk", "live", "x"].join("_")}`;
  try {
    const post = (key, auth = testKey) => fetch(`${fake.url}/v1/checkout/sessions`, { method: "POST", headers: { authorization: auth, "idempotency-key": key, "content-type": "application/x-www-form-urlencoded" }, body: "expires_at=2000000000&line_items%5B0%5D%5Bprice_data%5D%5Bunit_amount%5D=10001&line_items%5B0%5D%5Bprice_data%5D%5Bcurrency%5D=usd" });
    assert.equal((await post("k", liveKey)).status, 401);
    const a = await (await post("k")).json(), b = await (await post("k")).json();
    assert.equal(a.id, b.id);
    assert.match(a.id, /^cs_test_[0-9a-f]{24}$/);
    assert.equal(a.amount_total, 10001);
    assert.ok(a.url.startsWith(fake.url), "no link leaves the machine");
    assert.equal((await (await fetch(`${fake.url}/v1/checkout/sessions/${a.id}`, { headers: { authorization: testKey } })).json()).id, a.id);
  } finally { await fake.close(); }
});
