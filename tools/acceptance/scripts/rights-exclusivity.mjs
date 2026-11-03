// rights-exclusivity — plan row «الحقوق والحصرية»: no sale of a material whose rights are blocked or unknown, or of what is
// derived from it, and no exclusive licence sold twice, concurrent orders included. Measured on a running server with the
// sandbox provider (no real money), judged from the API and the database:
//   rights   a material with unknown or blocked rights cannot be listed (409 rights_not_sellable) and is not orderable;
//            blocking a listed material suspends its listing at once: it leaves the catalog, its watermarked preview (the
//            derivative a buyer can reach) is gone, a new order is refused, and a payment that lands after the block issues
//            no licence (the order is cancelled for rights_changed);
//   exclusive concurrent orders for one exclusive offer from two organizations: exactly one holds it, the rest 409
//            exclusive_unavailable; once paid, no further exclusive order; a hold that expires and is taken by another buyer
//            while the first payment is still in flight ends with one exclusive licence, never two (the late payment is
//            refused for exclusivity_lost); a material already sold under a non-exclusive licence offers no exclusivity.
// Fixture rows the media worker would make (rights state of a new material, a verified original, a watermarked preview)
// are written by SQL, and the hold is released by SQL as the expiry sweep does, instead of waiting 15 minutes. Always partial: «derived from it»
// is measured on the material's derived files (preview, delivery); a separate derived-material entity does not exist.
//   RX_API_URL=http://127.0.0.1:13000/v1  RX_ROOT_URL=http://127.0.0.1:13000  RX_DATABASE_URL=postgres://…  RX_WEBHOOK_SECRET=…
//   RX_TOKENS='{"reporter":"…","rights_officer":"…","buyer_admin":"…","buyer_member":"…","buyer_admin_b":"…"}'  [RX_CONCURRENCY=6]
import { randomBytes } from "node:crypto";
import pg from "pg";
import { newResult, finish, writeResult, parseArgs, banner } from "../lib/measurement.mjs";
import { byName } from "../lib/catalog.mjs";
import { client } from "../lib/live.mjs";
import { commerce, providerEvent, refOf, signBody } from "../lib/commerce.mjs";

/** Judges a burst of concurrent orders for one exclusive offer: exactly one 201, every other answer 409 exclusive_unavailable. */
export function judgeBurst(answers) {
  const won = answers.filter((a) => a.status === 201);
  const lost = answers.filter((a) => a.status === 409 && a.body?.code === "exclusive_unavailable");
  const other = answers.length - won.length - lost.length;
  return { won: won.length, lost: lost.length, other, ok: won.length === 1 && other === 0 };
}

