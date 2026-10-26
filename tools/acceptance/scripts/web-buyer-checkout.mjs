#!/usr/bin/env node
// web-buyer-checkout: the buyer's way through the web app, in a real browser, against a live stack with the sandbox provider:
// catalog -> licence option -> cart -> order (pending) -> the hosted sandbox payment page -> back to the order, paid -> the issued licence and its
// certificate -> the delivery download when the package is ready. The amount is followed through four pages (cart, order, payment page) and
// must be the same each time; the licence count must grow by exactly one; the download must be counted.
// Always `partial`: sandbox provider, one buyer, one run; the delivery download is `deferred` (not a failure) when the package is not built in time
// (the media worker with MEDIA_ENABLE_DELIVERY builds it after the licence is issued).
// Security: the result carries no payment page origin or URL (only whether it was allowed) and no raw error text (the step and the error's class).
//   ACCEPTANCE_BASE_URL (the web app) ACCEPTANCE_BUYER_EMAIL ACCEPTANCE_BUYER_PASSWORD ACCEPTANCE_LISTING_ID WEB_CHECKOUT_ORIGINS (the origins the hosted page may be on)
//   optional: ACCEPTANCE_DELIVERY_WAIT_S (90) ACCEPTANCE_TIMEOUT_MS (30000)
//   The API must return the browser to the order page with `?returned=1` (SANDBOX_RETURN_URL=https://web/ar/store/orders/{order_id}?returned=1).
import { banner } from "../lib/measurement.mjs";
import { envMissing, url, loadPlaywright, login, envDoc, checkList, finishAndWrite, EnvironmentError } from "./web-gap-helpers.mjs";
import { LABELS, allowedOrigins, amountDigits, licenseNumberIn, originAllowed, remainingIn, safeFailure, step } from "./web-commerce-helpers.mjs";

