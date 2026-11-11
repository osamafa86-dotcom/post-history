import { expect, test, type Page } from "@playwright/test";
import ar from "../messages/ar.json" with { type: "json" };
import en from "../messages/en.json" with { type: "json" };
const s = ar.store, b = ar.store.browse, o = ar.orders, l = ar.licenses;
async function login(page: Page, role: string) {
  await page.goto("/ar/login"); await page.getByLabel(ar.email).fill(`${role}@example.test`); await page.getByLabel(ar.password, { exact: true }).fill("synthetic-password"); await page.getByLabel(ar.totp, { exact: true }).fill("123456"); await page.getByRole("button", { name: ar.signIn, exact: true }).click();
}
/** لون رمز v2 كما يحسبه المتصفح (rgb)، لمقارنة الفعل الذهبي الثابت بالرمز نفسه لا بلون منسوخ. */
async function tokenRgb(page: Page, name: string) {
  const hex = await page.evaluate(token => getComputedStyle(document.documentElement).getPropertyValue(token).trim(), name);
  return `rgb(${[1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)).join(", ")})`;
}
test.beforeEach(async ({ request }) => { await request.post("http://127.0.0.1:3201/__test/reset"); });

test("S1 catalog: hero, governorate and period chips, more filters, store cards without names, and E6 with removable filters", async ({ page }) => {
  const c = s.catalog;
  await login(page, "buyer"); await expect(page).toHaveURL(/\/ar\/store$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(`${c.heading} ${c.headingAccent}`); await expect(page.locator(".store-lead")).toHaveText(c.lead);
  await expect(page.getByTestId("catalog-card")).toHaveCount(2);
  for (const card of await page.getByTestId("catalog-card").all()) { await expect(card).toContainText(s.card.previewBadge); await expect(card).toContainText(s.card.cta); await expect(card).not.toContainText("فلسطين بوست"); }
  await expect(page.getByTestId("catalog-card").first()).toContainText(b.exclusive); await expect(page.getByTestId("catalog-card").nth(1)).not.toContainText(b.exclusive);
  await expect(page.getByTestId("catalog-card").first()).toContainText("صُوّر 19 تشرين الأول 2026 · غزة");
  await expect(page.getByTestId("catalog-card").first().getByRole("link", { name: s.card.ctaFor.replace("{title}", "لقطات اصطناعية 1") })).toHaveCSS("background-color", await tokenRgb(page, "--v2-c-action-store"));
  const chips = page.getByRole("navigation", { name: c.chipsLabel });
  await expect(chips.getByRole("button")).toHaveText([c.all, c.week, "دير البلح", "غزة"]); await expect(chips.getByRole("button", { name: c.all })).toHaveAttribute("aria-pressed", "true");
  const governorate = page.waitForRequest(r => r.url().includes("/api/bff/catalog?") && r.url().includes(new URLSearchParams({ governorate: "دير البلح" }).toString()));
  await chips.getByRole("button", { name: "دير البلح" }).click(); await governorate; await expect(page.getByTestId("catalog-card")).toHaveCount(1);
  await expect(chips.getByRole("button", { name: "دير البلح" })).toHaveAttribute("aria-pressed", "true"); await expect(chips.getByRole("button", { name: "غزة" })).toBeVisible();
  // E6: آخر 7 أيام بلا مواد؛ يقول لماذا، والفعل الذهبي يعرض كل المواد، والمرشحات رقاقات قابلة للإزالة
  await chips.getByRole("button", { name: c.week }).click();
  const empty = page.getByTestId("store-empty");
  await expect(empty.getByRole("heading")).toHaveText(c.emptyTitle.replace("{filters}", `دير البلح${c.listSeparator}${c.week}`)); await expect(empty).toContainText(c.emptyWhy);
  await expect(empty.getByRole("button", { name: c.showAll })).toHaveCSS("background-color", await tokenRgb(page, "--v2-c-action-store"));
  await empty.getByRole("button", { name: b.removeFilter.replace("{filter}", c.week) }).click(); await expect(page.getByTestId("catalog-card")).toHaveCount(1);
  await chips.getByRole("button", { name: c.all }).click(); await expect(page.getByTestId("catalog-card")).toHaveCount(2);
  const filtered = page.waitForRequest(r => r.url().includes("/api/bff/catalog?") && r.url().includes("min_height=1080"));
  await page.locator(".store-more summary").click(); await page.getByLabel(s.resolution).selectOption("1080"); await filtered;
  await page.getByLabel(s.search, { exact: true }).fill("zzz"); await page.getByRole("button", { name: b.searchButton, exact: true }).click();
  await expect(page.getByTestId("store-empty")).toContainText("zzz");
  await page.getByTestId("store-empty").getByRole("button", { name: c.showAll }).click(); await expect(page.getByTestId("catalog-card")).toHaveCount(2);
  await page.setViewportSize({ width: 1440, height: 900 }); await page.screenshot({ path: ".artifacts/s1-catalog-ar.png", fullPage: true });
});

test("S2 item: watermarked preview, shoot day and governorate only, licences with prices, one primary action, no names or fingerprints", async ({ page }) => {
  await login(page, "buyer"); await expect(page).toHaveURL(/\/ar\/store$/);
  await page.goto("/ar/store/71000000-0000-4000-8000-000000000001");
  await expect(page.getByRole("navigation", { name: s.item.breadcrumb })).toContainText(s.nav.materials);
  await expect(page.locator(".store-preview .viewer-mark")).toHaveText(/@example\.test$/); await expect(page.getByText(s.item.previewNote)).toBeVisible();
  await expect(page.getByTestId("item-facts")).toContainText("صُوّر 19 تشرين الأول 2026"); await expect(page.getByTestId("item-facts")).toContainText("غزة"); await expect(page.getByTestId("item-facts")).not.toContainText("13:45");
  const card = page.getByRole("region", { name: b.authenticity });
  await expect(card).toContainText(b.verifiedOriginal); await expect(card).toContainText(b.version.replace("{n}", "1")); await expect(card).toContainText(s.item.rightsHelp);
  await expect(page.locator("main")).not.toContainText(/لقطة عامة|sha256|never-display-canary|فلسطين بوست/);
  expect(await (await page.request.get("/api/bff/catalog/71000000-0000-4000-8000-000000000001")).text()).not.toMatch(/لقطة عامة|فلسطين بوست/);
  await expect(page.getByRole("radio")).toHaveCount(2); await expect(page.locator(".license-price").first()).toContainText("150.00");
  await expect(page.getByRole("button", { name: s.addToCart })).toBeDisabled();
  await page.getByRole("radio", { name: /حصري 48 ساعة/ }).check(); await expect(page.getByText(b.holdNote)).toBeVisible();
  await page.getByRole("button", { name: b.addFor.replace("{price}", "") }).click();
  await expect(page.getByRole("status").filter({ hasText: b.added })).toBeVisible();
  await expect(page.getByTestId("cart-chip")).toHaveAccessibleName(s.nav.cartCount.replace("{n}", "1")); await expect(page.getByTestId("cart-chip")).toContainText("1");
  await page.setViewportSize({ width: 1440, height: 900 }); await page.screenshot({ path: ".artifacts/s2-item-ar.png", fullPage: true });
  await page.getByTestId("cart-chip").click(); await expect(page).toHaveURL(/\/ar\/store\/cart$/);
  await expect(page.getByTestId("cart-line")).toHaveCount(1); await expect(page.getByText(b.filesAfterPayment)).toBeVisible();
  await expect(page.getByTestId("cart-line").getByRole("link", { name: b.changeLicense })).toHaveAttribute("href", "/ar/store/71000000-0000-4000-8000-000000000001");
});

test("S3 cart: the summary is the total alone, an optional purchase order number by the contract's rule, the fixed sandbox line, then the hosted page", async ({ page }) => {
  const c = s.cartPage;
  await login(page, "buyer"); await expect(page).toHaveURL(/\/ar\/store$/);
  await page.goto("/ar/store/cart"); await expect(page.getByRole("heading", { name: c.emptyTitle })).toBeVisible();
  await page.getByRole("link", { name: c.browse }).click(); await expect(page).toHaveURL(/\/ar\/store$/);
  await page.getByTestId("catalog-card").first().getByRole("link", { name: s.card.ctaFor.replace("{title}", "لقطات اصطناعية 1") }).click();
  await page.getByRole("radio", { name: /حصري 48 ساعة/ }).check(); await page.getByRole("button", { name: b.addFor.replace("{price}", "") }).click();
  await page.getByTestId("cart-chip").click();
  const summary = page.getByRole("complementary", { name: c.summary });
  await expect(summary.getByTestId("cart-total")).toContainText("900.00"); await expect(summary).not.toContainText(/مجموع فرعي|ضريبة/);
  await expect(page.getByTestId("sandbox-line")).toHaveText(c.sandbox);
  await page.getByLabel(c.poLabel).fill("أمر 17"); await page.getByRole("button", { name: c.checkout }).click();
  await expect(page.getByText(c.poInvalid)).toBeVisible(); await expect(page.getByLabel(c.poLabel)).toHaveAttribute("aria-invalid", "true"); await expect(page).toHaveURL(/\/ar\/store\/cart$/);
  await page.getByLabel(c.poLabel).fill("PO 2026/17-A");
  await page.setViewportSize({ width: 1440, height: 900 }); await page.screenshot({ path: ".artifacts/s3-cart-ar.png", fullPage: true });
  const created = page.waitForRequest(r => r.url().endsWith("/api/bff/orders") && r.method() === "POST");
  await page.getByRole("button", { name: c.checkout }).click();
  expect((await created).postDataJSON()).toMatchObject({ purchase_order_number: "PO 2026/17-A", expected_total: { amount_minor: 90000, currency: "USD" } });
  await expect(page).toHaveURL(/127\.0\.0\.1:3201\/sandbox\/checkout\//);
  const id = page.url().split("/").pop()!;
  // العودة لا تؤكد الدفع: صفحة الطلب بحجز الحصرية وعدّاده، ولا فاتورة قبل التأكيد
  await page.goto(`/ar/store/orders/${id}`);
  // لافتة تجريبية واحدة في الصفحة.
  await expect(page.getByTestId("trial-notice")).toHaveCount(1); await expect(page.locator(".sandbox-banner")).toHaveCount(0);
  await expect(page.getByTestId("hold-timer")).toContainText(/حجز الحصرية ينتهي خلال \d\d:\d\d/);
  await expect(page.locator(".order-summary")).toContainText("PO 2026/17-A"); await expect(page.locator(".order-summary")).toContainText(/ORD-\d{4}-[0-9A-HJKMNP-TV-Z]{8}/);
  await expect(page.getByRole("link", { name: o.invoice, exact: true })).toHaveCount(0); await expect(page.getByText(o.noInvoice)).toBeVisible();
  await page.goto(`/ar/store/orders/${id}/invoice`); await expect(page.getByRole("heading", { name: s.invoice.notPaidTitle })).toBeVisible();
});

test("S4 my licences: each tied to its readable order, download the delivery package, the ended one by its date with renew, the revoked one as a word", async ({ page }) => {
  await login(page, "buyer"); await expect(page).toHaveURL(/\/ar\/store$/);
  await page.getByRole("banner").getByRole("navigation", { name: ar.workspace }).getByRole("link", { name: s.nav.licenses }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(s.nav.licenses);
  await expect(page.getByRole("columnheader")).toHaveText([l.colMaterial, l.colOrder, l.colLicence, l.colEnds, l.colAction]);
  const rows = page.getByTestId("license-row"); await expect(rows).toHaveCount(3);
  const active = rows.filter({ hasText: "PH-2026-7K3M9Q2XRT" }), revoked = rows.filter({ hasText: "PH-2026-4HJ8NP0WVZ" }), ended = rows.filter({ hasText: "PH-2026-9WQ3T6M1KD" });
  await expect(active).toContainText("ORD-2026-7K3M9Q2X"); await expect(active).toContainText(l.noExpiry);
  await expect(active.getByRole("link", { name: l.invoiceFor.replace("{id}", "ORD-2026-7K3M9Q2X") })).toHaveAttribute("href", "/ar/store/orders/92000000-0000-4000-8000-000000000001/invoice");
  await expect(revoked).toContainText(l.revokedShort); await expect(revoked.getByRole("button")).toHaveCount(0);
  await expect(ended).toContainText(l.endedOn.replace("{date}", "12 تشرين الأول 2026")); await expect(ended).toContainText("92000000");
  // طلب الترخيص المنتهي ليس من طلبات هذا العضو: رقمه ظاهر بلا رابط فاتورة لا يفتحها.
  await expect(ended.getByTestId("order-plain")).toHaveText("92000000"); await expect(ended.getByRole("link", { name: l.invoiceFor.replace("{id}", "92000000") })).toHaveCount(0);
  await expect(ended.getByRole("link", { name: l.renewFor.replace("{title}", "لقطات اصطناعية 2") })).toHaveAttribute("href", "/ar/store/71000000-0000-4000-8000-000000000002");
  await expect(ended.getByRole("button")).toHaveCount(0);
  await page.setViewportSize({ width: 1440, height: 900 }); await page.screenshot({ path: ".artifacts/s4-licences-ar.png", fullPage: true });
  const download = page.waitForEvent("download"); await active.getByRole("button", { name: l.downloadFor.replace("{title}", "لقطات اصطناعية 1") }).click();
  expect((await download).suggestedFilename()).toMatch(/^delivery-.*\.zip$/);
  await expect(active.getByTestId("downloads-remaining")).toContainText("2");
  await expect(page.locator("main")).not.toContainText(/never-display-canary|فلسطين بوست/);
});

test("S7 invoice: a light sheet in the dark store with the fixed test banner, readable numbers, the purchase order, licence numbers and the total alone; it prints", async ({ page }) => {
  const v = s.invoice;
  await login(page, "buyer"); await expect(page).toHaveURL(/\/ar\/store$/);
  await page.goto("/ar/store/orders"); await page.getByTestId("order-row").filter({ hasText: "ORD-2026-7K3M9Q2X" }).getByRole("link", { name: "INV-2026-000002" }).click();
  await expect(page).toHaveURL(/\/ar\/store\/orders\/92000000-0000-4000-8000-000000000001\/invoice$/);
  const sheet = page.getByTestId("invoice");
  await expect(sheet).toHaveAttribute("data-mode", "light"); await expect(page.locator(".app-shell")).toHaveAttribute("data-mode", "dark");
  await expect(sheet.getByRole("heading", { level: 1 })).toHaveText(v.title);
  await expect(page.getByTestId("invoice-sandbox")).toHaveText(v.sandbox); await expect(page.getByTestId("issuer-pending")).toHaveText(v.issuerPending);
  await expect(sheet).toContainText("INV-2026-000002"); await expect(sheet).toContainText("ORD-2026-7K3M9Q2X"); await expect(page.getByTestId("invoice-po")).toContainText("PO-2026-1188");
  await expect(sheet).toContainText("شبكة الأخبار الاصطناعية ذ.م.م"); await expect(sheet).toContainText("billing@example.test");
  await expect(sheet.getByRole("columnheader")).toHaveText([v.colItem, v.colLicence, v.colLicenceNo, v.colPrice.replace("{currency}", "USD")]);
  await expect(page.getByTestId("invoice-line")).toHaveCount(2); await expect(page.getByTestId("invoice-line").first()).toContainText("PH-2026-7K3M9Q2XRT"); await expect(page.getByTestId("invoice-line").first()).toContainText("150.00");
  await expect(page.getByTestId("invoice-total")).toHaveText("300.00"); await expect(sheet).not.toContainText(/مجموع فرعي|never-display-canary/);
  await page.setViewportSize({ width: 1440, height: 900 }); await page.screenshot({ path: ".artifacts/s7-invoice-ar.png", fullPage: true });
  await page.emulateMedia({ media: "print" });
  await expect(page.getByRole("button", { name: v.print })).toBeHidden(); await expect(page.locator(".topbar")).toBeHidden(); await expect(sheet).toBeVisible();
  await page.emulateMedia({ media: "screen" });
  // طلب لمؤسسة أخرى: لا فاتورة، بسبب مكتوب
  await page.goto("/ar/store/orders/92000000-0000-4000-8000-000000000009/invoice"); await expect(page.getByRole("heading", { name: v.notFoundTitle })).toBeVisible();
});

for (const [width, height] of [[1280, 800], [375, 812]] as const) test(`the store works at ${width}px in Arabic and English without sideways scroll, with the primary action in reach`, async ({ page }) => {
  test.setTimeout(120000);
  await page.setViewportSize({ width, height });
  await login(page, "buyer"); await expect(page).toHaveURL(/\/ar\/store$/);
  for (const locale of ["ar", "en"] as const) {
    const m = locale === "ar" ? ar : en;
    for (const path of ["store", "store/71000000-0000-4000-8000-000000000001", "store/cart", "store/licenses", "store/orders", "store/orders/92000000-0000-4000-8000-000000000001/invoice"]) {
      await page.goto(`/${locale}/${path}`); await page.waitForLoadState("networkidle").catch(() => {});
      await expect(page.locator("html")).toHaveAttribute("dir", locale === "ar" ? "rtl" : "ltr");
      const [scroll, inner] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
      expect(scroll, `${locale}/${path}`).toBeLessThanOrEqual(inner);
    }
    await page.goto(`/${locale}/store/71000000-0000-4000-8000-000000000001`); await page.getByRole("radio").first().check();
    const add = page.getByRole("button", { name: m.store.browse.addFor.replace("{price}", "") }); await expect(add).toBeInViewport();
    expect((await add.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await page.goto(`/${locale}/store/licenses`); await expect(page.getByTestId("license-row")).toHaveCount(3);
    await page.goto(`/${locale}/store`); await page.screenshot({ path: `.artifacts/store-${width}-${locale}.png`, fullPage: true });
  }
});

test("licences: the certificate from the licence number; the public page shows number and status only, signed out", async ({ page, context }) => {
  await login(page, "buyer"); await expect(page).toHaveURL(/\/ar\/store$/);
  await page.goto("/ar/store/licenses");
  await page.getByTestId("license-row").filter({ hasText: "PH-2026-7K3M9Q2XRT" }).getByRole("link", { name: "PH-2026-7K3M9Q2XRT" }).click();
  await expect(page.getByTestId("certificate")).toContainText("ORD-2026-7K3M9Q2X"); await expect(page.getByTestId("license-status")).toHaveText(l.statuses.active);
  await page.goto("/ar/store/licenses/93000000-0000-4000-8000-000000000002");
  await expect(page.locator("main").getByRole("alert")).toContainText(l.reasons.refunded);
  await context.clearCookies();
  await page.goto("/en/verify/PH-2026-7K3M9Q2XRT");
  const verification = page.getByTestId("verification");
  await expect(page.getByTestId("verification-status")).toHaveText(en.licenses.statuses.active);
  await expect(verification).toContainText("PH-2026-7K3M9Q2XRT"); await expect(verification).not.toContainText(/canary|Synthetic|worldwide/i);
  const raw = await (await page.request.get("/api/bff/license-verifications/PH-2026-7K3M9Q2XRT")).json();
  expect(Object.keys(raw).sort()).toEqual(["license_number", "status", "valid_until"]);
  await expect(verification).toContainText(en.licenses.verify.noExpiry); await expect(verification).toContainText(en.licenses.verify.scope);
  // P3: الرقم المجهول يقول السبب المحتمل ويعيد الرقم كما كُتب؛ والرقم بغير صيغة العقد لا يُرسل ولا يُعاد.
  await page.goto("/ar/verify/PH-2026-0000000000"); await expect(page.locator("main").getByRole("heading", { level: 1 })).toHaveText(l.verify.notFound);
  await expect(page.getByTestId("verification")).toContainText(l.verify.notFoundBody); await expect(page.getByTestId("verification")).toContainText("PH-2026-0000000000");
  await page.goto("/ar/verify/not-a-number"); await expect(page.locator("main").getByRole("heading", { level: 1 })).toHaveText(l.verify.notFound);
  await expect(page.getByTestId("verification")).not.toContainText("not-a-number");
});

test("ADR 0035 buyer sees proof days and offer terms, with null proof and dated exclusivity", async ({ page }) => {
  await login(page, "buyer"); await expect(page).toHaveURL(/\/ar\/store$/); await page.goto("/ar/store/71000000-0000-4000-8000-000000000001");
  const card = page.getByRole("region", { name: b.authenticity });
  await expect(card).toContainText(b.verifiedOn.split("{date}")[0]); await expect(card).toContainText(b.approvedOn.split("{date}")[0]); await expect(card).not.toContainText(/\d{1,2}:\d{2}/);
  const terms = page.locator(".offer-terms").first(); await terms.locator("summary").click(); await expect(terms).toContainText("استخدام اصطناعي قبل الشراء"); await expect(terms).toContainText(ar.templates.worldwide);
  await page.goto("/ar/store/71000000-0000-4000-8000-000000000002");
  await expect(page.getByRole("region", { name: b.authenticity })).not.toContainText(b.verifiedOn.split("{date}")[0]);
  await expect(page.locator(".license-picker")).toContainText(s.exclusiveUntil.split("{date}")[0]);
  await expect(page.locator("main")).not.toContainText(/work_name|actor_name|sha256|never-display-canary/);
  await page.route("**/api/bff/catalog/71000000-0000-4000-8000-000000000002", async route => { const response = await route.fetch(), data = await response.json(); data.exclusive_unavailable_until = null; await route.fulfill({ response, json: data }); });
  await page.reload(); await expect(page.getByText(s.exclusiveTaken, { exact: true })).toBeVisible();
});

test("ADR 0035 license exposes delivery specifications and size only when supplied", async ({ page }) => {
  await login(page, "buyer"); await expect(page).toHaveURL(/\/ar\/store$/); await page.goto("/ar/store/licenses/93000000-0000-4000-8000-000000000001");
  await expect(page.getByTestId("delivery-contents")).toContainText("video/mp4"); await expect(page.getByTestId("delivery-contents")).toContainText("1920×1080"); await expect(page.getByTestId("delivery-size")).toBeVisible();
  let omitContents = true;
  await page.route("**/api/bff/licenses/93000000-0000-4000-8000-000000000001", async route => { const response = await route.fetch(), data = await response.json(); data.delivery_contents = omitContents ? undefined : []; data.delivery_size_bytes = null; await route.fulfill({ response, json: data }); });
  await page.reload(); await expect(page.getByTestId("certificate")).toBeVisible(); await expect(page.getByTestId("delivery-contents")).toHaveCount(0); await expect(page.getByTestId("delivery-size")).toHaveCount(0);
  omitContents = false; await page.reload(); await expect(page.getByTestId("certificate")).toBeVisible(); await expect(page.getByRole("heading", { name: l.deliveryContents, exact: true })).toHaveCount(0);
});