export async function run(argv = process.argv.slice(2), env = process.env) {
  const args = parseArgs(argv);
  banner(byName("rights-exclusivity"));
  const need = ["RX_API_URL", "RX_ROOT_URL", "RX_DATABASE_URL", "RX_WEBHOOK_SECRET", "RX_TOKENS"].filter((k) => !env[k]);
  if (need.length) { console.error(`ENVIRONMENT: missing ${need.join(", ")}; nothing measured`); return { code: 2, doc: null }; }
  const tokens = JSON.parse(env.RX_TOKENS);
  const missingRoles = ["reporter", "rights_officer", "buyer_admin", "buyer_member", "buyer_admin_b"].filter((r) => !tokens[r]);
  if (missingRoles.length) { console.error(`ENVIRONMENT: RX_TOKENS needs ${missingRoles.join(", ")}; nothing measured`); return { code: 2, doc: null }; }
  const root = env.RX_ROOT_URL.replace(/\/$/, "");
  const concurrency = Number(env.RX_CONCURRENCY ?? 6);
  const http = client(env.RX_API_URL);
  const db = new pg.Client({ connectionString: env.RX_DATABASE_URL });
  const doc = newResult("rights-exclusivity", { device: { platform: "server", model: env.RX_ENV_LABEL ?? "server" }, upload_path: "n/a" });
  const fails = [], deferred = [], metrics = { concurrency };
  let checks = 0;
  const check = (name, ok, why = "") => { checks++; if (!ok) { fails.push(`${name}${why ? `: ${why}` : ""}`); console.log(`FAIL ${name} ${why}`); } else console.log(`ok   ${name}`); return ok; };
  const defer = (name, why) => { deferred.push(`${name}: ${why}`); console.log(`DEFERRED ${name} — ${why}`); };
  const q = async (text, params) => (await db.query(text, params)).rows;
  const send = (raw) => { const ts = Math.floor(Date.now() / 1000); return fetch(`${root}/payments/webhooks/sandbox`, { method: "POST", headers: { "content-type": "application/json", "x-timestamp": String(ts), "x-signature": signBody(env.RX_WEBHOOK_SECRET, ts, raw) }, body: raw }); };
  const exclusiveLicences = async (materialId) => Number((await q(`SELECT count(*) AS n FROM licenses WHERE material_id = $1 AND license_type = 'exclusive_temporary' AND status = 'active'`, [materialId]))[0].n);
  const licencesOfOrder = async (orderId) => Number((await q(`SELECT count(*) AS n FROM licenses l JOIN order_items i ON i.id = l.order_item_id WHERE i.order_id = $1`, [orderId]))[0].n);
  const inCatalog = async (listingId) => ((await http.get(tokens.buyer_member, "/catalog?limit=100")).body?.items ?? []).some((i) => i.listing_id === listingId);
  await db.connect();
  try {
    const c = commerce({ http, db, tokens });
    const plain = await c.template("editorial_single");
    const exclusive = await c.template("exclusive_temporary");

    // ---------- rights: unknown and blocked are never listed nor ordered ----------
    for (const rights of ["unknown", "blocked"]) {
      const m = await c.material(`rx-${rights}`, { rights });
      const listed = await c.list(m, plain);
      check(`${rights} rights cannot be listed (409 rights_not_sellable)`, listed.status === 409 && listed.body?.code === "rights_not_sellable", `${listed.status} ${listed.body?.code}`);
      const draft = await c.list(m, plain, "draft");
      check(`${rights} rights may sit in a draft listing (staff only)`, draft.status === 201, `${draft.status}`);
      if (draft.status === 201) {
        check(`the ${rights} draft is not in the buyer catalog`, !(await inCatalog(draft.body.id)));
        const o = await c.order(tokens.buyer_admin, draft.body.id, plain);
        check(`an order on the ${rights} draft is 409 listing_unavailable`, o.status === 409 && o.body?.code === "listing_unavailable", `${o.status} ${o.body?.code}`);
      }
    }

    // ---------- rights: blocking a listed material while a payment is in flight ----------
    const m = await c.material("rx-blocked-later");
    const original = (await q(`SELECT id FROM material_files WHERE material_id = $1 AND kind = 'original'`, [m]))[0].id;
    await q(`INSERT INTO material_files (material_id, kind, state, size_bytes, sha256, storage_key, verified_at, derived_from_id, mime_type)
             VALUES ($1, 'watermarked_preview', 'verified', 100, $2, $3, now(), $4, 'video/mp4')`, [m, randomBytes(32), `derived/${m}/${original}/preview.mp4`, original]);
    const listing = await c.list(m, plain);
    check("a sellable material is listed", listing.status === 201, `${listing.status}`);
    const listingId = listing.body?.id;
    const pending = await c.order(tokens.buyer_admin, listingId, plain);
    check("a buyer orders it", pending.status === 201, `${pending.status}`);
    const co = await http.call(tokens.buyer_admin, "POST", `/orders/${pending.body?.id}/checkout`, { body: {} });
    check("its checkout opens", co.status === 200, `${co.status}`);
    const previewBefore = (await http.get(tokens.buyer_member, `/catalog/${listingId}/preview-url`)).status;
    const etag = (await http.get(tokens.rights_officer, `/materials/${m}`)).headers.etag;
    const blocked = await http.call(tokens.rights_officer, "POST", `/materials/${m}/transitions`, { body: { track: "rights", to: "blocked", reason: "rights dispute" }, headers: etag ? { "if-match": etag } : {} });
    check("the rights officer blocks the material", blocked.status === 200 && blocked.body?.rights_state === "blocked", `${blocked.status}`);
    check("its listing is suspended at once", (await q(`SELECT state FROM catalog_listings WHERE id = $1`, [listingId]))[0]?.state === "suspended");
    check("it leaves the buyer catalog (search and detail)", !(await inCatalog(listingId)) && (await http.get(tokens.buyer_member, `/catalog/${listingId}`)).status === 404);
    const previewAfter = (await http.get(tokens.buyer_member, `/catalog/${listingId}/preview-url`)).status;
    if (previewBefore === 404) defer("the derived preview disappears", "the preview link needs object storage, not configured in this stack (404 before the block too)");
    else check("its derived preview is no longer reachable", previewAfter === 404, `${previewBefore} → ${previewAfter}`);
    const late = await c.order(tokens.buyer_member, listingId, plain);
    check("a new order is 409 listing_unavailable", late.status === 409 && late.body?.code === "listing_unavailable", `${late.status} ${late.body?.code}`);
    const again = await http.call(tokens.buyer_admin, "POST", `/orders/${pending.body?.id}/checkout`, { body: {} });
    check("the pending order cannot open a new checkout", again.status === 409, `${again.status} ${again.body?.code}`);
    const paidLate = await send(providerEvent("payment.succeeded", refOf(co.body?.checkout_url), 10_000));
    check("the payment that lands after the block is accepted by the endpoint", paidLate.status === 200, `${paidLate.status}`);
    const after = (await q(`SELECT status, cancel_reason FROM orders WHERE id = $1`, [pending.body?.id]))[0];
    check("and issues no licence: the order is cancelled for rights_changed", (await licencesOfOrder(pending.body?.id)) === 0 && after?.status === "cancelled" && after?.cancel_reason === "rights_changed", `${after?.status}/${after?.cancel_reason}`);

    // ---------- exclusivity: concurrent orders, two organizations ----------
    const ex = await c.material("rx-exclusive");
    const exListing = (await c.list(ex, exclusive)).body?.id;
    const buyers = [tokens.buyer_admin, tokens.buyer_member, tokens.buyer_admin_b];
    const burst = await Promise.all(Array.from({ length: concurrency }, (_, i) => c.order(buyers[i % buyers.length], exListing, exclusive)));
    const judged = judgeBurst(burst);
    Object.assign(metrics, { burst_won: judged.won, burst_refused: judged.lost, burst_other: judged.other });
    check(`${concurrency} concurrent exclusive orders: exactly one holds, the rest 409 exclusive_unavailable`, judged.ok, burst.map((a) => `${a.status}${a.body?.code ? ` ${a.body.code}` : ""}`).join(","));
    const winner = burst.find((a) => a.status === 201);
    const winnerToken = buyers[burst.indexOf(winner) % buyers.length];
    const holds = Number((await q(`SELECT count(*) AS n FROM exclusive_holds WHERE material_id = $1 AND state IN ('held', 'active')`, [ex]))[0].n);
    check("one hold row for the material", holds === 1, `${holds}`);
    if (winner) {
      await c.pay(root, winnerToken, winner.body.id);
      await c.paid(winnerToken, winner.body.id);
      check("the holder pays: one active exclusive licence", (await exclusiveLicences(ex)) === 1);
      const second = await Promise.all(buyers.map((t) => c.order(t, exListing, exclusive)));
      check("after the sale every exclusive order is 409 exclusive_unavailable", second.every((a) => a.status === 409 && a.body?.code === "exclusive_unavailable"), second.map((a) => a.status).join(","));
    }

    // ---------- exclusivity: an expired hold taken by another buyer while the first payment is in flight ----------
    const race = await c.material("rx-race");
    const raceListing = (await c.list(race, exclusive)).body?.id;
    const first = await c.order(tokens.buyer_admin, raceListing, exclusive);
    const firstCo = await http.call(tokens.buyer_admin, "POST", `/orders/${first.body?.id}/checkout`, { body: {} });
    check("the first buyer holds and opens checkout", first.status === 201 && firstCo.status === 200, `${first.status}/${firstCo.status}`);
    // انتهاء الحجز كما يكتبه الكنس (released)، بدل انتظار 15 دقيقة؛ نافذة الحجز نفسها لا تُعدَّل (exclusive_hold_guard)
    await q(`UPDATE exclusive_holds SET state = 'released', released_at = now() WHERE order_item_id = $1 AND state = 'held'`, [first.body?.items?.[0]?.id]);
    const taker = await c.order(tokens.buyer_admin_b, raceListing, exclusive);
    check("after the hold expires another organization holds it", taker.status === 201, `${taker.status} ${taker.body?.code}`);
    const takerCo = taker.status === 201 ? await http.call(tokens.buyer_admin_b, "POST", `/orders/${taker.body.id}/checkout`, { body: {} }) : null;
    const [lateFirst, onTime] = await Promise.all([
      send(providerEvent("payment.succeeded", refOf(firstCo.body?.checkout_url), 10_000)),
      takerCo ? send(providerEvent("payment.succeeded", refOf(takerCo.body?.checkout_url), 10_000)) : Promise.resolve({ status: 0 }),
    ]);
    check("both payments answered 200", lateFirst.status === 200 && onTime.status === 200, `${lateFirst.status}/${onTime.status}`);
    const sold = await exclusiveLicences(race);
    metrics.race_exclusive_licences = sold;
    check("exactly one exclusive licence for the material, never two", sold === 1, `${sold}`);
    if (taker.status === 201) check("it is the current holder's, the late payment issued none", (await licencesOfOrder(taker.body.id)) === 1 && (await licencesOfOrder(first.body?.id)) === 0);

    // ---------- exclusivity: a material sold non-exclusively offers no exclusivity ----------
    const both = await c.material("rx-both");
    const bothTemplate = await c.template("exclusive_temporary");
    const bothListing = await http.call(tokens.rights_officer, "POST", `/materials/${both}/listing`, { body: {
      title: { ar: "عنوان", en: "Title" }, description: { ar: "وصف", en: "Description" }, offers: [{ license_template_id: plain }, { license_template_id: bothTemplate }], state: "listed" } });
    check("a material listed with a plain and an exclusive offer", bothListing.status === 201, `${bothListing.status}`);
    const sale = await c.order(tokens.buyer_admin, bothListing.body?.id, plain);
    if (sale.status === 201) { await c.pay(root, tokens.buyer_admin, sale.body.id); await c.paid(tokens.buyer_admin, sale.body.id); }
    const exAfter = await c.order(tokens.buyer_admin_b, bothListing.body?.id, bothTemplate);
    check("after a non-exclusive sale an exclusive order is 409 exclusive_unavailable", exAfter.status === 409 && exAfter.body?.code === "exclusive_unavailable", `${exAfter.status} ${exAfter.body?.code}`);
    const item = (await http.get(tokens.buyer_member, `/catalog/${bothListing.body?.id}`)).body;
    check("and the catalog says so (exclusive_available false)", item?.exclusive_available === false, `${item?.exclusive_available}`);
  } catch (e) {
    fails.push(`aborted: ${String(e.message).replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, "<url>").slice(0, 200)}`);
    console.error(e.stack ?? e);
  } finally {
    await db.end();
  }
  const failed = fails.length > 0;
  Object.assign(metrics, { checks, checks_failed: fails.length, deferred_checks: deferred.length });
  finish(doc, failed ? "fail" : "partial", metrics, failed ? fails.join("؛ ") : [
    `الحقوق: المجهولة والمحظورة لا تُدرج ولا تُطلب؛ حظر مادة معروضة يعلّق إدراجها فورًا فتغيب عن الكتالوج${deferred.length ? "" : " ومعاينتها المشتقة"}، ويُرفض الطلب الجديد ودفع جديد للطلب القائم، والدفع الذي يصل بعد الحظر لا يُصدر ترخيصًا ويُلغى الطلب بسبب rights_changed`,
    `الحصرية: ${concurrency} طلبات متزامنة من مؤسستين يحجزها واحد والباقي 409، وبعد البيع لا طلب حصري، وحجز انتهى وأخذه مشترٍ آخر والدفع الأول في الطريق ينتهي بترخيص حصري واحد، والمادة المبيعة بترخيص غير حصري لا تعرض الحصرية`,
    "جزئي دائمًا: صفوف حقوق المادة الجديدة والأصل المتحقق والمعاينة كُتبت بـSQL (لا عامل وسائط هنا)، وانتهاء الحجز بتحريره في القاعدة كما يحرّره الكنس بدل انتظار 15 دقيقة، و«المشتقة منها» قيست على ملفات المادة المشتقة (المعاينة)؛ لا كيان «مادة مشتقة» مستقلًا في النموذج. مزوّد تجريبي لا مال حقيقي",
    deferred.length ? `لم يُقَس هنا: ${deferred.join("؛ ")}` : null,
  ].filter(Boolean).join("؛ "));
  if (args["dry-run"]) writeResult(doc, { dryRun: true });
  else console.log("wrote", writeResult(doc, { slug: "sandbox" }));
  return { code: failed ? 1 : 0, doc };
}

if (process.argv[1] === new URL(import.meta.url).pathname) process.exit((await run()).code);