export async function run(argv = process.argv.slice(2), env = process.env) {
  banner({ name: "web-buyer-checkout", criterion: "المشتري يختار مادة وترخيصًا من الكتالوج، ينشئ طلبًا ويدفع في صفحة المزوّد التجريبي، فيعود إلى طلب مدفوع وترخيص جديد بشهادته، وينزّل حزمة التسليم المعدودة إن جهزت؛ والمبلغ نفسه في كل صفحة، ولا يخرج الدفع عن الأصول المسموحة" });
  const missing = envMissing(env, ["ACCEPTANCE_BASE_URL", "ACCEPTANCE_BUYER_EMAIL", "ACCEPTANCE_BUYER_PASSWORD", "ACCEPTANCE_LISTING_ID", "WEB_CHECKOUT_ORIGINS"]);
  if (missing.length) { console.error(`ENVIRONMENT: missing ${missing.join(", ")}; nothing measured`); return { code: 2, doc: null }; }
  const doc = envDoc(env, "web-buyer-checkout");
  const { checks, check } = checkList();
  const deferred = [];
  const timeout = Number(env.ACCEPTANCE_TIMEOUT_MS ?? 30000);
  const waitDelivery = Number(env.ACCEPTANCE_DELIVERY_WAIT_S ?? 90);
  const allowed = allowedOrigins(env.WEB_CHECKOUT_ORIGINS);
  const metrics = {};
  let browser, failure = null;
  const text = async (locator) => (await locator.innerText()).trim();
  try {
    const { chromium } = await loadPlaywright();
    browser = await chromium.launch({ headless: env.ACCEPTANCE_HEADLESS !== "0" });
    const page = await (await browser.newContext({ acceptDownloads: true })).newPage();
    page.setDefaultTimeout(timeout);
    await step("login", () => login(page, env, { email: env.ACCEPTANCE_BUYER_EMAIL, password: env.ACCEPTANCE_BUYER_PASSWORD }));

    const licensesBefore = await step("licences before", async () => {
      await page.goto(url(env, "/ar/store/licenses"), { waitUntil: "networkidle" });
      return page.getByTestId("license-row").count();
    });

    await step("catalog", async () => {
      await page.goto(url(env, "/ar/store"), { waitUntil: "networkidle" });
      await page.getByTestId("catalog-card").first().waitFor();
      const card = page.getByTestId("catalog-card").filter({ has: page.locator(`a[href*="${env.ACCEPTANCE_LISTING_ID}"]`) });
      check("the listing is among the catalog cards", (await card.count()) === 1, `cards ${await card.count()}`);
    });

    await step("licence option", async () => {
      await page.goto(url(env, `/ar/store/${env.ACCEPTANCE_LISTING_ID}`), { waitUntil: "networkidle" });
      const options = page.getByRole("radio");
      await options.first().waitFor();
      const n = await options.count();
      await options.first().check();
      check("the listing offers a licence option and it can be chosen", n >= 1 && (await options.first().isChecked()), `options ${n}`);
      await page.getByRole("button", { name: LABELS.addToCart }).click();
    });

    const cartDigits = await step("cart", async () => {
      await page.getByRole("link", { name: LABELS.goToCart }).first().click();
      await page.getByTestId("cart-line").first().waitFor();
      const lines = await page.getByTestId("cart-line").count();
      const total = amountDigits(await text(page.getByTestId("cart-total").first()));
      check("the cart holds exactly the chosen line, with a total", lines === 1 && total !== null, `lines ${lines}`);
      return total;
    });

    const orderDigits = await step("order", async () => {
      await page.getByRole("button", { name: LABELS.placeOrder }).click();
      await page.waitForURL(/\/ar\/store\/orders\/[0-9a-f-]{36}(\?|$)/);
      const status = await text(page.getByTestId("order-status"));
      const total = amountDigits(await text(page.locator("h1").first()));
      check("the order is created awaiting payment", LABELS.orderPending.test(status), "status mismatch");
      check("the order total equals the cart total", total !== null && total === cartDigits, `cart ${cartDigits}, order ${total}`);
      return total;
    });
    const orderPath = new URL(page.url()).pathname;

    await step("hosted payment page", async () => {
      await page.getByRole("button", { name: LABELS.paySandbox }).click();
      await page.waitForURL((u) => /\/sandbox\/checkout\/[A-Za-z0-9_]+$/.test(u.pathname));
      const ok = originAllowed(page.url(), allowed);
      metrics.checkout_origin_allowed = ok;
      check("the hosted payment page is on an origin listed in WEB_CHECKOUT_ORIGINS", ok);
      if (!ok) throw new Error("outside the allowed origins");
      const shown = amountDigits(await text(page.locator("p").first()));
      check("the payment page asks for the order's amount, to the digit", shown !== null && shown === orderDigits, `order ${orderDigits}, page ${shown}`);
      await page.getByRole("button", { name: /^succeeded$/ }).click();
    });

    await step("return and paid", async () => {
      await page.waitForURL((u) => u.pathname === orderPath && u.searchParams.get("returned") === "1");
      check("the browser returns to the same order, told the payment succeeded", new URL(page.url()).searchParams.get("outcome") === "succeeded");
      const badge = page.getByTestId("order-status");
      let status = "";
      for (let i = 0; i < Math.ceil(timeout / 1000) && !LABELS.orderPaid.test(status); i++) { status = (await badge.innerText()).trim(); if (!LABELS.orderPaid.test(status)) await page.waitForTimeout(1000); }
      check("the order then shows paid (from the signed notification, not from the return)", LABELS.orderPaid.test(status));
    });

    const certificate = await step("licences after", async () => {
      await page.goto(url(env, "/ar/store/licenses"), { waitUntil: "networkidle" });
      const rows = page.getByTestId("license-row");
      await rows.first().waitFor();
      const after = await rows.count();
      check("exactly one new licence appeared for the organization", after === licensesBefore + 1, `${licensesBefore} -> ${after}`);
      check("the licences are active", (await rows.first().innerText()).split(/[\t\n]+/).some((cell) => LABELS.licenseActive.test(cell.trim())));
      await rows.first().getByRole("link", { name: LABELS.openCertificate }).click();
      const cert = page.getByTestId("certificate");
      await cert.waitFor();
      const number = licenseNumberIn(await text(cert));
      check("the certificate shows a licence number in the contract's shape", number !== null);
      return page.url();
    });

    await step("delivery download", async () => {
      const button = page.getByRole("button", { name: LABELS.download });
      const deadline = Date.now() + waitDelivery * 1000;
      let ready = false;
      while (Date.now() < deadline) { await button.waitFor(); if (await button.isEnabled()) { ready = true; break; } await page.waitForTimeout(3000); await page.goto(certificate, { waitUntil: "networkidle" }); }
      metrics.delivery_ready = ready;
      if (!ready) { deferred.push(`delivery download: the package was not ready within ${waitDelivery} s (needs the media worker with delivery enabled)`); console.log("DEFERRED delivery download: the package was not ready in time"); return; }
      const before = remainingIn(await text(page.getByTestId("downloads-remaining")));
      const started = page.waitForEvent("download");
      await button.click();
      const file = await started;
      check("the counted download starts as a delivery archive", /^delivery-.*\.zip$/.test(file.suggestedFilename()));
      await page.goto(certificate, { waitUntil: "networkidle" });
      const afterN = remainingIn(await text(page.getByTestId("downloads-remaining")));
      check("the remaining downloads went down by exactly one", before !== null && afterN === before - 1, `${before} -> ${afterN}`);
    });
  } catch (error) {
    if (error instanceof EnvironmentError) { console.error("ENVIRONMENT: the browser or its module is unavailable; nothing measured"); return { code: 2, doc: null }; }
    failure = safeFailure(error);
    check(`the path completes (${failure})`, false);
  } finally { await browser?.close(); }

  const failures = checks.filter((x) => !x.ok);
  const out = finishAndWrite(doc, argv, "browser", failures.length ? "fail" : "partial",
    { checks: checks.length, checks_failed: failures.length, deferred_checks: deferred.length, ...metrics },
    failures.length ? failures.map((x) => `${x.name}${x.detail ? `: ${x.detail}` : ""}`).join("؛ ")
      : `شراء تجريبي كامل عبر الواجهة في متصفح حقيقي: الكتالوج ← ترخيص ← سلة ← طلب بانتظار الدفع ← صفحة المزوّد المستضافة ← طلب مدفوع ← ترخيص جديد بشهادته${deferred.length ? "" : " ← تنزيل معدود"}؛ والمبلغ نفسه في السلة والطلب وصفحة الدفع.${deferred.length ? ` لم يُقَس: ${deferred.join("؛ ")}.` : ""} جزئية دائمًا: مزوّد تجريبي ومشترٍ واحد وتشغيل واحد؛ لا أصل صفحة الدفع ولا نص خطأ خام في هذه النتيجة.`);
  return { code: failures.length || out.error ? 1 : 0, doc };
}
if (process.argv[1] === new URL(import.meta.url).pathname) process.exit((await run()).code);
