#!/usr/bin/env node
// stripe-webhook — الجزء القابل للقياس محليًا من اختبار القبول «الدفع المكرر» (الصف الثاني عشر من جدول «اختبارات القبول»
// في docs/plan/الخطة-النسخة-الثالثة.md): «إعادة إشعار البوابة عشر مرات وبترتيب مختلف دون تكرار ترخيص أو قيد مالي».
// يقيسه على خادم محلي يعمل بمزوّد Stripe في وضع الاختبار (المحوّل في apps/api/src/commerce/):
//   توقيع غير صحيح ← 400 webhook_signature_invalid ولا أثر في القاعدة (لا payment_events ولا قيد ولا ترخيص)،
//   حدث livemode: true موقّع صحيح ← 400 live_payments_disabled ولا أثر،
//   الإشعار الصحيح ← 200 وطلب مدفوع وترخيص واحد وقيد sale واحد متوازن بحصة المنصة من قاعدة العمولة،
//   إعادة الإشعار نفسه عشر مرات ← 200 بلا أثر ثانٍ (لا ترخيص ولا قيد ولا صف payment_events جديد)،
//   والمعرّف نفسه بجسم مختلف ← 200 بلا أثر (المنع بالمعرّف)، والنوع المجهول ← 200 ولا يُخزَّن، والمرجع المجهول ← 200 «ignored».
// النتيجة `partial` دائمًا: مزوّد اختبار لا مال حقيقي، وصفّوف الحقوق والملف المتحقق تُزرع بـSQL لأن عامل الوسائط ليس
// في هذا المكدس، وتشغيل واحد. يحتاج الخادم PAYMENT_PROVIDER=stripe ومفاتيح الاختبار وواجهة STRIPE_API_BASE المحلية.
//   SW_API_URL=http://127.0.0.1:13000/v1  SW_ROOT_URL=http://127.0.0.1:13000  SW_DATABASE_URL=postgres://…
//   SW_WEBHOOK_SECRET=whsec_…  SW_TOKENS='{"system_admin":"…","rights_officer":"…","reporter":"…","buyer_admin":"…"}'
//   [SW_COMMISSION_BP=3000]
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { newResult, finish, writeResult, parseArgs, banner } from "../lib/measurement.mjs";
import { byName } from "../lib/catalog.mjs";
import { client, materialBody } from "../lib/live.mjs";
import { judgeSale } from "../live/sandbox-purchase.mjs";

const PRICE = 10001n; // 100.01: فردي عمدًا ليمارَس تقسيم الباقي الأكبر (3000 / 7001 عند 30%)
const REPLAYS = 10; // معيار الصف: «عشر مرات»

/** جسم حدث Stripe الخام (ما يوقّعه Stripe ونوقّعه مكانه في الاختبار). */
export function stripeEvent({ id, type, object, created = Math.floor(Date.now() / 1000), livemode = false }) {
  return Buffer.from(JSON.stringify({ id, type, created, livemode, data: { object } }));
}

/** ترويسة Stripe-Signature كما يبنيها stripeSignatureHeader في المحوّل: t=<ثوانٍ>,v1=HMAC-SHA256(t.body) hex. */
export function stripeSignature(secret, rawBody, now = new Date()) {
  const t = Math.floor(now.getTime() / 1000);
  return `t=${t},v1=${createHmac("sha256", secret).update(`${t}.`).update(rawBody).digest("hex")}`;
}

const eventId = () => `evt_${randomBytes(12).toString("hex")}`;
const toLines = (rows) => rows.map((r) => ({ kind: r.kind, owner_id: r.owner_id, state: r.state, currency: r.currency, amount: BigInt(r.amount) }));

const defaultConnect = async (url) => {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  return c;
};

