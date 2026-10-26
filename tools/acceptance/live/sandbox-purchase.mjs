#!/usr/bin/env node
// sandbox-purchase: the whole sandbox purchase on a running server, judged from outside (no real money: the provider is the internal sandbox).
//   buyer organization and member (API) → listed material (API on a fixture material) → catalog (buyer view) → order (frozen price, expiry)
//   → hosted sandbox checkout page → signed notification (a forged copy is refused, a replayed copy leaves no second effect)
//   → balanced ledger entry (platform share by the commission rule, the rest pending for the reporter) → licence → outbox events
//   → download link and refund: measured once the server has them (a 404 on the route is "not built yet", recorded and never a pass).
// ALWAYS `partial`: sandbox provider with in-memory state, fixture rows (rights state, verified original) written by SQL because the media worker is
// not in this stack, one run, default commission rule. It is the condition for opening buyer delivery in the trial, not a claim about real payments.
//   SP_API_URL=http://127.0.0.1:13000/v1  SP_ROOT_URL=http://127.0.0.1:13000  SP_DATABASE_URL=postgres://…  SP_WEBHOOK_SECRET=…
//   SP_TOKENS='{"system_admin":"…","rights_officer":"…","reporter":"…","buyer_admin":"…","buyer_member":"…","finance":"…"}'  [SP_COMMISSION_BP=3000]
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { join } from "node:path";
import pg from "pg";
import { ROOT, newResult, finish, writeResult, parseArgs, banner } from "../lib/measurement.mjs";
import { byName } from "../lib/catalog.mjs";
import { canon, client, materialBody } from "../lib/live.mjs";

const PRICE = 10001n; // 100.01: odd on purpose, so the largest-remainder split is exercised (3000 / 7001 at 30%)
const ORDER_KEYS = ["id", "organization_id", "created_by", "status", "cancel_reason", "total", "items", "expires_at", "paid_at", "created_at", "updated_at"];
const CATALOG_FORBIDDEN = ["material_id", "reporter_id", "reporter", "gps", "device", "storage_key", "sha256"];

/** X-Signature value of the sandbox provider: HMAC-SHA256 of `<timestamp>.<raw body>`, hex. */
export function signBody(secret, timestamp, body) {
  return `v1=${createHmac("sha256", secret).update(`${timestamp}.`).update(body).digest("hex")}`;
}

/** Largest-remainder split of `total` between the platform (basis points) and the contributors (the rest); ties go to the smaller key. Independent of the server's code. */
export function expectedSplit(total, bp) {
  const parts = [{ key: "contributors", w: 10000n - BigInt(bp) }, { key: "platform", w: BigInt(bp) }];
  const rows = parts.map((p) => ({ key: p.key, base: (total * p.w) / 10000n, frac: (total * p.w) % 10000n }));
  let rest = total - rows.reduce((a, r) => a + r.base, 0n);
  for (const r of [...rows].sort((a, b) => (a.frac === b.frac ? (a.key < b.key ? -1 : 1) : a.frac > b.frac ? -1 : 1))) { if (rest === 0n) break; r.base += 1n; rest -= 1n; }
  return { platform: rows.find((r) => r.key === "platform").base, contributors: rows.find((r) => r.key === "contributors").base };
}

/**
 * Judges a sale entry's lines [{ kind, owner_id, state, currency, amount: bigint }] (debit positive): balanced per currency, the provider owes the whole total,
 * the platform and the reporter's pending balance hold exactly the split, and nothing else is touched. Returns the problems.
 */
export function judgeSale(lines, { total, currency, bp, reporterId }) {
  const bad = [];
  const sums = new Map();
  for (const l of lines) sums.set(l.currency, (sums.get(l.currency) ?? 0n) + l.amount);
  for (const [c, s] of sums) if (s !== 0n) bad.push(`unbalanced in ${c}: ${s}`);
  const split = expectedSplit(total, bp);
  const one = (pred, label, want) => {
    const hit = lines.filter(pred);
    if (hit.length !== 1) return bad.push(`${label}: ${hit.length} line(s), want 1`);
    if (hit[0].amount !== want) bad.push(`${label}: ${hit[0].amount}, want ${want}`);
  };
  one((l) => l.kind === "provider_clearing" && l.currency === currency, "provider clearing", total);
  one((l) => l.kind === "platform_revenue" && l.currency === currency, "platform revenue", -split.platform);
  one((l) => l.kind === "contributor_payable" && l.owner_id === reporterId && l.state === "pending" && l.currency === currency, "reporter pending balance", -split.contributors);
  if (lines.length !== 3) bad.push(`${lines.length} lines, want exactly provider, platform and one contributor`);
  return bad;
}

