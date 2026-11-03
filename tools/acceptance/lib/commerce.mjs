// Shared steps of the server-backed commerce scripts (sandbox provider only, no real money): a sellable material with a
// verified original (written by SQL: no media worker in the live stack), a licence template, a listing, an order paid on the
// hosted sandbox page, and the signed provider notification. Everything synthetic, random per run.
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { materialBody, sleep } from "./live.mjs";

/** X-Signature of the sandbox provider: HMAC-SHA256 of `<timestamp>.<raw body>`, hex. */
export function signBody(secret, timestamp, body) {
  return `v1=${createHmac("sha256", secret).update(`${timestamp}.`).update(body).digest("hex")}`;
}

/** A provider notification body as the sandbox signs it. */
export function providerEvent(type, providerRef, amountMinor, over = {}) {
  return Buffer.from(JSON.stringify({ event_id: `spt_${randomUUID()}`, type, provider_ref: providerRef, amount: { amount_minor: Number(amountMinor), currency: "USD" }, occurred_at: new Date().toISOString(), ...over }));
}

export const refOf = (checkoutUrl) => String(checkoutUrl ?? "").split("/").pop();

export function commerce({ http, db, tokens, uniq = randomUUID().slice(0, 8) }) {
  let formVersion = null;
  const material = async (label, { rights = "sellable", original = true } = {}) => {
    formVersion ??= (await http.get(tokens.reporter, "/forms/current")).body?.version;
    const r = await http.call(tokens.reporter, "POST", "/materials", { body: materialBody(formVersion, `commerce-${label}-${uniq}`) });
    if (r.status !== 201) throw new Error(`fixture material answered ${r.status}`);
    await db.query(`UPDATE materials SET rights_state = $2 WHERE id = $1`, [r.body.id, rights]);
    if (original) {
      await db.query(`INSERT INTO material_files (material_id, kind, state, size_bytes, sha256, storage_key, verified_at) VALUES ($1, 'original', 'verified', 100, $2, $3, now())`, [r.body.id, randomBytes(32), `tus/${randomUUID()}`]);
    }
    return r.body.id;
  };
  const template = async (type = "editorial_single", priceMinor = 10_000) => {
    const r = await http.call(tokens.rights_officer, "POST", "/license-templates", { body: {
      type, name: { ar: "ترخيص", en: "License" }, terms: { ar: "شروط", en: "Terms" }, usage_media: ["web"], territory: { kind: "worldwide" },
      term_days: type === "editorial_single" ? null : 30, exclusivity_hours: type === "exclusive_temporary" ? 48 : null, deliverables: ["original"],
      attribution: { ar: "المصدر", en: "Source" }, prohibitions: [], base_price: { amount_minor: priceMinor, currency: "USD" }, enabled: true } });
    if (r.status !== 201) throw new Error(`fixture template answered ${r.status}`);
    return r.body.id;
  };
  const list = (materialId, templateId, state = "listed") => http.call(tokens.rights_officer, "POST", `/materials/${materialId}/listing`, { body: {
    title: { ar: `عنوان ${uniq}`, en: `Title ${uniq}` }, description: { ar: "وصف", en: "Description" }, offers: [{ license_template_id: templateId }], state } });
  const order = (token, listingId, templateId) => http.call(token, "POST", "/orders", { body: { items: [{ listing_id: listingId, license_template_id: templateId }] } });
  /** Checkout then the hosted page's outcome button (POST <root>/sandbox/checkout/<ref>/<outcome>); returns the provider reference. */
  const pay = async (root, token, orderId, outcome = "succeeded") => {
    const co = await http.call(token, "POST", `/orders/${orderId}/checkout`, { body: {} });
    if (co.status !== 200 || co.body?.provider !== "sandbox") throw new Error(`checkout answered ${co.status} (${co.body?.provider ?? co.body?.code ?? "no provider"})`);
    const ref = refOf(co.body.checkout_url);
    const done = await fetch(`${root.replace(/\/$/, "")}/sandbox/checkout/${ref}/${outcome}`, { method: "POST" });
    if (done.status !== 202) throw new Error(`sandbox outcome answered ${done.status}`);
    return ref;
  };
  /** The order once paid (the notification is handled before the page answers; a short wait covers a slow dispatcher). */
  const paid = async (token, orderId, tries = 40) => {
    for (let i = 0; i < tries; i++) {
      const o = await http.get(token, `/orders/${orderId}`);
      if (o.body?.status === "paid" && o.body.items?.every?.((it) => it.license_id)) return o.body;
      await sleep(250);
    }
    throw new Error("the order was not paid with its licences in time");
  };
  return { material, template, list, order, pay, paid, uniq };
}
