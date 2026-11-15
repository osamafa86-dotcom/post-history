import { expect, test, type Page } from "@playwright/test";
import ar from "../messages/ar.json" with { type: "json" };
const s = ar.store, b = s.browse, c = s.cartPage, o = ar.orders;
const first = "71000000-0000-4000-8000-000000000001", second = "71000000-0000-4000-8000-000000000002";
async function login(page: Page, role = "buyer") {
  await page.goto("/ar/login"); await page.getByLabel(ar.email).fill(`${role}@example.test`); await page.getByLabel(ar.password, { exact: true }).fill("synthetic-password"); await page.getByLabel(ar.totp, { exact: true }).fill("123456"); await page.getByRole("button", { name: ar.signIn, exact: true }).click();
  await expect(page).toHaveURL(/\/ar\/store$/);
}
/** يعدّل ردّ الـBFF في الطريق كما لو تغيّرت البيانات على الخادم. طلب أُلغي بمغادرة الصفحة يُترك (ردّه لم يعد يُقرأ). */
const rewrite = <T,>(page: Page, url: string | RegExp, change: (data: T) => void) =>
  page.route(url, async route => { try { const response = await route.fetch(), data = await response.json() as T; change(data); await route.fulfill({ response, json: data }); } catch { /* غادرت الصفحة قبل الرد */ } });