/** A refund entry mirrors the sale: every line of the sale negated, on the same accounts (the reserve takes over when the payable was already paid out: not asserted here). */
export function judgeRefundMirror(sale, refund) {
  const key = (l) => `${l.kind}|${l.owner_id ?? ""}|${l.state ?? ""}|${l.currency}`;
  const want = new Map(sale.map((l) => [key(l), -l.amount]));
  const bad = [];
  const sum = refund.reduce((a, l) => a + l.amount, 0n);
  if (sum !== 0n) bad.push(`refund entry unbalanced: ${sum}`);
  for (const l of refund) {
    const w = want.get(key(l));
    if (w === undefined) bad.push(`refund touches an account the sale did not: ${key(l)}`);
    else if (l.amount !== w) bad.push(`refund line ${key(l)} is ${l.amount}, want ${w}`);
  }
  if (refund.length !== sale.length) bad.push(`refund has ${refund.length} lines, the sale ${sale.length}`);
  return bad;
}

const toLines = (rows) => rows.map((r) => ({ kind: r.kind, owner_id: r.owner_id, state: r.state, currency: r.currency, amount: BigInt(r.amount) }));

export async function run(argv = process.argv.slice(2), env = process.env) {
  const args = parseArgs(argv);
  banner(byName("sandbox-purchase"));
  const need = ["SP_API_URL", "SP_ROOT_URL", "SP_DATABASE_URL", "SP_WEBHOOK_SECRET", "SP_TOKENS"].filter((k) => !env[k]);
  if (need.length) { console.error(`ENVIRONMENT: missing ${need.join(", ")}; nothing measured`); return { code: 2, doc: null }; }
  const tokens = JSON.parse(env.SP_TOKENS);
  const missingRoles = ["system_admin", "rights_officer", "reporter", "buyer_admin", "buyer_member", "finance"].filter((r) => !tokens[r]);
  if (missingRoles.length) { console.error(`ENVIRONMENT: SP_TOKENS needs ${missingRoles.join(", ")}; nothing measured`); return { code: 2, doc: null }; }
  const bp = Number(env.SP_COMMISSION_BP ?? 3000);
  const secret = env.SP_WEBHOOK_SECRET;
  const root = env.SP_ROOT_URL.replace(/\/$/, "");
  const http = client(env.SP_API_URL);
  const db = new pg.Client({ connectionString: env.SP_DATABASE_URL });
  const doc = newResult("sandbox-purchase", { device: { platform: "server", model: env.SP_ENV_LABEL ?? "server" }, upload_path: "n/a" });
  const fails = [], deferred = [], metrics = {};
  let checks = 0;
  const check = (name, ok, why = "") => { checks++; if (!ok) { fails.push(`${name}${why ? `: ${why}` : ""}`); console.log(`FAIL ${name} ${why}`); } else console.log(`ok   ${name}`); return ok; };
  const defer = (name, why) => { deferred.push(`${name}: ${why}`); console.log(`DEFERRED ${name} — ${why}`); };
  const q = async (text, params) => (await db.query(text, params)).rows;
  const one = async (text, params) => (await q(text, params))[0];
  const send = (body, { ts = Math.floor(Date.now() / 1000), sig, path = "/payments/webhooks/sandbox" } = {}) =>
    fetch(`${root}${path}`, { method: "POST", headers: { "content-type": "application/json", "x-timestamp": String(ts), "x-signature": sig ?? signBody(secret, ts, body) }, body });
  const event = (type, providerRef, amount, over = {}) =>
    Buffer.from(JSON.stringify({ event_id: `spt_${randomUUID()}`, type, provider_ref: providerRef, amount: { amount_minor: Number(amount), currency: "USD" }, occurred_at: new Date().toISOString(), ...over }));
  const refOf = (url) => url.split("/").pop();

  await db.connect();
  try {
    // ---------- 0. fixtures: a material the reporter owns, sellable, with a verified original (the media worker is not in this stack) ----------
    const me = await http.get(tokens.reporter, "/auth/me");
    const reporterId = me.body?.user_id;
    check("reporter identity", me.status === 200 && /^[0-9a-f-]{36}$/.test(reporterId ?? ""), `status ${me.status}`);
    const form = (await http.get(tokens.reporter, "/forms/current")).body;
    const uniq = randomUUID().slice(0, 8);
    const material = async (label) => {
      const r = await http.call(tokens.reporter, "POST", "/materials", { body: materialBody(form.version, `sp-${label}-${uniq}`) });
      if (r.status !== 201) throw new Error(`fixture material answered ${r.status}`);
      await db.query(`UPDATE materials SET rights_state = 'sellable' WHERE id = $1`, [r.body.id]);
      await db.query(`INSERT INTO material_files (material_id, kind, state, size_bytes, sha256, storage_key, verified_at) VALUES ($1, 'original', 'verified', 100, $2, $3, now())`, [r.body.id, randomBytes(32), `tus/${randomUUID()}`]);
      return r.body.id;
    };
    const template = (type, over = {}) => http.call(tokens.rights_officer, "POST", "/license-templates", { body: {
      type, name: { ar: "ترخيص", en: "License" }, terms: { ar: "شروط", en: "Terms" }, usage_media: ["web"], territory: { kind: "worldwide" },
      term_days: type === "editorial_single" ? null : 30, exclusivity_hours: type === "exclusive_temporary" ? 48 : null, deliverables: ["original"],
      attribution: { ar: "المصدر", en: "Source" }, prohibitions: [], base_price: { amount_minor: Number(PRICE), currency: "USD" }, enabled: true, ...over } });
    const list = (materialId, templateId) => http.call(tokens.rights_officer, "POST", `/materials/${materialId}/listing`, { body: {
      title: { ar: `عنوان ${uniq}`, en: `Title ${uniq}` }, description: { ar: "وصف", en: "Description" }, offers: [{ license_template_id: templateId }], state: "listed" } });

    const mat = await material("main");
    const tpl = await template("editorial_single");
    check("licence template created", tpl.status === 201, `status ${tpl.status}`);
    const listing = await list(mat, tpl.body.id);
    check("material listed", listing.status === 201 && listing.body?.state === "listed", `status ${listing.status} ${listing.text?.slice?.(0, 120)}`);
    const listingId = listing.body?.id;

    // ---------- 1. a buyer organization and a member through the API (the purchase below uses the seeded active organization's accounts) ----------
    const org = await http.call(tokens.system_admin, "POST", "/buyer-organizations", { body: {
      legal_name: `Sandbox Buyer ${uniq}`, display_name: { ar: "مشترٍ", en: "Buyer" }, country: "JO", billing_email: `billing-${uniq}@example.test`, first_admin_email: `admin-${uniq}@example.test`, seats: 3 } });
    check("organization created pending with its first admin", org.status === 201 && org.body?.status === "pending_verification" && org.body?.seats === 3, `status ${org.status}`);
    check("the first admin's invite is a one-time token or goes out of band", org.body?.invite_token === undefined || (typeof org.body.invite_token === "string" && org.body.invite_token.length >= 32));
    if (org.status === 201) {
      const fields = { legal_name: org.body.legal_name, display_name: org.body.display_name, country: org.body.country, billing_email: org.body.billing_email, seats: org.body.seats };
      const act = await http.call(tokens.system_admin, "PUT", `/buyer-organizations/${org.body.id}`, { body: { ...fields, status: "active" }, headers: { "if-match": org.headers.etag } });
      check("organization activated by the system admin", act.status === 200 && act.body?.status === "active", `status ${act.status}`);
      const inv = await http.call(tokens.system_admin, "POST", `/buyer-organizations/${org.body.id}/members`, { body: { email: `member-${uniq}@example.test`, role: "buyer_member" } });
      check("member invited", inv.status === 201 && inv.body?.status === "invited", `status ${inv.status}`);
      const members = await http.get(tokens.system_admin, `/buyer-organizations/${org.body.id}/members`);
      check("both appear in the member list and fill their seats", members.status === 200 && members.body?.items?.length === 2, `members ${members.body?.items?.length}`);
    }

    // ---------- 2. catalog, as a buyer sees it ----------
    const cat = await http.get(tokens.buyer_admin, "/catalog?limit=100");
    const item = cat.body?.items?.find?.((i) => i.listing_id === listingId);
    check("the listed material is in the buyer's catalog", cat.status === 200 && Boolean(item), `status ${cat.status}`);
    check("the catalog item leaks nothing about the source", item && CATALOG_FORBIDDEN.every((k) => !(k in item)), item ? Object.keys(item).filter((k) => CATALOG_FORBIDDEN.includes(k)).join(",") : "no item");

    // ---------- 3. the order: frozen price, expiry, replay, a price that moved ----------
    const key = randomUUID();
    const body = { items: [{ listing_id: listingId, license_template_id: tpl.body?.id }], expected_total: { amount_minor: Number(PRICE), currency: "USD" } };
    const ord = await http.call(tokens.buyer_admin, "POST", "/orders", { body, key });
    check("order created pending payment at the listed price", ord.status === 201 && ord.body?.status === "pending_payment" && ord.body?.total?.amount_minor === Number(PRICE), `status ${ord.status}`);
    check("order has exactly the contract's keys, and no material or reporter id", ORDER_KEYS.every((k) => k in (ord.body ?? {})) && !JSON.stringify(ord.body).includes(mat) && !JSON.stringify(ord.body).includes(reporterId));
    const hours = (Date.parse(ord.body?.expires_at) - Date.parse(ord.body?.created_at)) / 3.6e6;
    check("a plain order lives under 24 hours", hours > 23 && hours <= 24.01, `${hours.toFixed(2)} h`);
    const replay = await http.call(tokens.buyer_admin, "POST", "/orders", { body, key });
    check("replaying the key returns the same order", replay.status === 201 && canon(replay.body) === canon(ord.body));
    const stale = await http.call(tokens.buyer_admin, "POST", "/orders", { body: { ...body, expected_total: { amount_minor: Number(PRICE) - 1, currency: "USD" } } });
    check("a total that is not the shown one is 409 price_changed", stale.status === 409 && stale.body?.code === "price_changed", `status ${stale.status}`);
    const orderId = ord.body?.id, itemId = ord.body?.items?.[0]?.id;
    const tget = await http.get(tokens.rights_officer, `/license-templates/${tpl.body.id}`);
    const { id: _id, version: _version, created_at: _at, created_by: _by, ...fields } = tget.body ?? {};
    const tput = await http.call(tokens.rights_officer, "PUT", `/license-templates/${tpl.body.id}`, { body: { ...fields, base_price: { amount_minor: 20000, currency: "USD" } }, headers: { "if-match": tget.headers.etag } });
    if (tput.status === 200) {
      const after = await http.get(tokens.buyer_admin, `/orders/${orderId}`);
      check("the order keeps the price and version it froze when the template changed", after.body?.items?.[0]?.price?.amount_minor === Number(PRICE) && after.body?.items?.[0]?.license_version === 1, `price ${after.body?.items?.[0]?.price?.amount_minor}`);
    } else check("the template can be replaced by a new version (so the freeze below is measured)", false, `status ${tput.status} ${tput.text?.slice?.(0, 160)}`);
    check("a member sees only the orders they created, the admin sees the organization's", (await http.get(tokens.buyer_member, `/orders/${orderId}`)).status === 404 && (await http.get(tokens.buyer_admin, `/orders/${orderId}`)).status === 200);
    check("a reporter token cannot read orders", (await http.get(tokens.reporter, `/orders/${orderId}`)).status === 403);

    // ---------- 4. exclusive hold: 15 minutes, one holder, released by cancelling ----------
    const exMat = await material("exclusive");
    const exTpl = await template("exclusive_temporary");
    const exList = await list(exMat, exTpl.body?.id);
    const exBody = { items: [{ listing_id: exList.body?.id, license_template_id: exTpl.body?.id }] };
    const exA = await http.call(tokens.buyer_admin, "POST", "/orders", { body: exBody });
    const minutes = (Date.parse(exA.body?.expires_at) - Date.parse(exA.body?.created_at)) / 6e4;
    check("an order with an exclusive item lives 15 minutes (its hold)", exA.status === 201 && minutes > 14 && minutes <= 15.1, `status ${exA.status}, ${minutes.toFixed(2)} min`);
    const exB = await http.call(tokens.buyer_member, "POST", "/orders", { body: exBody });
    check("a second buyer cannot hold the same material", exB.status === 409 && exB.body?.code === "exclusive_unavailable", `status ${exB.status} ${exB.body?.code}`);
    const cancel = await http.call(tokens.buyer_admin, "POST", `/orders/${exA.body?.id}/cancel`, { body: {} });
    check("cancelling releases the hold", cancel.status === 200 && cancel.body?.status === "cancelled" && cancel.body?.cancel_reason === "buyer", `status ${cancel.status}`);
    const exC = await http.call(tokens.buyer_member, "POST", "/orders", { body: exBody });
    check("after the release the other buyer can hold it", exC.status === 201, `status ${exC.status}`);
    if (exC.status === 201) await http.call(tokens.buyer_member, "POST", `/orders/${exC.body.id}/cancel`, { body: {} });

    // ---------- 5. hosted checkout ----------
    const co = await http.call(tokens.buyer_admin, "POST", `/orders/${orderId}/checkout`, { body: {} });
    check("checkout session from the sandbox provider", co.status === 200 && co.body?.provider === "sandbox" && /\/sandbox\/checkout\/sbx_[0-9a-f]{32}$/.test(co.body?.checkout_url ?? ""), `status ${co.status}`);
    const providerRef = refOf(co.body?.checkout_url ?? "");
    const again = await http.call(tokens.buyer_admin, "POST", `/orders/${orderId}/checkout`, { body: {} });
    check("asking again returns the same payment session", again.status === 200 && refOf(again.body?.checkout_url ?? "") === providerRef);
    const page = await fetch(`${root}/sandbox/checkout/${providerRef}`);
    check("the hosted page shows the amount and asks for no card", page.status === 200 && (await page.text()).includes("100.01 USD"), `status ${page.status}`);
    check("an unknown payment reference is 404", (await fetch(`${root}/sandbox/checkout/sbx_${"0".repeat(32)}`)).status === 404);

    // ---------- 6. the signed notification ----------
    const good = event("payment.succeeded", providerRef, PRICE);
    const tampered = Buffer.from(good.toString().replace(String(PRICE), String(PRICE - 1n)));
    const forged = await send(tampered, { sig: signBody(secret, Math.floor(Date.now() / 1000), good) });
    check("a body changed after signing is 400 webhook_signature_invalid", forged.status === 400 && (await forged.json()).code === "webhook_signature_invalid", `status ${forged.status}`);
    const old = Math.floor(Date.now() / 1000) - 600;
    const oldTs = await send(good, { ts: old, sig: signBody(secret, old, good) });
    check("a validly signed but stale notification is refused with webhook_signature_invalid", oldTs.status === 400 && (await oldTs.json()).code === "webhook_signature_invalid", `status ${oldTs.status}`);
    const badSecret = await send(good, { sig: signBody("x".repeat(40), Math.floor(Date.now() / 1000), good) });
    check("a wrong secret is refused with webhook_signature_invalid", badSecret.status === 400 && (await badSecret.json()).code === "webhook_signature_invalid", `status ${badSecret.status}`);
    check("an unknown provider is 404", (await send(good, { path: "/payments/webhooks/nowhere" })).status === 404);
    check("nothing was applied by the refused copies", (await http.get(tokens.buyer_admin, `/orders/${orderId}`)).body?.status === "pending_payment");
    const wrong = event("payment.succeeded", providerRef, PRICE - 1n);
    check("a signed notification for the wrong amount is accepted and applies nothing", (await send(wrong)).status === 200 && (await http.get(tokens.buyer_admin, `/orders/${orderId}`)).body?.status === "pending_payment");
    check("…and is kept for review", (await one(`SELECT outcome FROM payment_events WHERE provider = 'sandbox' AND event_id = $1`, [JSON.parse(wrong).event_id]))?.outcome === "review");
    const t0 = Date.now();
    check("the signed success is accepted", (await send(good)).status === 200);
    const paid = await http.get(tokens.buyer_admin, `/orders/${orderId}`);
    metrics.notification_to_paid_ms = Date.now() - t0;
    check("the order is paid with its licence attached", paid.body?.status === "paid" && Boolean(paid.body?.paid_at) && Boolean(paid.body?.items?.[0]?.license_id), `status ${paid.body?.status}`);
    for (let i = 0; i < 3; i++) check(`the identical notification again (${i + 1}/3) is 200`, (await send(good)).status === 200);
    const dup = event("payment.succeeded", providerRef, PRICE);
    check("a second success under another event id is 200 and changes nothing", (await send(dup)).status === 200);
    check("a late failure after the success is 200 and changes nothing", (await send(event("payment.failed", providerRef, PRICE))).status === 200 && (await http.get(tokens.buyer_admin, `/orders/${orderId}`)).body?.status === "paid");

    // ---------- 7. effects, counted in the database ----------
    const eid = JSON.parse(good).event_id;
    check("the notification is stored once", Number((await one(`SELECT count(*) AS n FROM payment_events WHERE provider = 'sandbox' AND event_id = $1`, [eid])).n) === 1);
    const lic = await q(`SELECT id, license_number, status FROM licenses WHERE order_item_id = $1`, [itemId]);
    check("exactly one licence, active, with a random contract-shaped number", lic.length === 1 && lic[0].status === "active" && /^PH-[0-9]{4}-[0-9A-HJKMNP-TV-Z]{10}$/.test(lic[0].license_number), `${lic.length} licence(s)`);
    const entries = await q(`SELECT id, details FROM journal_entries WHERE reference_type = 'order' AND reference_id = $1 AND kind = 'sale'`, [orderId]);
    check("exactly one sale entry for the order, whatever the number of notifications", entries.length === 1, `${entries.length}`);
    let saleLines = [];
    if (entries.length === 1) {
      saleLines = toLines(await q(`SELECT a.kind, a.owner_id::text AS owner_id, a.payable_state AS state, p.currency, p.amount_minor::text AS amount FROM postings p JOIN ledger_accounts a ON a.id = p.account_id WHERE p.entry_id = $1`, [entries[0].id]));
      const problems = judgeSale(saleLines, { total: PRICE, currency: "USD", bp, reporterId });
      check(`the sale entry balances and splits ${bp / 100}% to the platform by largest remainder`, problems.length === 0, problems.join("; "));
      check("the commission rule is frozen in the entry", entries[0].details?.platform_basis_points === bp, JSON.stringify(entries[0].details));
      const debit = saleLines.filter((l) => l.amount > 0n).reduce((a, l) => a + l.amount, 0n), credit = -saleLines.filter((l) => l.amount < 0n).reduce((a, l) => a + l.amount, 0n);
      metrics.ledger_debit_minor = Number(debit); metrics.ledger_credit_minor = Number(credit);
    }
    const ev = await q(`SELECT type, payload FROM outbox_events WHERE aggregate_id::text = ANY($1) ORDER BY id`, [[orderId, lic[0]?.id ?? ""]]);
    const statuses = ev.filter((e) => e.type === "order.status_changed").map((e) => e.payload.status);
    check("outbox: the order's status changes are pending then paid, once each", JSON.stringify(statuses) === JSON.stringify(["pending_payment", "paid"]), statuses.join(","));
    check("outbox: one licence.issued", ev.filter((e) => e.type === "license.issued").length === 1);
    check("outbox payloads carry ids and codes only (no payment reference, link, buyer or material name)", ev.every((e) => !/checkout|provider_ref|sbx_|title|email/i.test(JSON.stringify(e.payload))));

    // ---------- 8. the parts the server may not have yet ----------
    const licenses = await http.get(tokens.buyer_admin, "/licenses?limit=50");
    if (licenses.status === 404) defer("licence list, download link", "GET /licenses is not served yet");
    else {
      const mine = licenses.body?.items?.find?.((l) => l.order_id === orderId);
      const licId = mine?.id ?? lic[0].id;
      check("the buyer's licence list shows the licence, without material or reporter ids", licenses.status === 200 && Boolean(mine) && !JSON.stringify(mine).includes(mat) && !JSON.stringify(mine).includes(reporterId), `status ${licenses.status}`);
      check("the licence freezes the price and the contract fields, and the delivery is not ready yet", mine?.price?.amount_minor === Number(PRICE) && mine?.status === "active" && mine?.delivery_ready === false, JSON.stringify({ p: mine?.price, s: mine?.status, d: mine?.delivery_ready }));
      check("a member of the same organization reads the licence", (await http.get(tokens.buyer_member, `/licenses/${licId}`)).status === 200);
      const dl = (token, key) => http.call(token, "POST", `/licenses/${licId}/download-url`, { body: {}, ...(key ? { key } : {}) });
      const early = await dl(tokens.buyer_admin);
      if (early.status === 404) defer("download link", "POST /licenses/{id}/download-url is not served yet");
      else {
        check("no link before the delivery package is verified (409 delivery_not_ready)", early.status === 409 && early.body?.code === "delivery_not_ready", `status ${early.status} ${early.body?.code}`);
        check("only a buyer may ask for a link (finance is refused)", (await dl(tokens.finance)).status === 403);
        // حزمة التسليم يبنيها عامل الوسائط؛ لا عامل في هذا المكدس فتُكتب متحققة بـSQL (يُعلن في الملاحظة)
        const orig = await one(`SELECT id FROM material_files WHERE material_id = $1 AND kind = 'original' AND state = 'verified' LIMIT 1`, [mat]);
        await db.query(`INSERT INTO material_files (material_id, kind, state, size_bytes, sha256, storage_key, verified_at, derived_from_id, license_id) VALUES ($1, 'delivery', 'verified', 100, $2, $3, now(), $4, $5)`, [mat, randomBytes(32), `delivery/${licId}/package.zip`, orig?.id, licId]);
        check("the licence reports the delivery ready once it is verified", (await http.get(tokens.buyer_admin, `/licenses/${licId}`)).body?.delivery_ready === true);
        const grant = await dl(tokens.buyer_admin);
        const ttlS = (Date.parse(grant.body?.expires_at) - Date.now()) / 1000;
        check("a link is granted with no-store caching", grant.status === 200 && /no-store/.test(grant.headers?.["cache-control"] ?? ""), `status ${grant.status} ${grant.headers?.["cache-control"]}`);
        check("the link lives at most 24 hours and the grants left are counted", ttlS > 0 && ttlS <= 86_400 + 60 && Number.isInteger(grant.body?.downloads_remaining), `ttl ${ttlS.toFixed(0)} s, left ${grant.body?.downloads_remaining}`);
        const expires = Number(new URL(grant.body?.url ?? "http://x/").searchParams.get("X-Amz-Expires"));
        check("the signature itself expires within 24 hours", expires > 0 && expires <= 86_400, `X-Amz-Expires=${expires}`);
        check("the link carries neither the material id nor the reporter id", !String(grant.body?.url).includes(mat) && !String(grant.body?.url).includes(reporterId));
        metrics.download_url_ttl_s = Math.round(ttlS);
        const key = randomUUID();
        const first = await dl(tokens.buyer_admin, key);
        const replay = await dl(tokens.buyer_admin, key);
        check("a replay with the same Idempotency-Key returns no link", first.status === 200 && replay.status === 200 && replay.body?.url === undefined, `status ${replay.status}`);
        check("each grant is counted", first.body?.downloads_remaining === grant.body?.downloads_remaining - 1, `${grant.body?.downloads_remaining} → ${first.body?.downloads_remaining}`);
        let left = first.body?.downloads_remaining, last = first;
        for (let i = 0; i < 200 && left > 0; i++) { last = await dl(tokens.buyer_admin); left = last.body?.downloads_remaining ?? 0; }
        const over = await dl(tokens.buyer_admin);
        check("past the limit the answer is 409 download_limit_reached", over.status === 409 && over.body?.code === "download_limit_reached", `status ${over.status} ${over.body?.code}`);
        const stored = Number((await one(`SELECT count(*) AS n FROM idempotency_keys WHERE response_body::text LIKE '%X-Amz-%'`)).n) + Number((await one(`SELECT count(*) AS n FROM license_download_grants g WHERE license_id = $1 AND to_jsonb(g)::text LIKE '%X-Amz-%'`, [licId])).n) + Number((await one(`SELECT count(*) AS n FROM outbox_events WHERE payload::text LIKE '%X-Amz-%'`)).n);
        check("no signed link is stored (idempotency table, grants, outbox)", stored === 0, `${stored} row(s)`);
        defer("the link opening and then stopping after its expiry", "the signature expiry is checked above; fetching it needs object storage and a real package, not available here");
      }
    }
    const refund = await http.call(tokens.finance, "POST", `/orders/${orderId}/refunds`, { body: { order_item_ids: [itemId], reason_code: "buyer_request" } });
    if (refund.status === 404) defer("refund", "POST /orders/{id}/refunds is not served yet");
    else {
      check("a refund is requested pending, for the item's frozen price", refund.status === 201 && refund.body?.status === "pending" && refund.body?.amount?.amount_minor === Number(PRICE), `status ${refund.status} ${refund.text?.slice?.(0, 120)}`);
      const done = event("refund.succeeded", providerRef, PRICE);
      check("the signed refund notification is accepted", (await send(done)).status === 200);
      const rl = await q(`SELECT j.id FROM journal_entries j WHERE j.kind = 'refund' AND j.reference_id = $1`, [orderId]);
      check("one refund entry", rl.length === 1, `${rl.length}`);
      if (rl.length === 1) {
        const lines = toLines(await q(`SELECT a.kind, a.owner_id::text AS owner_id, a.payable_state AS state, p.currency, p.amount_minor::text AS amount FROM postings p JOIN ledger_accounts a ON a.id = p.account_id WHERE p.entry_id = $1`, [rl[0].id]));
        const problems = judgeRefundMirror(saleLines, lines);
        check("the refund entry mirrors the sale line by line", problems.length === 0, problems.join("; "));
      }
      check("the licence is revoked and the order refunded", (await one(`SELECT status FROM licenses WHERE id = $1`, [lic[0].id]))?.status === "revoked" && (await http.get(tokens.buyer_admin, `/orders/${orderId}`)).body?.status === "refunded");
    }
  } catch (e) {
    fails.push(`aborted: ${String(e.message).replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, "<url>").replace(/Bearer\s+\S+/gi, "Bearer <redacted>").slice(0, 300)}`); console.error(e.stack ?? e);
  } finally { await db.end(); }

  const failed = fails.length > 0;
  Object.assign(metrics, { checks, checks_failed: fails.length, deferred_checks: deferred.length, commission_basis_points: bp, price_minor: Number(PRICE) });
  finish(doc, failed ? "fail" : "partial", metrics, failed ? fails.join("؛ ") :
    `الشراء بالمزوّد التجريبي على خادم حي: مؤسسة وعضو بالواجهة، ومادة معروضة، وطلب بسعر مجمّد (100.01 USD) ومهلته، وحجز حصري 15 دقيقة، وصفحة الدفع المستضافة، وإشعار موقّع (تُرفض النسخة المزوّرة والقديمة وبسر خاطئ، ولا أثر لنسخ مكررة ولا لإشعار بمبلغ خطأ)، وقيد دفتر متوازن بحصة المنصة ${bp / 100}% بالباقي الأكبر والباقي معلّقًا للمراسل، وترخيص واحد، وأحداث Outbox بالمعرّفات وحدها.${deferred.length ? ` لم يُقَس لأن الخادم لا يقدّمه بعد: ${deferred.join("؛ ")}.` : ""} جزئية دائمًا: مزوّد تجريبي حالته في الذاكرة، وصفّا حقوق المادة والأصل المتحقق كُتبا بـSQL (لا عامل وسائط هنا)، وتشغيل واحد، وقاعدة العمولة الافتراضية. لا مال حقيقي.`);
  const dir = env.ACCEPTANCE_RESULTS_DIR ? undefined : join(ROOT, "docs/measurements/commerce");
  if (args["dry-run"]) writeResult(doc, { dryRun: true });
  else console.log("wrote", writeResult(doc, { slug: "sandbox", ...(dir ? { dir } : {}) }));
  return { code: failed ? 1 : 0, doc };
}

if (process.argv[1] === new URL(import.meta.url).pathname) process.exit((await run()).code);
