// Shared fixtures of the two payout acceptance scripts (ADR 0033/0034): one real sandbox sale of a material the reporter owns, and the helpers that read
// the reporter's balances and the ledger from outside. Nothing here judges; the scripts do.
import { randomBytes, randomUUID } from "node:crypto";
import { materialBody } from "../lib/live.mjs";
import { signBody } from "./sandbox-purchase.mjs";

export const SALE_MINOR = 10001n; // 100.01 USD: the reporter's share is 7001 at the default 30% commission (the same odd price as sandbox-purchase)

/** Largest amount of `unit` requests the available balance can serve, out of `attempts` simultaneous ones. */
export function expectedAccepted(available, unit, attempts) {
  if (unit <= 0n) return 0;
  const fit = Number(available / unit);
  return Math.min(attempts, fit);
}

/** Contributor payable accounts whose balance went to the debit side: money the platform would owe the other way. */
export const DEBIT_BALANCE_SQL = `SELECT a.id::text AS id, a.payable_state AS state, sum(p.amount_minor)::text AS balance
  FROM ledger_accounts a JOIN postings p ON p.account_id = a.id
 WHERE a.kind = 'contributor_payable' GROUP BY a.id, a.payable_state HAVING sum(p.amount_minor) > 0`;

export function judgeDebitBalances(rows) {
  return rows.map((r) => `payable account ${r.id} (${r.state}) is ${r.balance} on the debit side`);
}

export function money(n, currency = "USD") { return { amount_minor: Number(n), currency }; }

export function balanceOf(earnings, currency = "USD") {
  const b = earnings?.balances?.find?.((x) => x.currency === currency);
  const get = (k) => BigInt(b?.[k]?.amount_minor ?? 0);
  return b ? { pending: get("pending"), available: get("available"), in_payout: get("in_payout"), paid: get("paid"), requestable: get("requestable"), minimum: get("minimum") } : null;
}

export function fixtures({ http, tokens, db, root, secret }) {
  const q = async (text, params) => (await db.query(text, params)).rows;
  const one = async (text, params) => (await q(text, params))[0];
  const earnings = async () => balanceOf((await http.get(tokens.reporter, "/me/earnings")).body);

  /** A material, a listing, an order, payment through the hosted page; resolves when the order is paid. */
  async function sale(label) {
    const uniq = randomUUID().slice(0, 8);
    const me = await http.get(tokens.reporter, "/auth/me");
    const reporterId = me.body?.user_id;
    const form = (await http.get(tokens.reporter, "/forms/current")).body;
    const m = await http.call(tokens.reporter, "POST", "/materials", { body: materialBody(form.version, `po-${label}-${uniq}`) });
    if (m.status !== 201) throw new Error(`fixture material answered ${m.status}`);
    await db.query(`UPDATE materials SET rights_state = 'sellable' WHERE id = $1`, [m.body.id]);
    await db.query(`INSERT INTO material_files (material_id, kind, state, size_bytes, sha256, storage_key, verified_at) VALUES ($1, 'original', 'verified', 100, $2, $3, now())`, [m.body.id, randomBytes(32), `tus/${randomUUID()}`]);
    const tpl = await http.call(tokens.rights_officer, "POST", "/license-templates", { body: {
      type: "editorial_single", name: { ar: "ترخيص", en: "License" }, terms: { ar: "شروط", en: "Terms" }, usage_media: ["web"], territory: { kind: "worldwide" },
      term_days: null, exclusivity_hours: null, deliverables: ["original"], attribution: { ar: "المصدر", en: "Source" }, prohibitions: [],
      base_price: { amount_minor: Number(SALE_MINOR), currency: "USD" }, enabled: true } });
    const listing = await http.call(tokens.rights_officer, "POST", `/materials/${m.body.id}/listing`, { body: {
      title: { ar: `عنوان ${uniq}`, en: `Title ${uniq}` }, description: { ar: "وصف", en: "Description" }, offers: [{ license_template_id: tpl.body?.id }], state: "listed" } });
    if (tpl.status !== 201 || listing.status !== 201) throw new Error(`fixture listing answered ${tpl.status}/${listing.status}`);
    const order = await http.call(tokens.buyer_admin, "POST", "/orders", { body: { items: [{ listing_id: listing.body.id, license_template_id: tpl.body.id }], expected_total: money(SALE_MINOR) } });
    if (order.status !== 201) throw new Error(`fixture order answered ${order.status}`);
    const co = await http.call(tokens.buyer_admin, "POST", `/orders/${order.body.id}/checkout`, { body: {} });
    if (co.status !== 200) throw new Error(`fixture checkout answered ${co.status}`);
    const providerRef = co.body.checkout_url.split("/").pop();
    const paid = await fetch(`${root}/sandbox/checkout/${providerRef}/succeeded`, { method: "POST" });
    if (paid.status !== 202) throw new Error(`the hosted page answered ${paid.status}`);
    for (let i = 0; i < 40; i++) {
      const o = await http.get(tokens.buyer_admin, `/orders/${order.body.id}`);
      if (o.body?.status === "paid") return { orderId: order.body.id, itemId: order.body.items[0].id, providerRef, reporterId };
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error("the order was not paid in 10 s");
  }

  /** The sale's release into «available»: the payout worker does it after PAYOUT_RELEASE_AFTER_DAYS (0 in this run). Returns the available balance reached or null. */
  async function untilAvailable(atLeast, seconds = 20) {
    for (let i = 0; i < seconds * 4; i++) {
      const b = await earnings();
      if (b && b.available >= atLeast) return b;
      await new Promise((r) => setTimeout(r, 250));
    }
    return null;
  }

  const requestPayout = (amount, key) => http.call(tokens.reporter, "POST", "/me/payout-requests", { body: { amount: money(amount), channel: "sandbox" }, key });
  const signed = (type, providerRef, amount) => {
    const body = Buffer.from(JSON.stringify({ event_id: `po_${randomUUID()}`, type, provider_ref: providerRef, amount: money(amount), occurred_at: new Date().toISOString() }));
    const ts = Math.floor(Date.now() / 1000);
    return { body, ts, sig: signBody(secret, ts, body) };
  };
  const send = ({ body, ts, sig }) => fetch(`${root}/payments/webhooks/sandbox`, { method: "POST", headers: { "content-type": "application/json", "x-timestamp": String(ts), "x-signature": sig }, body });

  return { q, one, earnings, sale, untilAvailable, requestPayout, signed, send };
}
