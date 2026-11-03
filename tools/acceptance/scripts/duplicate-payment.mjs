// duplicate-payment — plan row «الدفع المكرر»: replaying the gateway notification ten times, in a different order, creates no
// second licence and no second financial entry. Measured on a running server for each provider it is given:
//   sandbox  (the internal provider, ADR 0032)           DP_API_URL DP_ROOT_URL DP_WEBHOOK_SECRET
//   stripe   (Stripe test mode, the server's adapter)    DP_STRIPE_API_URL DP_STRIPE_ROOT_URL DP_STRIPE_WEBHOOK_SECRET
//   shared:  DP_DATABASE_URL  DP_TOKENS='{"reporter":"…","rights_officer":"…","buyer_admin":"…"}'  [DP_COMMISSION_BP=3000] [DP_SEED=20261103]
// Per provider, on a fresh order each: (1) ten deliveries drawn from one success, one failure that arrives out of order and a
// provider retry of the success under a new event id, shuffled by a fixed seed; (2) ten concurrent copies of one success. Then:
// every delivery answered 200, the order is paid, exactly one licence per item, exactly one sale entry, balanced and split
// by the commission rule, and one stored event per distinct event id. The sandbox also runs its hosted page's own
// `duplicate` and `out_of_order` buttons. Signatures are made here with the stack's test secrets: no real gateway, no real money.
// Result: pass only when both providers were measured and every check holds; one provider alone is partial.
import { randomBytes } from "node:crypto";
import pg from "pg";
import { newResult, finish, writeResult, parseArgs, banner } from "../lib/measurement.mjs";
import { byName } from "../lib/catalog.mjs";
import { client } from "../lib/live.mjs";
import { commerce, signBody } from "../lib/commerce.mjs";
import { judgeSale } from "../live/sandbox-purchase.mjs";
import { stripeEvent, stripeSignature } from "./stripe-webhook.mjs";

const PRICE = 10001; // 100.01: odd, so the largest-remainder split is exercised
const REPLAYS = 10; // the row: «عشر مرات»

/** Deterministic PRNG (mulberry32): the shuffled order is reproducible from the seed in the result. */
export function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Ten deliveries from three notifications: the success, a failure for the same payment, and a retry of the success with a new
 * event id. Each appears at least twice, the failure first at least once before any success is guaranteed (out of order).
 */
export function deliveryPlan(seed, n = REPLAYS) {
  const rand = prng(seed);
  const pool = ["success", "success", "failure", "failure", "retry", "retry"];
  while (pool.length < n) pool.push(["success", "failure", "retry"][Math.floor(rand() * 3)]);
  for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
  // out of order on purpose: a failure precedes the first success
  const firstSuccess = pool.findIndex((k) => k !== "failure");
  if (!pool.slice(0, firstSuccess).includes("failure")) { const f = pool.indexOf("failure"); [pool[firstSuccess], pool[f]] = [pool[f], pool[firstSuccess]]; }
  return pool;
}

/** Provider adapters: how a notification body is built and signed, where it goes. */
function sandboxAdapter(root, secret) {
  const body = (type, ref, id = `sbe_${randomBytes(12).toString("hex")}`) => Buffer.from(JSON.stringify({ event_id: id, type, provider_ref: ref, amount: { amount_minor: PRICE, currency: "USD" }, occurred_at: new Date().toISOString() }));
  return {
    name: "sandbox",
    notifications: (ref) => ({ success: body("payment.succeeded", ref), failure: body("payment.failed", ref), retry: body("payment.succeeded", ref) }),
    send: (raw) => {
      const ts = Math.floor(Date.now() / 1000);
      return fetch(`${root}/payments/webhooks/sandbox`, { method: "POST", headers: { "content-type": "application/json", "x-timestamp": String(ts), "x-signature": signBody(secret, ts, raw) }, body: raw });
    },
  };
}
function stripeAdapter(root, secret) {
  const object = (ref) => ({ id: ref, payment_status: "paid", amount_total: PRICE, currency: "usd" });
  const event = (type, ref) => stripeEvent({ id: `evt_${randomBytes(12).toString("hex")}`, type, object: object(ref) });
  return {
    name: "stripe",
    notifications: (ref) => ({ success: event("checkout.session.completed", ref), failure: event("checkout.session.async_payment_failed", ref), retry: event("checkout.session.async_payment_succeeded", ref) }),
    send: (raw) => fetch(`${root}/payments/webhooks/stripe`, { method: "POST", headers: { "content-type": "application/json", "stripe-signature": stripeSignature(secret, raw) }, body: raw }),
  };
}