type Listing = Record<string, unknown> & { offers: { type: string; name: { ar: string; en: string }; price: { amount_minor: number; currency: string } }[] };
const listing = (page: Page, id: string, change: (item: Listing) => void) => rewrite<Listing>(page, `**/api/bff/catalog/${id}`, change);
async function addFirstOffer(page: Page, id: string) {
  await page.goto(`/ar/store/${id}`); await page.getByRole("radio").first().check(); await page.getByTestId("add-to-cart").click(); await expect(page.getByTestId("go-to-cart")).toBeVisible();
}
/** طلب معلّق من السلة: يعيد معرّفه من رابط صفحة المزوّد. */
async function placeOrder(page: Page, id = first) {
  await addFirstOffer(page, id); await page.goto("/ar/store/cart"); await page.getByRole("button", { name: c.checkout }).click();
  await expect(page).toHaveURL(/127\.0\.0\.1:3201\/sandbox\/checkout\//);
  return page.url().split("/").pop()!;
}
const usd = (amount: number) => new Intl.NumberFormat("ar-u-nu-latn", { style: "currency", currency: "USD" }).format(amount);
const noOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
test.beforeEach(async ({ request }) => { await request.post("http://127.0.0.1:3201/__test/reset"); });

test("back from the provider without paying: the order says so and keeps pay and cancel; while waiting they stay too", async ({ page }) => {
  await login(page); const id = await placeOrder(page);
  await page.goto(`/ar/store/orders/${id}?returned=1&outcome=failed`);
  await expect(page.getByTestId("payment-failed")).toHaveText(o.paymentFailed); await expect(page.getByTestId("awaiting")).toHaveCount(0);
  await expect(page.getByTestId("order-status")).toHaveText(o.statuses.pending_payment);
  await expect(page.getByRole("button", { name: o.pay })).toBeEnabled(); await expect(page.getByRole("button", { name: o.cancel })).toBeEnabled();
  // عودة بلا نتيجة: الانتظار شريط فوق صفحة الطلب، والدفع والإلغاء باقيان تحته
  await page.goto(`/ar/store/orders/${id}?returned=1`);
  await expect(page.getByTestId("awaiting")).toContainText(o.awaiting); await expect(page.getByTestId("payment-failed")).toHaveCount(0);
  await expect(page.getByRole("button", { name: o.pay })).toBeEnabled(); await expect(page.getByRole("button", { name: o.cancel })).toBeEnabled();
  await page.getByRole("button", { name: o.cancel }).click(); await expect(page.getByTestId("order-status")).toHaveText(o.statuses.cancelled); await expect(page.getByTestId("awaiting")).toHaveCount(0);
});

test("an order whose time ran out reads as expired, in the order and in the list, with no pay or cancel", async ({ page }) => {
  await login(page); const id = await placeOrder(page);
  const past = (order: { id: string; expires_at: string }) => { if (order.id === id) order.expires_at = new Date(Date.now() - 60000).toISOString(); };
  await rewrite<{ id: string; expires_at: string }>(page, `**/api/bff/orders/${id}`, past);
  await rewrite<{ items: { id: string; expires_at: string }[] }>(page, /\/api\/bff\/orders(\?[^/]*)?$/, data => data.items.forEach(past));
  await page.goto(`/ar/store/orders/${id}`);
  await expect(page.getByTestId("order-status")).toHaveText(o.statuses.expired);
  await expect(page.getByRole("button", { name: o.pay })).toHaveCount(0); await expect(page.getByRole("button", { name: o.cancel })).toHaveCount(0); await expect(page.getByTestId("hold-timer")).toHaveCount(0);
  await expect(page.getByTestId("order-expired")).toContainText(o.expiredHelp);
  await expect(page.getByTestId("order-expired").getByRole("link", { name: o.orderAgain })).toHaveAttribute("href", "/ar/store");
  await page.goto("/ar/store/orders");
  await expect(page.getByTestId("order-row").first()).toContainText(o.statuses.expired); await expect(page.getByTestId("order-row").first()).not.toContainText(o.statuses.pending_payment);
  // وما أنهاه الخادم نفسه كذلك: «منتهٍ» وطريق طلب جديد
  await page.unroute(`**/api/bff/orders/${id}`); await rewrite<{ id: string; status: string }>(page, `**/api/bff/orders/${id}`, order => { order.status = "expired"; });
  await page.goto(`/ar/store/orders/${id}`); await expect(page.getByTestId("order-status")).toHaveText(o.statuses.expired); await expect(page.getByTestId("order-expired")).toContainText(o.expiredHelp);
  // السلة الفارغة لا تدلّ على طلب مضت مهلته
  await page.goto("/ar/store/cart"); await expect(page.getByText(c.emptyTitle)).toBeVisible(); await expect(page.getByTestId("pending-order")).toHaveCount(0);
});

test("the cart re-reads its items from the catalog: a changed price is named and paid, and what left the catalog stops the checkout until removed", async ({ page }) => {
  await login(page); await addFirstOffer(page, first);
  await listing(page, first, item => { item.offers[0].price.amount_minor = 19000; });
  await page.goto("/ar/store/cart");
  await expect(page.getByTestId("cart-change")).toHaveText(c.priceChanged.replace("{from}", usd(150)).replace("{to}", usd(190)));
  await expect(page.getByTestId("cart-total")).toContainText("190"); await expect(page.getByTestId("cart-changed")).toHaveText(c.changed);
  const created = page.waitForRequest(r => r.url().endsWith("/api/bff/orders") && r.method() === "POST");
  await page.getByRole("button", { name: c.checkout }).click();
  expect((await created).postDataJSON().expected_total).toEqual({ amount_minor: 19000, currency: "USD" });
  // الإدراج غادر الكتالوج: البند يبقى ظاهرًا بسببه، والدفع موقوف حتى يُزال
  await page.unroute(`**/api/bff/catalog/${first}`);
  await page.route(`**/api/bff/catalog/${first}`, route => route.fulfill({ status: 404, json: { code: "request_failed" } }));
  await page.reload();
  await expect(page.getByTestId("cart-line")).toHaveAttribute("data-blocked", "true"); await expect(page.getByTestId("cart-change")).toHaveText(c.gone);
  await expect(page.getByTestId("cart-blocked")).toHaveText(c.blocked); await expect(page.getByRole("button", { name: c.checkout })).toBeDisabled();
  await page.getByRole("button", { name: c.removeFor.replace("{title}", "لقطات اصطناعية 1") }).click();
  await expect(page.getByText(c.emptyTitle)).toBeVisible();
});

test("back from the provider page, the empty cart points to the order that awaits payment", async ({ page }) => {
  await login(page); const id = await placeOrder(page);
  await page.goBack(); await expect(page).toHaveURL(/\/ar\/store\/cart$/);
  const hint = page.getByTestId("pending-order");
  await expect(hint).toContainText(c.pendingOrder.split("{order}")[0]); await expect(hint).toContainText(/ORD-\d{4}-[0-9A-HJKMNP-TV-Z]{8}/);
  await hint.getByRole("link", { name: c.resumePayment }).click();
  await expect(page).toHaveURL(new RegExp(`/ar/store/orders/${id}$`)); await expect(page.getByRole("button", { name: o.pay })).toBeEnabled();
});

test("an item says what the organization holds on it, a second license replaces the cart's, and a second currency is refused with what to do", async ({ page }) => {
  await login(page); await page.goto(`/ar/store/${first}`);
  // ترخيص سارٍ للمؤسسة على هذه المادة بهذا النوع: يُسمّى برقمه على عرضه وحده
  await expect(page.getByTestId("owned-license")).toHaveCount(1); await expect(page.getByTestId("owned-license")).toContainText("PH-2026-7K3M9Q2XRT");
  await page.getByRole("radio").first().check(); await page.getByTestId("add-to-cart").click();
  await expect(page.getByTestId("add-to-cart")).toHaveText(b.inCart); await expect(page.getByTestId("add-to-cart")).toBeDisabled();
  await page.getByRole("radio", { name: /حصري 48 ساعة/ }).check();
  await expect(page.getByTestId("add-to-cart")).toHaveText(b.replaceInCart); await page.getByTestId("add-to-cart").click();
  await expect(page.getByRole("status").filter({ hasText: b.replaced })).toBeVisible(); await expect(page.getByTestId("cart-chip")).toHaveAccessibleName(s.nav.cartCount.replace("{n}", "1"));
  // بعد إعادة التحميل: ما في السلة هو المختار
  await page.reload(); await expect(page.getByRole("radio", { name: /حصري 48 ساعة/ })).toBeChecked(); await expect(page.getByTestId("add-to-cart")).toHaveText(b.inCart);
  // مادة أخرى مسعَّرة بعملة ثانية: لا تُضاف، والرسالة تقول ما العمل
  await listing(page, second, item => { item.exclusive_unavailable_until = null; item.offers[0].price.currency = "ILS"; });
  await page.goto(`/ar/store/${second}`); await page.getByRole("radio").first().check();
  await expect(page.getByTestId("currency-conflict")).toContainText(b.otherCurrency.replace("{have}", "USD").replace("{want}", "ILS"));
  await expect(page.getByTestId("add-to-cart")).toBeDisabled(); await expect(page.getByTestId("cart-chip")).toHaveAccessibleName(s.nav.cartCount.replace("{n}", "1"));
  await page.goto("/ar/store/cart"); await expect(page.getByTestId("cart-line")).toHaveCount(1); await expect(page.getByTestId("cart-line")).toContainText("حصري 48 ساعة");
});

test("a running exclusivity closes every offer and is written on the card; its holder is told it is theirs", async ({ page }) => {
  await login(page);
  await expect(page.getByTestId("catalog-card").filter({ hasText: "لقطات اصطناعية 2" }).getByTestId("card-held")).toContainText(s.card.heldUntil.split("{date}")[0]);
  await expect(page.getByTestId("catalog-card").filter({ hasText: "لقطات اصطناعية 1" }).getByTestId("card-held")).toHaveCount(0);
  await page.goto(`/ar/store/${second}`);
  await expect(page.getByTestId("exclusive-held")).toContainText(s.heldUntil.split("{date}")[0]);
  for (const radio of await page.getByRole("radio").all()) await expect(radio).toBeDisabled();
  await expect(page.getByTestId("add-to-cart")).toBeDisabled(); await expect(page.getByText(s.item.choose)).toHaveCount(0);
  // صاحب الحصرية: ترخيصه الحصري السارٍ على المادة نفسها
  await rewrite<{ items: Record<string, unknown>[] }>(page, /\/api\/bff\/licenses(\?[^/]*)?$/, data => {
    data.items.push({ ...data.items[0], id: "93000000-0000-4000-8000-0000000000aa", license_number: "PH-2026-EXCLVS1VE0", listing_id: second, license_template_id: "70000000-0000-4000-8000-000000000002", status: "active", valid_until: null, exclusive_until: new Date(Date.now() + 86400000).toISOString() });
  });
  await page.reload();
  await expect(page.getByTestId("exclusive-held")).toContainText(s.heldByYou.split("{date}")[0]);
  for (const radio of await page.getByRole("radio").all()) await expect(radio).toBeDisabled();
});

test("a search of spaces changes nothing, and the search stays in the address across a reload and the way back from an item", async ({ page }) => {
  await login(page); await expect(page.getByTestId("catalog-card")).toHaveCount(2);
  const field = page.getByLabel(s.search, { exact: true });
  await field.fill("   "); await page.getByRole("button", { name: b.searchButton, exact: true }).click();
  await expect(page.getByTestId("catalog-card")).toHaveCount(2); await expect(field).toHaveValue(""); await expect(page).toHaveURL(/\/ar\/store$/);
  await field.fill(" 1 "); await page.getByRole("button", { name: b.searchButton, exact: true }).click();
  await expect(page.getByTestId("catalog-card")).toHaveCount(1); await expect(page).toHaveURL(/\/ar\/store\?q=1$/);
  await page.reload(); await expect(page.getByTestId("catalog-card")).toHaveCount(1); await expect(page.getByLabel(s.search, { exact: true })).toHaveValue("1");
  await page.getByRole("link", { name: "لقطات اصطناعية 1" }).first().click(); await expect(page).toHaveURL(new RegExp(`/ar/store/${first}$`));
  await page.goBack(); await expect(page).toHaveURL(/\/ar\/store\?q=1$/);
  await expect(page.getByTestId("catalog-card")).toHaveCount(1); await expect(page.getByLabel(s.search, { exact: true })).toHaveValue("1");
  // رابط بحث يُفتح مباشرة، وما لا يُعرف من مفاتيحه يُهمل
  await page.goto("/ar/store?q=2&city=x&period=year"); await expect(page.getByTestId("catalog-card")).toHaveCount(1); await expect(page.getByTestId("catalog-card")).toContainText("لقطات اصطناعية 2");
  await page.getByLabel(s.search, { exact: true }).fill(""); await page.getByRole("button", { name: b.searchButton, exact: true }).click();
  await expect(page.getByTestId("catalog-card")).toHaveCount(2); await expect(page).toHaveURL(/\/ar\/store$/);
});

test("a very long title or license name does not widen the cart or the templates page, and the forms stop at a short name", async ({ page, context }) => {
  const long = "عنوان".repeat(100), name = "ترخيص".repeat(800);
  await login(page);
  await listing(page, first, item => { item.title = { ar: long, en: long }; item.offers[0].name = { ar: name, en: name }; });
  await addFirstOffer(page, first); await page.goto("/ar/store/cart");
  await expect(page.getByTestId("cart-line")).toHaveCount(1); expect(await noOverflow(page)).toBe(true);
  expect((await page.getByTestId("cart-line").locator("strong").first().boundingBox())!.height).toBeLessThanOrEqual(64);
  await page.setViewportSize({ width: 390, height: 844 }); expect(await noOverflow(page)).toBe(true);
  await page.setViewportSize({ width: 1280, height: 720 });
  await context.clearCookies(); await page.goto("/ar/login"); await page.getByLabel(ar.email).fill("reviewer@example.test"); await page.getByLabel(ar.password, { exact: true }).fill("synthetic-password"); await page.getByLabel(ar.totp, { exact: true }).fill("123456"); await page.getByRole("button", { name: ar.signIn, exact: true }).click();
  await expect(page.getByTestId("material-row")).toHaveCount(50);
  await rewrite<{ items: { name: object }[] }>(page, /\/api\/bff\/license-templates(\?[^/]*)?$/, data => { data.items[0].name = { ar: name, en: name }; });
  await page.getByRole("link", { name: ar.templates.nav, exact: true }).click();
  await expect(page.getByTestId("template-row")).toHaveCount(1); expect(await noOverflow(page)).toBe(true);
  await page.getByRole("button", { name: ar.templates.new, exact: true }).click();
  await expect(page.getByRole("group", { name: ar.templates.name, exact: true }).getByLabel(ar.templates.arabic)).toHaveAttribute("maxlength", "120");
  await expect(page.getByRole("group", { name: ar.templates.terms, exact: true }).getByLabel(ar.templates.arabic)).toHaveAttribute("maxlength", "4000");
});