export async function run(argv = process.argv.slice(2), env = process.env, deps = {}) {
  const args = parseArgs(argv);
  banner(byName("stripe-webhook"));
  const need = ["SW_API_URL", "SW_ROOT_URL", "SW_DATABASE_URL", "SW_WEBHOOK_SECRET", "SW_TOKENS"].filter((k) => !env[k]);
  if (need.length) { console.error(`ENVIRONMENT: missing ${need.join(", ")}; nothing measured`); return { code: 2, doc: null }; }
  const tokens = JSON.parse(env.SW_TOKENS);
  const missingRoles = ["system_admin", "rights_officer", "reporter", "buyer_admin"].filter((r) => !tokens[r]);
  if (missingRoles.length) { console.error(`ENVIRONMENT: SW_TOKENS needs ${missingRoles.join(", ")}; nothing measured`); return { code: 2, doc: null }; }
  const bp = Number(env.SW_COMMISSION_BP ?? 3000);
  const secret = env.SW_WEBHOOK_SECRET;
  const root = env.SW_ROOT_URL.replace(/\/$/, "");
  const http = client(env.SW_API_URL);
  const connect = deps.connectDb ?? defaultConnect;
  const doc = newResult("stripe-webhook", { device: { platform: "server", model: env.SW_ENV_LABEL ?? "server" }, upload_path: "n/a" });
  const fails = [], metrics = {};
  const check = (name, ok, why = "") => { if (!ok) { fails.push(`${name}${why ? `: ${why}` : ""}`); console.log(`FAIL ${name} ${why}`); } else console.log(`ok   ${name}`); return ok; };

  const db = await connect(env.SW_DATABASE_URL);
  const q = async (text, params) => (await db.query(text, params)).rows;
  const one = async (text, params) => (await q(text, params))[0];
  // أثر الإشعارات في القاعدة: صفوف الأحداث المخزنة، وحالة الطلب، وعدد التراخيص، وقيود البيع
  const storedEvents = async () => Number((await one(`SELECT count(*) AS n FROM payment_events WHERE provider = 'stripe'`)).n);
  const eventsFor = async (id) => Number((await one(`SELECT count(*) AS n FROM payment_events WHERE provider = 'stripe' AND event_id = $1`, [id])).n);
  const orderState = async (id) => one(`SELECT status, provider_ref FROM orders WHERE id = $1`, [id]);
  const licenseCount = async (orderId) => Number((await one(`SELECT count(*) AS n FROM licenses l JOIN order_items i ON l.order_item_id = i.id WHERE i.order_id = $1`, [orderId])).n);
  const saleEntries = async (orderId) => q(`SELECT j.id FROM journal_entries j WHERE j.kind = 'sale' AND j.reference_type = 'order' AND j.reference_id = $1`, [orderId]);
  const send = (raw, { sig } = {}) =>
    fetch(`${root}/payments/webhooks/stripe`, { method: "POST", headers: { "content-type": "application/json", "stripe-signature": sig ?? stripeSignature(secret, raw) }, body: raw });

  try {
    // ---------- تجهيز: مادة قابلة للبيع بأصل متحقق (يُزرع بـSQL لغياب عامل الوسائط)، وقالب وإدراج، ومؤسسة مشترٍ ----------
    const me = await http.get(tokens.reporter, "/auth/me");
    const reporterId = me.body?.user_id;
    check("reporter identity", me.status === 200 && /^[0-9a-f-]{36}$/.test(reporterId ?? ""), `status ${me.status}`);
    const form = (await http.get(tokens.reporter, "/forms/current")).body;
    const uniq = randomUUID().slice(0, 8);
    const mat = await http.call(tokens.reporter, "POST", "/materials", { body: materialBody(form.version, `sw-${uniq}`) });
    if (mat.status !== 201) throw new Error(`fixture material answered ${mat.status}`);
    await db.query(`UPDATE materials SET rights_state = 'sellable' WHERE id = $1`, [mat.body.id]);
    await db.query(`INSERT INTO material_files (material_id, kind, state, size_bytes, sha256, storage_key, verified_at) VALUES ($1, 'original', 'verified', 100, $2, $3, now())`, [mat.body.id, randomBytes(32), `tus/${randomUUID()}`]);
    const tpl = await http.call(tokens.rights_officer, "POST", "/license-templates", { body: {
      type: "editorial_single", name: { ar: "ترخيص", en: "License" }, terms: { ar: "شروط", en: "Terms" }, usage_media: ["web"], territory: { kind: "worldwide" },
      term_days: null, exclusivity_hours: null, deliverables: ["original"],
      attribution: { ar: "المصدر", en: "Source" }, prohibitions: [], base_price: { amount_minor: Number(PRICE), currency: "USD" }, enabled: true } });
    check("licence template created", tpl.status === 201, `status ${tpl.status}`);
    const listing = await http.call(tokens.rights_officer, "POST", `/materials/${mat.body.id}/listing`, { body: {
      title: { ar: `عنوان ${uniq}`, en: `Title ${uniq}` }, description: { ar: "وصف", en: "Description" }, offers: [{ license_template_id: tpl.body?.id }], state: "listed" } });
    check("material listed", listing.status === 201, `status ${listing.status}`);
    const org = await http.call(tokens.system_admin, "POST", "/buyer-organizations", { body: {
      legal_name: `Webhook Buyer ${uniq}`, display_name: { ar: "مشترٍ", en: "Buyer" }, country: "JO", billing_email: `billing-${uniq}@example.test`, first_admin_email: `admin-${uniq}@example.test`, seats: 2 } });
    let act = { status: 0 };
    if (org.status === 201) {
      const fields = { legal_name: org.body.legal_name, display_name: org.body.display_name, country: org.body.country, billing_email: org.body.billing_email, seats: org.body.seats };
      act = await http.call(tokens.system_admin, "PUT", `/buyer-organizations/${org.body.id}`, { body: { ...fields, status: "active" }, headers: { "if-match": org.headers.etag } });
    }
    check("buyer organization created and activated", org.status === 201 && act.status === 200 && act.body?.status === "active", `status ${org.status}/${act.status}`);
    const ord = await http.call(tokens.buyer_admin, "POST", "/orders", { body: {
      items: [{ listing_id: listing.body?.id, license_template_id: tpl.body?.id }], expected_total: { amount_minor: Number(PRICE), currency: "USD" } } });
    check("order created pending payment", ord.status === 201 && ord.body?.status === "pending_payment", `status ${ord.status}`);
    const orderId = ord.body?.id;

    // ---------- جلسة Checkout: لا قياس إن لم يكن الخادم يعمل بمزوّد Stripe التجريبي ----------
    const co = await http.call(tokens.buyer_admin, "POST", `/orders/${orderId}/checkout`, { body: {} });
    if (co.status === 404 || co.body?.provider !== "stripe") {
      console.error(`ENVIRONMENT: checkout answered ${co.status} provider=${co.body?.provider ?? "none"}; the server is not running the Stripe test provider, nothing measured`);
      return { code: 2, doc: null };
    }
    check("checkout session from the Stripe test provider", co.status === 200 && typeof co.body?.checkout_url === "string", `status ${co.status}`);
    const providerRef = (await orderState(orderId))?.provider_ref;
    check("the order carries the provider session reference", typeof providerRef === "string" && providerRef.length > 0, `${providerRef}`);

    const successObject = { id: providerRef, payment_status: "paid", amount_total: Number(PRICE), currency: "usd" };

    // ---------- 1. توقيع غير صحيح: 400 ولا أثر ----------
    const forged = stripeEvent({ id: eventId(), type: "checkout.session.completed", object: successObject });
    const bad = await send(forged, { sig: stripeSignature(`wrong-${secret}`, forged) });
    check("a bad signature is 400 webhook_signature_invalid", bad.status === 400 && (await bad.json())?.code === "webhook_signature_invalid", `status ${bad.status}`);
    check("the forgery leaves no trace (no event row, order unpaid, no licence, no sale entry)",
      (await storedEvents()) === 0 && (await orderState(orderId))?.status === "pending_payment" && (await licenseCount(orderId)) === 0 && (await saleEntries(orderId)).length === 0);

    // ---------- 2. حدث live mode: مرفوض ولا أثر ----------
    const live = stripeEvent({ id: eventId(), type: "checkout.session.completed", object: successObject, livemode: true });
    const liveRes = await send(live);
    check("a live-mode event is 400 live_payments_disabled", liveRes.status === 400 && (await liveRes.json())?.code === "live_payments_disabled", `status ${liveRes.status}`);
    check("the live-mode event leaves no trace either", (await storedEvents()) === 0 && (await orderState(orderId))?.status === "pending_payment");

    // ---------- 3. الإشعار الصحيح: دفع وترخيص وقيد واحد متوازن ----------
    const ok = stripeEvent({ id: eventId(), type: "checkout.session.completed", object: successObject });
    const okId = JSON.parse(ok.toString("utf8")).id;
    const applied = await send(ok);
    check("the correctly signed notification is accepted", applied.status === 200 && (await applied.json())?.received === true, `status ${applied.status}`);
    check("the order is paid", (await orderState(orderId))?.status === "paid");
    check("exactly one licence was issued", (await licenseCount(orderId)) === 1, `${await licenseCount(orderId)}`);
    const sales = await saleEntries(orderId);
    check("exactly one sale entry", sales.length === 1, `${sales.length}`);
    if (sales.length === 1) {
      const lines = toLines(await q(`SELECT a.kind, a.owner_id::text AS owner_id, a.payable_state AS state, p.currency, p.amount_minor::text AS amount FROM postings p JOIN ledger_accounts a ON a.id = p.account_id WHERE p.entry_id = $1`, [sales[0].id]));
      const problems = judgeSale(lines, { total: PRICE, currency: "USD", bp, reporterId });
      check("the sale entry is balanced and split by the commission rule", problems.length === 0, problems.join("; "));
      metrics.ledger_lines = lines.length;
    }
    check("the event is stored once with its outcome", (await eventsFor(okId)) === 1, `${await eventsFor(okId)}`);

    // ---------- 4. إعادة الإشعار نفسه عشر مرات: 200 بلا أثر ثانٍ ----------
    let replayed = 0;
    for (let i = 0; i < REPLAYS; i++) if ((await send(ok)).status === 200) replayed++;
    metrics.notification_replays = replayed;
    check(`replaying the same notification ${REPLAYS} times is accepted without effect`, replayed === REPLAYS, `${replayed}/${REPLAYS}`);
    check("no second licence and no second entry after the replays", (await licenseCount(orderId)) === 1 && (await saleEntries(orderId)).length === 1);
    check("the event row is still one (dedupe by provider and event id)", (await eventsFor(okId)) === 1, `${await eventsFor(okId)}`);

    // ---------- 5. المعرّف نفسه بجسم مختلف: 200 بلا أثر ----------
    const sameId = stripeEvent({ id: okId, type: "checkout.session.completed", object: { ...successObject, amount_total: Number(PRICE) + 1 } });
    check("the same event id with a different body changes nothing", (await send(sameId)).status === 200
      && (await eventsFor(okId)) === 1 && (await saleEntries(orderId)).length === 1 && (await licenseCount(orderId)) === 1);

    // ---------- 6. نوع لا يخص الدفع: يُقبل ولا يُخزَّن؛ ومرجع مجهول: «ignored» ----------
    const before = await storedEvents();
    const ping = stripeEvent({ id: eventId(), type: "ping", object: {} });
    check("a signed event of an unused type is received but not stored", (await send(ping)).status === 200 && (await storedEvents()) === before);
    const unknown = stripeEvent({ id: eventId(), type: "checkout.session.completed", object: { ...successObject, id: `cs_test_unknown_${randomBytes(6).toString("hex")}` } });
    const un = await send(unknown);
    check("a signed notification for an unknown session is 200 with no licence and no entry",
      un.status === 200 && (await licenseCount(orderId)) === 1 && (await saleEntries(orderId)).length === 1, `status ${un.status}`);
    const ignoredRow = await one(`SELECT outcome, order_id FROM payment_events WHERE provider = 'stripe' AND event_id = $1`, [JSON.parse(unknown.toString("utf8")).id]);
    check("the unknown session is recorded as ignored, unlinked to the order", ignoredRow?.outcome === "ignored" && ignoredRow?.order_id === null, JSON.stringify(ignoredRow));

    metrics.webhook_posts = 2 + 1 + REPLAYS + 1 + 2;
    metrics.payment_events_stored = await storedEvents();
    metrics.licenses = await licenseCount(orderId);
    metrics.sale_entries = (await saleEntries(orderId)).length;
  } finally {
    await db.end?.();
  }

  const failed = fails.length > 0;
  // لا «pass»: مزوّد اختبار لا مال حقيقي، وتجهيز بـSQL، وتشغيل واحد على بيئة محلية
  finish(doc, failed ? "fail" : "partial", { variant: "stripe-test-provider-local", ...metrics, failures: fails.length },
    "مزوّد Stripe في وضع الاختبار على بيئة محلية (لا مال حقيقي)؛ صفوف الحقوق والملف المتحقق مزروعة بـSQL لغياب عامل الوسائط؛ تشغيل واحد. يقيس الجزء القابل للأتمتة من صف «الدفع المكرر» لا المعيار الميداني كاملًا");
  if (args["dry-run"]) writeResult(doc, { dryRun: true });
  else console.log("wrote", writeResult(doc, { slug: "stripe" }));
  return { code: failed ? 1 : 0, doc };
}

if (process.argv[1] === new URL(import.meta.url).pathname) process.exit((await run()).code);