export async function run(argv = process.argv.slice(2), env = process.env) {
  const args = parseArgs(argv);
  banner(byName("duplicate-payment"));
  const providers = [];
  if (env.DP_API_URL && env.DP_ROOT_URL && env.DP_WEBHOOK_SECRET) providers.push({ api: env.DP_API_URL, adapter: sandboxAdapter(env.DP_ROOT_URL.replace(/\/$/, ""), env.DP_WEBHOOK_SECRET) });
  if (env.DP_STRIPE_API_URL && env.DP_STRIPE_ROOT_URL && env.DP_STRIPE_WEBHOOK_SECRET) providers.push({ api: env.DP_STRIPE_API_URL, adapter: stripeAdapter(env.DP_STRIPE_ROOT_URL.replace(/\/$/, ""), env.DP_STRIPE_WEBHOOK_SECRET) });
  const need = ["DP_DATABASE_URL", "DP_TOKENS"].filter((k) => !env[k]);
  if (!providers.length || need.length) {
    console.error(`ENVIRONMENT: ${providers.length ? `missing ${need.join(", ")}` : "no provider (DP_API_URL+DP_ROOT_URL+DP_WEBHOOK_SECRET or the DP_STRIPE_ set)"}; nothing measured`);
    return { code: 2, doc: null };
  }
  const tokens = JSON.parse(env.DP_TOKENS);
  const missingRoles = ["reporter", "rights_officer", "buyer_admin"].filter((r) => !tokens[r]);
  if (missingRoles.length) { console.error(`ENVIRONMENT: DP_TOKENS needs ${missingRoles.join(", ")}; nothing measured`); return { code: 2, doc: null }; }
  const bp = Number(env.DP_COMMISSION_BP ?? 3000);
  const seed = Number(env.DP_SEED ?? 20261103);
  const doc = newResult("duplicate-payment", { device: { platform: "server", model: env.DP_ENV_LABEL ?? "server" }, upload_path: "n/a" });
  const fails = [], metrics = { seed, replays: REPLAYS, commission_basis_points: bp, price_minor: PRICE };
  let checks = 0;
  const check = (name, ok, why = "") => { checks++; if (!ok) { fails.push(`${name}${why ? `: ${why}` : ""}`); console.log(`FAIL ${name} ${why}`); } else console.log(`ok   ${name}`); return ok; };
  const db = new pg.Client({ connectionString: env.DP_DATABASE_URL });
  await db.connect();
  const q = async (text, params) => (await db.query(text, params)).rows;
  const n = async (text, params) => Number((await q(text, params))[0].n);
  const measured = [];
  try {
    for (const { api, adapter } of providers) {
      const http = client(api);
      const c = commerce({ http, db, tokens });
      const me = await http.get(tokens.reporter, "/auth/me");
      const reporterId = me.body?.user_id;
      const templateId = await c.template("editorial_single", PRICE);
      /** A fresh order on its own listed material, its checkout opened (provider reference from the order row). */
      const fresh = async (label) => {
        const listing = await c.list(await c.material(`dp-${adapter.name}-${label}`), templateId);
        if (listing.status !== 201) throw new Error(`listing answered ${listing.status}`);
        const order = await c.order(tokens.buyer_admin, listing.body.id, templateId);
        if (order.status !== 201) throw new Error(`order answered ${order.status}`);
        const co = await http.call(tokens.buyer_admin, "POST", `/orders/${order.body.id}/checkout`, { body: {} });
        if (co.status !== 200 || co.body?.provider !== adapter.name) throw new Error(`checkout answered ${co.status} provider=${co.body?.provider ?? "none"}`);
        const ref = (await q(`SELECT provider_ref FROM orders WHERE id = $1`, [order.body.id]))[0].provider_ref;
        return { orderId: order.body.id, ref };
      };
      /** The order's effect in the ledger and licences, judged against one sale. */
      const judge = async (label, orderId, eventIds) => {
        const p = `${adapter.name} ${label}`;
        check(`${p}: the order is paid`, (await q(`SELECT status FROM orders WHERE id = $1`, [orderId]))[0]?.status === "paid");
        const licences = await n(`SELECT count(*) AS n FROM licenses l JOIN order_items i ON i.id = l.order_item_id WHERE i.order_id = $1`, [orderId]);
        check(`${p}: exactly one licence`, licences === 1, `${licences}`);
        const sales = await q(`SELECT id FROM journal_entries WHERE kind = 'sale' AND reference_type = 'order' AND reference_id = $1`, [orderId]);
        check(`${p}: exactly one sale entry`, sales.length === 1, `${sales.length}`);
        // the release worker may already have moved the reporter's share to available (one `release` entry, ADR 0034): that is
        // not a duplicate; any kind twice is
        const kinds = await q(`SELECT kind, count(*)::int AS n FROM journal_entries WHERE reference_type = 'order' AND reference_id = $1 GROUP BY kind`, [orderId]);
        check(`${p}: no financial entry twice, and none but the sale and its release`, kinds.every((k) => k.n === 1 && ["sale", "release"].includes(k.kind)), kinds.map((k) => `${k.kind}×${k.n}`).join(","));
        if (sales.length === 1) {
          const lines = (await q(`SELECT a.kind, a.owner_id::text AS owner_id, a.payable_state AS state, p.currency, p.amount_minor::text AS amount FROM postings p JOIN ledger_accounts a ON a.id = p.account_id WHERE p.entry_id = $1`, [sales[0].id]))
            .map((r) => ({ ...r, amount: BigInt(r.amount) }));
          const problems = judgeSale(lines, { total: BigInt(PRICE), currency: "USD", bp, reporterId });
          check(`${p}: the sale entry is balanced and split by the commission rule`, problems.length === 0, problems.join("; "));
        }
        if (eventIds) {
          const stored = await n(`SELECT count(*) AS n FROM payment_events WHERE provider = $1 AND order_id = $2`, [adapter.name, orderId]);
          check(`${p}: one stored event per distinct notification`, stored === eventIds.size, `${stored} for ${eventIds.size}`);
        }
      };
      const idOf = (raw) => { const j = JSON.parse(raw.toString("utf8")); return j.event_id ?? j.id; };

      // (1) ten deliveries, shuffled, out of order, with a provider retry under a new id
      const a = await fresh("shuffled");
      const notes = adapter.notifications(a.ref);
      const plan = deliveryPlan(seed);
      metrics[`${adapter.name}_order`] = plan.join(",");
      const answers = [];
      for (const kind of plan) answers.push((await adapter.send(notes[kind])).status);
      check(`${adapter.name} shuffled: every delivery answered 200`, answers.every((s) => s === 200), answers.join(","));
      await judge("shuffled", a.orderId, new Set(plan.map((k) => idOf(notes[k]))));

      // (2) ten concurrent copies of one success
      const b = await fresh("concurrent");
      const one = adapter.notifications(b.ref).success;
      const burst = await Promise.all(Array.from({ length: REPLAYS }, () => adapter.send(one)));
      check(`${adapter.name} concurrent: every copy answered 200`, burst.every((r) => r.status === 200), burst.map((r) => r.status).join(","));
      await judge("concurrent", b.orderId, new Set([idOf(one)]));

      // (3) the sandbox hosted page's own buttons: the same notification ten times, and a failure after the success
      if (adapter.name === "sandbox") {
        for (const outcome of ["duplicate", "out_of_order"]) {
          const o = await fresh(outcome);
          const page = await fetch(`${env.DP_ROOT_URL.replace(/\/$/, "")}/sandbox/checkout/${o.ref}/${outcome}`, { method: "POST" });
          check(`sandbox ${outcome} button answered 202`, page.status === 202, `${page.status}`);
          await judge(outcome, o.orderId, null);
        }
      }
      measured.push(adapter.name);
    }
  } catch (e) {
    fails.push(`aborted: ${String(e.message).replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, "<url>").slice(0, 200)}`);
    console.error(e.stack ?? e);
  } finally {
    await db.end();
  }
  const failed = fails.length > 0;
  const both = measured.includes("sandbox") && measured.includes("stripe");
  Object.assign(metrics, { providers_measured: measured.join(",") || "none", checks, checks_failed: fails.length });
  finish(doc, failed ? "fail" : both ? "pass" : "partial", metrics, failed ? fails.join("؛ ") : [
    `إشعار البوابة عشر مرات بترتيب مخلوط ثابت البذرة (${seed}): النجاح، وفشلٌ للدفعة نفسها يصل قبله، وإعادة المزوّد للنجاح بمعرّف جديد؛ ثم عشر نسخ متزامنة من نجاح واحد؛ ${measured.includes("sandbox") ? "وزرّا duplicate وout_of_order في صفحة المزوّد التجريبي؛ " : ""}على ${measured.join(" و")}`,
    "النتيجة لكل طلب: مدفوع، وترخيص واحد، وقيد بيع واحد متوازن بحصة المنصة، ولا قيد يتكرر (قيد التحرير وحده يتبعه)، وحدث مخزَّن واحد لكل معرّف",
    "التواقيع من هذا السكربت بأسرار الاختبار للمكدس، وStripe بوضع الاختبار عبر بديل محلي لواجهته؛ لا بوابة حقيقية ولا مال حقيقي",
    both ? null : "جزئي: مزوّد واحد قيس من اثنين",
  ].filter(Boolean).join("؛ "));
  if (args["dry-run"]) writeResult(doc, { dryRun: true });
  else console.log("wrote", writeResult(doc, { slug: measured.join("-") || "none" }));
  return { code: failed ? 1 : 0, doc };
}

if (process.argv[1] === new URL(import.meta.url).pathname) process.exit((await run()).code);
