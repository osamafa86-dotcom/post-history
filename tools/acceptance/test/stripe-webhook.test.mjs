import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHmac } from "node:crypto";
import { run, stripeEvent, stripeSignature } from "../scripts/stripe-webhook.mjs";
import { byName } from "../lib/catalog.mjs";
import { validateMeasurement } from "../lib/measurement.mjs";

const quiet = async (fn) => { const l = console.log, e = console.error; console.log = console.error = () => {}; try { return await fn(); } finally { console.log = l; console.error = e; } };

const SECRET = "whsec_test_secret";
const IDS = { reporter: "11111111-1111-4111-8111-111111111111", org: "22222222-2222-4222-8222-222222222222", order: "33333333-3333-4333-8333-333333333333" };
const REF = "cs_test_fake";

/** خادم وهمي يقلّد العقد: API بـ /v1 ومسار الويبهوك خارج البادئة، مع منع التكرار بالمعرّف كما في الخادم. */
function fakeStack({ noDedupe = false, provider = "stripe" } = {}) {
  const state = { providerRef: null, applied: 0, events: new Map() };
  const json = (res, status, body, headers = {}) => { res.writeHead(status, { "content-type": "application/json", ...headers }); res.end(JSON.stringify(body)); };
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks);
    const url = req.url;
    if (req.method === "GET" && url === "/v1/auth/me") return json(res, 200, { user_id: IDS.reporter, email: "r@example.test" });
    if (req.method === "GET" && url === "/v1/forms/current") return json(res, 200, { version: 1 });
    if (req.method === "POST" && url === "/v1/materials") return json(res, 201, { id: "mat" });
    if (req.method === "POST" && url === "/v1/license-templates") return json(res, 201, { id: "tpl" });
    if (req.method === "POST" && url === "/v1/materials/mat/listing") return json(res, 201, { id: "list", state: "listed" });
    if (req.method === "POST" && url === "/v1/buyer-organizations") return json(res, 201, { id: IDS.org, legal_name: "x", display_name: {}, country: "JO", billing_email: "b@example.test", seats: 2 }, { etag: '"1"' });
    if (req.method === "PUT" && url === `/v1/buyer-organizations/${IDS.org}`) return json(res, 200, { status: "active" });
    if (req.method === "POST" && url === "/v1/orders") return json(res, 201, { id: IDS.order, status: "pending_payment", items: [{ id: "item" }], total: { amount_minor: 10001, currency: "USD" } });
    if (req.method === "POST" && url === `/v1/orders/${IDS.order}/checkout`) {
      if (provider !== "stripe") return json(res, 200, { provider, checkout_url: "http://mock/sandbox" });
      state.providerRef = REF;
      return json(res, 200, { provider: "stripe", checkout_url: `http://mock/${REF}` });
    }
    if (req.method === "POST" && url === "/payments/webhooks/stripe") {
      const header = req.headers["stripe-signature"] ?? "";
      const t = header.split(",").map((p) => p.trim().split("=")).find(([k]) => k === "t")?.[1];
      const v1 = header.split(",").map((p) => p.trim().split("=")).find(([k]) => k === "v1")?.[1];
      const expected = createHmac("sha256", SECRET).update(`${t}.`).update(raw).digest("hex");
      if (!t || v1 !== expected) return json(res, 400, { code: "webhook_signature_invalid" });
      const e = JSON.parse(raw.toString("utf8"));
      if (e.livemode === true) return json(res, 400, { code: "live_payments_disabled" });
      if (e.type !== "checkout.session.completed") return json(res, 200, { received: true }); // نوع مهمل: لا يُخزَّن
      if (!noDedupe && state.events.has(e.id)) return json(res, 200, { received: true });
      if (e.data?.object?.id !== state.providerRef) { state.events.set(e.id, { outcome: "ignored", order_id: null }); return json(res, 200, { received: true }); }
      state.applied++;
      state.events.set(e.id, { outcome: "applied", order_id: IDS.order });
      return json(res, 200, { received: true });
    }
    return json(res, 404, { code: "not_found" });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, state, url: `http://127.0.0.1:${server.address().port}` })));
}

