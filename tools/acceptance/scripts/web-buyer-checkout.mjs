#!/usr/bin/env node
// شراء تجريبي من خلال واجهة المتصفح: الكتالوج → السلة → الدفع المستضاف → الترخيص → التنزيل.
import { banner } from "../lib/measurement.mjs";
import { envMissing, url, loadPlaywright, login, envDoc, checkList, finishAndWrite, EnvironmentError } from "./web-gap-helpers.mjs";

function allowedOrigins(env) {
  return (env.WEB_CHECKOUT_ORIGINS ?? "").split(",").map((value) => value.trim()).filter(Boolean).map((value) => new URL(value).origin);
}

export async function run(argv = process.argv.slice(2), env = process.env) {
  banner({ name: "web-buyer-checkout", criterion: "المشتري يختار مادة وترخيصًا، ينشئ طلبًا ويدفع بالمزوّد التجريبي، ثم يرى الترخيص ويتمكن من التنزيل؛ رابط الدفع لا يخرج عن WEB_CHECKOUT_ORIGINS" });
  const required = ["ACCEPTANCE_BASE_URL", "ACCEPTANCE_BUYER_EMAIL", "ACCEPTANCE_BUYER_PASSWORD", "ACCEPTANCE_LISTING_ID", "WEB_CHECKOUT_ORIGINS"];
  const missing = envMissing(env, required);
  if (missing.length) { console.error(`ENVIRONMENT: missing ${missing.join(", ")}; nothing measured`); return { code: 2, doc: null }; }
  const doc = envDoc(env, "web-buyer-checkout"); const { checks, check } = checkList(); let browser;
  try {
    const { chromium } = await loadPlaywright(); browser = await chromium.launch({ headless: env.ACCEPTANCE_HEADLESS !== "0" });
    const context = await browser.newContext(); const page = await context.newPage();
    await login(page, env, { email: env.ACCEPTANCE_BUYER_EMAIL, password: env.ACCEPTANCE_BUYER_PASSWORD });
    await page.goto(url(env, "/ar/store"), { waitUntil: "domcontentloaded" });
    const card = page.getByTestId("catalog-card").filter({ has: page.locator(`a[href*="${env.ACCEPTANCE_LISTING_ID}"]`) }).first();
    if (!(await card.count())) await page.goto(url(env, `/ar/store/${env.ACCEPTANCE_LISTING_ID}`), { waitUntil: "domcontentloaded" });
    else await card.locator("a").first().click();
    const license = page.getByRole("radio").first();
    if (!(await license.count())) throw new Error("no license option is available");
    await license.check();
    await page.getByRole("button", { name: /إضافة إلى السلة|Add to cart/i }).click();
    await page.getByRole("link", { name: /السلة|Cart/i }).click();
    await page.getByTestId("cart-line").waitFor({ state: "visible" });
    check("catalog item and license enter the cart", true);
    await page.getByRole("button", { name: /إنشاء الطلب|Place order|Create order/i }).click();
    await page.waitForURL(/\/ar\/store\/orders\/[0-9a-f-]{36}$/);
    await page.getByRole("button", { name: /الدفع لدى المزوّد التجريبي|Pay at the sandbox provider/i }).click();
    const checkoutUrl = page.url(); const checkoutOrigin = new URL(checkoutUrl).origin; const allowed = allowedOrigins(env);
    check("hosted checkout origin is explicitly allowed", allowed.includes(checkoutOrigin), `origin=${checkoutOrigin}`);
    if (!allowed.includes(checkoutOrigin)) throw new Error("checkout origin is outside WEB_CHECKOUT_ORIGINS");
    await page.getByRole("link", { name: /Pay \(sandbox\)|الدفع التجريبي/i }).click();
    await page.waitForURL(/\/ar\/store\/orders\/[0-9a-f-]{36}\?returned=1$/);
    await page.getByTestId("order-status").waitFor({ state: "visible", timeout: Number(env.ACCEPTANCE_TIMEOUT_MS ?? 30000) });
    check("sandbox payment returns to the order page", true);
    await page.getByText(/مدفوع|Paid/i).waitFor({ state: "visible", timeout: Number(env.ACCEPTANCE_TIMEOUT_MS ?? 30000) });
    check("the order is paid and licenses are issued", true);
    await page.goto(url(env, "/ar/store/licenses"), { waitUntil: "domcontentloaded" });
    const licenseRow = page.getByTestId("license-row").first(); await licenseRow.waitFor({ state: "visible" });
    await licenseRow.getByRole("link", { name: /فتح|Open/i }).click();
    await page.getByTestId("certificate").waitFor({ state: "visible" }); check("the license certificate is readable", true);
    const download = page.waitForEvent("download"); await page.getByRole("button", { name: /تنزيل|Download/i }).click();
    const artifact = await download; check("the counted delivery download starts", /^delivery-.*\.zip$/.test(artifact.suggestedFilename()), artifact.suggestedFilename());
    const failures = checks.filter((x) => !x.ok); finishAndWrite(doc, argv, "browser", failures.length ? "fail" : "pass", { checks: checks.length, checks_failed: failures.length, checkout_origin_allowed: allowed.includes(checkoutOrigin), payment_provider_sandbox: true, order_paid: true, license_visible: true, download_started: true }, failures.length ? failures.map((x) => x.name).join("؛ ") : "مسار شراء تجريبي من المتصفح؛ لا أموال حقيقية ولا ملفات حقيقية؛ لا لقطات محفوظة");
    return { code: failures.length ? 1 : 0, doc };
  } catch (error) {
    if (error instanceof EnvironmentError) return { code: 2, doc: null };
    finishAndWrite(doc, argv, "browser-failure", "fail", { checks: checks.length, checks_failed: 1 }, `فشل المسار: ${error.message}`); return { code: 1, doc };
  } finally { await browser?.close(); }
}
if (process.argv[1] === new URL(import.meta.url).pathname) process.exit((await run()).code);
