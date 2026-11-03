// Commerce fixtures of the second buyer organization for tenant-isolation (live/seed.mjs seeds the organization and its
// admin): a listed material and an order of that organization paid on the sandbox page (so it has a licence), and a listing
// left in draft (a catalog view private to staff). Synthetic and random per run; no real money (sandbox provider only).
// Without a sandbox provider the order stays unpaid and the licence fixture is null: its cases are skipped, never passed.
import pg from "pg";
import { client } from "../lib/live.mjs";
import { commerce } from "../lib/commerce.mjs";

export async function seedTenantCommerce({ databaseUrl, apiUrl, rootUrl, tokens }) {
  const db = new pg.Client({ connectionString: databaseUrl });
  await db.connect();
  try {
    const c = commerce({ http: client(apiUrl), db, tokens });
    const templateId = await c.template();
    const listed = await c.list(await c.material("tenant"), templateId);
    if (listed.status !== 201) throw new Error(`tenant fixture listing answered ${listed.status}`);
    const draft = await c.list(await c.material("tenant-draft"), templateId, "draft");
    if (draft.status !== 201) throw new Error(`tenant fixture draft listing answered ${draft.status}`);
    const order = await c.order(tokens.buyer_admin_b, listed.body.id, templateId);
    if (order.status !== 201) throw new Error(`tenant fixture order answered ${order.status}`);
    let licenseId = null;
    try {
      await c.pay(rootUrl, tokens.buyer_admin_b, order.body.id);
      licenseId = (await c.paid(tokens.buyer_admin_b, order.body.id)).items[0].license_id;
    } catch (e) {
      console.log(`tenant fixtures: no paid order for the second organization (${e.message}); its licence cases are skipped`);
    }
    return { other_org_order_id: order.body.id, other_org_license_id: licenseId, unlisted_listing_id: draft.body.id };
  } finally {
    await db.end();
  }
}