/** قاعدة وهمية تقرأ حالة الخادم الوهمي: صفوف الأحداث والطلب والتراخيص والقيود تتبع ما طُبّق فعلًا. */
const fakeDb = (state) => ({
  async query(text, params = []) {
    if (text.includes("UPDATE materials") || text.includes("INSERT INTO material_files")) return { rows: [] };
    if (text.includes("FROM payment_events") && text.includes("SELECT outcome")) {
      const row = state.events.get(params[0]);
      return { rows: row ? [{ outcome: row.outcome, order_id: row.order_id }] : [] };
    }
    if (text.includes("FROM payment_events") && text.includes("event_id")) return { rows: [{ n: state.events.has(params[0]) ? 1 : 0 }] };
    if (text.includes("FROM payment_events")) return { rows: [{ n: state.events.size }] };
    if (text.includes("FROM orders")) return { rows: [{ status: state.applied > 0 ? "paid" : "pending_payment", provider_ref: state.providerRef }] };
    if (text.includes("FROM licenses")) return { rows: [{ n: state.applied }] };
    if (text.includes("FROM journal_entries")) return { rows: Array.from({ length: state.applied }, (_, i) => ({ id: `j${i}` })) };
    if (text.includes("FROM postings")) {
      return { rows: [
        { kind: "provider_clearing", owner_id: null, state: null, currency: "USD", amount: "10001" },
        { kind: "platform_revenue", owner_id: null, state: null, currency: "USD", amount: "-3000" },
        { kind: "contributor_payable", owner_id: IDS.reporter, state: "pending", currency: "USD", amount: "-7001" },
      ] };
    }
    return { rows: [] };
  },
  async end() {},
});

const tokens = JSON.stringify({ system_admin: "a", rights_officer: "r", reporter: "rep", buyer_admin: "b" });
const envOf = (url) => ({ SW_API_URL: `${url}/v1`, SW_ROOT_URL: url, SW_DATABASE_URL: "postgres://fake", SW_WEBHOOK_SECRET: SECRET, SW_TOKENS: tokens });

test("the signature is Stripe's: t=<seconds>,v1=HMAC-SHA256(t.body) hex, and changes with secret and body", () => {
  const body = stripeEvent({ id: "evt_a", type: "checkout.session.completed", object: { id: REF } });
  const sig = stripeSignature(SECRET, body, new Date(1760000000_000));
  assert.match(sig, /^t=1760000000,v1=[0-9a-f]{64}$/);
  assert.equal(sig, stripeSignature(SECRET, body, new Date(1760000000_999)), "same second, same signature");
  assert.notEqual(sig, stripeSignature("other", body, new Date(1760000000_000)));
  assert.notEqual(sig, stripeSignature(SECRET, stripeEvent({ id: "evt_b", type: "x", object: {} }), new Date(1760000000_000)));
  const parsed = JSON.parse(body.toString("utf8"));
  assert.equal(parsed.id, "evt_a");
  assert.equal(parsed.livemode, false);
  assert.equal(typeof parsed.created, "number");
});

test("happy path: forged, live-mode, applied, ten replays and same-id-different-body all judged; a valid measurement is written", async () => {
  const { server, state, url } = await fakeStack();
  const { code, doc } = await quiet(() => run(["--dry-run"], envOf(url), { connectDb: async () => fakeDb(state) }));
  server.close();
  assert.equal(code, 0);
  assert.equal(doc.result, "partial", "test provider, SQL fixtures, one run: never pass");
  assert.equal(doc.metrics.notification_replays, 10);
  assert.equal(doc.metrics.sale_entries, 1);
  assert.equal(doc.metrics.licenses, 1);
  assert.equal(doc.metrics.payment_events_stored, 2, "the applied event and the unknown session; the ignored type is not stored");
  assert.ok(validateMeasurement(doc).ok);
});

test("a server without dedupe (every replay applies again) fails the script", async () => {
  const { server, state, url } = await fakeStack({ noDedupe: true });
  const { code, doc } = await quiet(() => run(["--dry-run"], envOf(url), { connectDb: async () => fakeDb(state) }));
  server.close();
  assert.equal(code, 1);
  assert.equal(doc.result, "fail");
});

test("a server not running the Stripe provider is an environment error, not a result", async () => {
  const { server, state, url } = await fakeStack({ provider: "sandbox" });
  const { code, doc } = await quiet(() => run(["--dry-run"], envOf(url), { connectDb: async () => fakeDb(state) }));
  server.close();
  assert.equal(code, 2);
  assert.equal(doc, null);
});

test("without its environment the script measures nothing and exits 2; the row is in the catalog", async () => {
  assert.deepEqual(await quiet(() => run(["--dry-run"], {})), { code: 2, doc: null });
  assert.ok(byName("stripe-webhook"));
});
