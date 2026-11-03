import { expect, test, type Page } from "@playwright/test";
import ar from "../messages/ar.json" with { type: "json" };
import en from "../messages/en.json" with { type: "json" };

type Locale = "ar" | "en";
const dict = { ar, en }, api = "http://127.0.0.1:3201";
const material = (n: number) => `20000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
/** يدخل ويترك الهبوط لدور الحساب (لا يفترض الوارد). */
async function login(page: Page, who: string, locale: Locale = "ar") {
  const m = dict[locale];
  await page.goto(`/${locale}/login`);
  await page.getByLabel(m.email).fill(`${who}@example.test`); await page.getByLabel(m.password, { exact: true }).fill("synthetic-password"); await page.getByLabel(m.totp, { exact: true }).fill("123456");
  await page.getByRole("button", { name: m.signIn, exact: true }).click();
  await expect(page.getByRole("banner")).toBeVisible();
}
/** يغادر الصفحة قبل محو الكوكي، كي لا يسبق تحويلُ «الجلسة أُبطلت» الدخولَ التالي. */
async function switchUser(page: Page) { await page.goto("about:blank"); await page.context().clearCookies(); }
test.beforeEach(async ({ request }) => { await request.post(`${api}/__test/reset`); });

test("finance lands on payouts, has no inbox in the bar, and a direct inbox link says why instead of a stuck skeleton", async ({ page }) => {
  await login(page, "finance"); await expect(page).toHaveURL(/\/ar\/payouts$/);
  await expect(page.getByRole("heading", { level: 1, name: ar.money.title })).toBeVisible();
  const nav = page.getByRole("navigation", { name: ar.workspace });
  await expect(nav.getByRole("link", { name: ar.inbox, exact: true })).toHaveCount(0); await expect(nav.getByRole("link", { name: ar.payouts.nav, exact: true })).toBeVisible();
  await page.goto("/ar/inbox");
  const state = page.getByTestId("no-access"); await expect(state).toBeVisible();
  await expect(state.getByRole("alert")).toHaveText(ar.shell.inbox.denied); await expect(page.getByTestId("inbox-skeleton")).toHaveCount(0); await expect(page.getByText(ar.error)).toHaveCount(0);
  await state.getByRole("link", { name: ar.shell.noAccess.backPayouts }).click(); await expect(page).toHaveURL(/\/ar\/payouts$/);
  // البقية كما كانت: المراسل والطاقم في الوارد، والمشتري في المتجر
  await switchUser(page); await login(page, "reviewer", "en"); await expect(page).toHaveURL(/\/en\/inbox$/);
  await switchUser(page); await login(page, "buyer"); await expect(page).toHaveURL(/\/ar\/store$/);
});

test("the staff preview never plays the phone's light copy: the poster and «being prepared» instead", async ({ page }) => {
  await login(page, "reviewer");
  await page.goto(`/ar/materials/${material(1)}`); await expect(page.locator(".preview-panel video")).toHaveCount(1);
  await page.goto(`/ar/materials/${material(30)}`);
  const preview = page.getByRole("region", { name: ar.preview, exact: true });
  await expect(preview.getByTestId("preview-preparing")).toContainText(ar.previewPreparing); await expect(preview.locator("video")).toHaveCount(0);
  await expect(preview.getByRole("img", { name: ar.thumbnail })).toHaveCount(1);
  await page.goto(`/ar/materials/${material(31)}`);
  await expect(page.getByTestId("preview-preparing")).toContainText(ar.previewPreparing); await expect(page.locator(".preview-panel video, .preview-panel img")).toHaveCount(0);
  // ولا يبثّها الـBFF وإن طُلبت مباشرة
  expect((await page.request.get(`/api/bff/materials/${material(30)}/files/31000000-0000-4000-8000-000000000030/content`)).status()).toBe(404);
});

test("material pages log no console error for a missing listing or renders that are off", async ({ page }) => {
  const errors: string[] = []; page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
  // رئيس التحرير يقرأ الإدراج ويطلب النسخ: المادة بلا إدراج، والنسخ مطفأة في الخادم الاصطناعي
  await login(page, "chief");
  const listing = page.waitForResponse(r => r.url().endsWith(`/materials/${material(3)}/listing`)), renders = page.waitForResponse(r => r.url().endsWith(`/materials/${material(3)}/renders`));
  await page.goto(`/ar/materials/${material(3)}`); await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  expect((await listing).status()).toBe(204); expect((await renders).status()).toBe(204);
  await page.waitForLoadState("networkidle");
  expect(errors.filter(text => /404|Failed to load resource/.test(text))).toEqual([]);
});

test("the trial notice stands on every store page and on commission rules, in the cart's words", async ({ page }) => {
  await login(page, "buyer");
  for (const path of ["/ar/store", "/ar/store/71000000-0000-4000-8000-000000000001", "/ar/store/licenses", "/ar/store/licenses/93000000-0000-4000-8000-000000000001", "/ar/store/orders", "/ar/store/orders/92000000-0000-4000-8000-000000000001"]) {
    await page.goto(path); await expect(page.getByTestId("trial-notice"), path).toHaveText(ar.store.cartPage.sandbox);
  }
  await switchUser(page); await login(page, "finance", "en"); await page.goto("/en/commission-rules");
  await expect(page.getByTestId("commission-row").first()).toBeVisible(); await expect(page.getByTestId("trial-notice")).toHaveText(en.store.cartPage.sandbox);
});

test("the invoice and refund tables are named regions the keyboard reaches at 375", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 }); await login(page, "finance");
  await page.goto("/ar/store/orders/92000000-0000-4000-8000-000000000009");
  const panel = page.getByRole("region", { name: ar.refunds.title }); await panel.getByLabel(/لقطات اصطناعية 2/).check();
  await panel.getByLabel(ar.refunds.reason).selectOption("duplicate"); await panel.getByRole("button", { name: ar.refunds.submit }).click();
  const refunds = page.getByRole("region", { name: ar.refunds.historyLabel, exact: true }); await expect(refunds).toHaveAttribute("tabindex", "0");
  await refunds.focus(); await expect(refunds).toBeFocused();
  await page.goto("/ar/store/orders/92000000-0000-4000-8000-000000000009/invoice");
  const lines = page.getByRole("region", { name: ar.store.invoice.linesLabel, exact: true }); await expect(lines).toHaveAttribute("tabindex", "0");
  await lines.focus(); await expect(lines).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("switching language keeps the cart", async ({ page }) => {
  await login(page, "buyer"); await page.goto("/ar/store/71000000-0000-4000-8000-000000000001");
  await page.getByRole("radio").first().check(); await page.getByRole("button", { name: ar.store.browse.addFor.replace("{price}", "") }).click();
  await expect(page.getByTestId("cart-chip")).toHaveAccessibleName(ar.store.nav.cartCount.replace("{n}", "1"));
  await page.getByRole("button", { name: new RegExp(ar.shell.account) }).click(); await page.getByRole("link", { name: ar.language }).click();
  await expect(page).toHaveURL(/\/en\/store\/71000000/); await expect(page.getByTestId("cart-chip")).toHaveAccessibleName(en.store.nav.cartCount.replace("{n}", "1"));
  await page.getByTestId("cart-chip").click(); await expect(page.getByTestId("cart-line")).toHaveCount(1);
  // الخروج يمحوها من التبويب
  await page.getByRole("button", { name: new RegExp(en.shell.account) }).click(); await page.getByRole("button", { name: en.logout, exact: true }).click();
  await expect(page).toHaveURL(/\/en\/login/); expect(await page.evaluate(() => Object.keys(sessionStorage))).toEqual([]);
});

test("with the API down the page keeps its shell and says it is offline (E3)", async ({ page }) => {
  await login(page, "reviewer");
  // انقطاع بعد أن عُرف الحساب: الشريط باقٍ بما يملكه، والعنوان عنوان الصفحة
  await page.route("**/api/bff/auth/me", route => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ code: "temporarily_unavailable" }) }));
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  const shell = page.getByTestId("offline-shell"); await expect(shell).toBeVisible();
  await expect(shell.getByRole("heading", { level: 1 })).toHaveText(ar.inbox); await expect(shell.getByTestId("offline-state")).toContainText(ar.shell.offline.title);
  await expect(shell.getByRole("navigation", { name: ar.workspace }).getByRole("link", { name: ar.inbox, exact: true })).toBeVisible();
  await expect(shell.getByRole("button", { name: ar.logout })).toBeVisible(); await expect(page.getByText(ar.error)).toHaveCount(0);
  // تحميل كامل والخادم منقطع: الهيكل بلا شريط (لا حساب معروف)، والخروج واللغة وحالة الانقطاع
  await page.reload(); await expect(shell).toBeVisible(); await expect(shell.getByRole("heading", { level: 1 })).toHaveText(ar.product);
  await expect(shell.getByRole("link", { name: ar.language })).toBeVisible(); await expect(shell.getByRole("button", { name: ar.logout })).toBeVisible();
  await page.unroute("**/api/bff/auth/me"); await shell.getByRole("button", { name: ar.shell.offline.retry }).click();
  await expect(page.getByTestId("offline-shell")).toHaveCount(0); await expect(page.getByTestId("material-row")).toHaveCount(50);
});
