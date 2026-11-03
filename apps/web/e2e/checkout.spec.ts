import { expect, test, type Page } from "@playwright/test";
import ar from "../messages/ar.json" with { type: "json" };
import en from "../messages/en.json" with { type: "json" };
const s = ar.store, o = ar.orders, c = ar.store.cartPage;
async function login(page: Page, role: string) {
  await page.goto("/ar/login"); await page.getByLabel(ar.email).fill(`${role}@example.test`); await page.getByLabel(ar.password, { exact: true }).fill("synthetic-password"); await page.getByLabel(ar.totp, { exact: true }).fill("123456"); await page.getByRole("button", { name: ar.signIn, exact: true }).click();
}
test.beforeEach(async ({ request }) => { await request.post("http://127.0.0.1:3201/__test/reset"); });

test("a buyer adds a license to the cart, pays at the sandbox provider, sees the order paid and its invoice numbered at confirmation", async ({ page }) => {
  await login(page, "buyer"); await expect(page).toHaveURL(/\/ar\/store$/);
  await page.goto("/ar/store/71000000-0000-4000-8000-000000000001");
  await expect(page.getByRole("button", { name: s.addToCart })).toBeDisabled();
  await page.getByRole("radio").first().check(); await page.getByRole("button", { name: s.browse.addFor.replace("{price}", "") }).click();
  await page.getByRole("link", { name: s.inCart }).click(); await expect(page).toHaveURL(/\/ar\/store\/cart$/);
  await expect(page.getByTestId("cart-line")).toHaveCount(1); await expect(page.getByTestId("cart-total")).toContainText("150");
  await page.getByLabel(c.poLabel).fill("PO-77/A");
  await page.getByRole("button", { name: c.checkout }).click();
  await expect(page).toHaveURL(/127\.0\.0\.1:3201\/sandbox\/checkout\//); await page.getByRole("link", { name: "Pay (sandbox)" }).click();
  await expect(page).toHaveURL(/\/ar\/store\/orders\/[0-9a-f-]{36}\?returned=1$/);
  await expect(page.getByTestId("order-status")).toHaveText(o.statuses.paid, { timeout: 15000 }); await expect(page.getByText(o.paidHelp)).toBeVisible();
  await expect(page.locator("main")).not.toContainText("never-display-canary");
  await expect(page.getByTestId("cart-chip")).toHaveAccessibleName(s.nav.cartCount.replace("{n}", "0"));
  await page.getByRole("link", { name: o.invoice, exact: true }).click();
  await expect(page.getByTestId("invoice")).toContainText(/INV-\d{4}-0{3}\d{3}/); await expect(page.getByTestId("invoice-po")).toContainText("PO-77/A");
  await expect(page.getByTestId("invoice-sandbox")).toHaveText(s.invoice.sandbox); await expect(page.getByTestId("invoice-total")).toHaveText("150.00");
  await page.getByRole("banner").getByRole("navigation", { name: ar.workspace }).getByRole("link", { name: s.nav.orders }).click();
  await expect(page.getByTestId("order-row")).toHaveCount(2); await expect(page.getByTestId("order-row").first()).toContainText(o.statuses.paid);
  await expect(page.getByTestId("order-row").first()).toContainText(/ORD-\d{4}-[0-9A-HJKMNP-TV-Z]{8}/);
  await page.screenshot({ path: ".artifacts/orders-ar.png", fullPage: true });
});
test("checkout follows the buyer's language: the sandbox page and the return to the order are in English", async ({ page }) => {
  const e = en.store, eo = en.orders;
  await page.goto("/en/login"); await page.getByLabel(en.email).fill("buyer@example.test"); await page.getByLabel(en.password, { exact: true }).fill("synthetic-password"); await page.getByLabel(en.totp, { exact: true }).fill("123456"); await page.getByRole("button", { name: en.signIn, exact: true }).click();
  await expect(page).toHaveURL(/\/en\/store$/); await page.goto("/en/store/71000000-0000-4000-8000-000000000001");
  await page.getByRole("radio").first().check(); await page.getByRole("button", { name: e.browse.addFor.replace("{price}", "") }).click();
  await page.getByRole("link", { name: e.inCart }).click(); await expect(page).toHaveURL(/\/en\/store\/cart$/);
  const session = page.waitForRequest(r => /\/api\/bff\/orders\/[0-9a-f-]{36}\/checkout$/.test(r.url()));
  await page.getByRole("button", { name: e.cartPage.checkout }).click();
  expect((await session).postDataJSON()).toEqual({ locale: "en" });
  await expect(page).toHaveURL(/127\.0\.0\.1:3201\/sandbox\/checkout\//); await expect(page.locator("html")).toHaveAttribute("lang", "en"); await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
  await page.getByRole("link", { name: "Pay (sandbox)" }).click();
  await expect(page).toHaveURL(/\/en\/store\/orders\/[0-9a-f-]{36}\?returned=1$/);
  await expect(page.getByTestId("order-status")).toHaveText(eo.statuses.paid, { timeout: 15000 });
});

test("a buyer cancels an unpaid order, and staff cannot buy", async ({ page, context }) => {
  await login(page, "buyeradmin"); await expect(page).toHaveURL(/\/ar\/store$/);
  await page.goto("/ar/store/71000000-0000-4000-8000-000000000002"); await page.getByRole("radio").first().check(); await page.getByRole("button", { name: s.browse.addFor.replace("{price}", "") }).click();
  // السلة في هذا التبويب باسم صاحبها: التحميل الكامل للصفحة لا يفرغها (ADR 0119)
  await expect(page.getByTestId("cart-chip")).toHaveAccessibleName(s.nav.cartCount.replace("{n}", "1"));
  await page.goto("/ar/store/cart"); await expect(page.getByTestId("cart-line")).toHaveCount(1);
  await page.getByRole("button", { name: c.checkout }).click();
  await expect(page).toHaveURL(/127\.0\.0\.1:3201\/sandbox\/checkout\//);
  await page.goto(`/ar/store/orders/${page.url().split("/").pop()}`);
  await expect(page.getByTestId("order-status")).toHaveText(o.statuses.pending_payment); await expect(page.getByText(o.sandbox)).toBeVisible();
  await page.getByRole("button", { name: o.cancel }).click(); await expect(page.getByTestId("order-status")).toHaveText(o.statuses.cancelled);
  await expect(page.getByRole("button", { name: o.pay })).toHaveCount(0);
  await context.clearCookies(); await login(page, "reviewer"); await expect(page.getByTestId("material-row")).toHaveCount(50);
  await page.goto("/ar/store/71000000-0000-4000-8000-000000000001"); await expect(page.getByText(s.buyersOnly)).toBeVisible(); await expect(page.getByRole("button", { name: s.addToCart })).toHaveCount(0);
});
