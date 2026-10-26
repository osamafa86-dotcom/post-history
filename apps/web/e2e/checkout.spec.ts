import { expect, test, type Page } from "@playwright/test";
import ar from "../messages/ar.json" with { type: "json" };
const s = ar.store, o = ar.orders;
async function login(page: Page, role: string) {
  await page.goto("/ar/login"); await page.getByLabel(ar.email).fill(`${role}@example.test`); await page.getByLabel(ar.password, { exact: true }).fill("synthetic-password"); await page.getByLabel(ar.totp, { exact: true }).fill("123456"); await page.getByRole("button", { name: ar.signIn, exact: true }).click();
}
test.beforeEach(async ({ request }) => { await request.post("http://127.0.0.1:3201/__test/reset"); });

test("a buyer adds a license to the cart, pays at the sandbox provider and sees the order paid", async ({ page }) => {
  await login(page, "buyer"); await expect(page).toHaveURL(/\/ar\/store$/);
  await page.goto("/ar/store/71000000-0000-4000-8000-000000000001");
  await expect(page.getByRole("button", { name: s.addToCart })).toBeDisabled();
  await page.getByRole("radio").first().check(); await page.getByRole("button", { name: s.addToCart }).click();
  await page.getByRole("link", { name: s.inCart }).click(); await expect(page).toHaveURL(/\/ar\/store\/cart$/);
  await expect(page.getByTestId("cart-line")).toHaveCount(1); await expect(page.getByTestId("cart-total")).toContainText("150");
  await page.getByRole("button", { name: o.place }).click();
  await expect(page).toHaveURL(/\/ar\/store\/orders\/[0-9a-f-]{36}$/); await expect(page.getByTestId("order-status")).toHaveText(o.statuses.pending_payment);
  await expect(page.getByText(o.sandbox)).toBeVisible();
  await page.getByRole("button", { name: o.pay }).click();
  await expect(page).toHaveURL(/127\.0\.0\.1:3201\/sandbox\/checkout\//); await page.getByRole("link", { name: "Pay (sandbox)" }).click();
  await expect(page).toHaveURL(/\/ar\/store\/orders\/[0-9a-f-]{36}\?returned=1$/);
  await expect(page.getByTestId("order-status")).toHaveText(o.statuses.paid, { timeout: 15000 }); await expect(page.getByText(o.paidHelp)).toBeVisible();
  await expect(page.locator("main")).not.toContainText("never-display-canary");
  await page.getByRole("navigation", { name: ar.workspace }).getByRole("link", { name: o.nav }).click(); await expect(page.getByTestId("cart-line")).toHaveCount(0);
  await page.goto("/ar/store/orders"); await expect(page.getByTestId("order-row")).toHaveCount(1); await expect(page.getByTestId("order-row")).toContainText(o.statuses.paid);
  await page.screenshot({ path: ".artifacts/orders-ar.png", fullPage: true });
});
test("a buyer cancels an unpaid order, and staff cannot buy", async ({ page, context }) => {
  await login(page, "buyeradmin"); await expect(page).toHaveURL(/\/ar\/store$/);
  await page.goto("/ar/store/71000000-0000-4000-8000-000000000002"); await page.getByRole("radio").first().check(); await page.getByRole("button", { name: s.addToCart }).click();
  await page.goto("/ar/store/cart"); await expect(page.getByTestId("cart-line")).toHaveCount(0); // السلة في الذاكرة؛ التنقل الكامل يبدأ سلة جديدة
  await page.goto("/ar/store/71000000-0000-4000-8000-000000000002"); await page.getByRole("radio").first().check(); await page.getByRole("button", { name: s.addToCart }).click();
  await page.getByRole("link", { name: s.inCart }).click(); await page.getByRole("button", { name: o.place }).click();
  await page.getByRole("button", { name: o.cancel }).click(); await expect(page.getByTestId("order-status")).toHaveText(o.statuses.cancelled);
  await expect(page.getByRole("button", { name: o.pay })).toHaveCount(0);
  await context.clearCookies(); await login(page, "reviewer"); await expect(page.getByTestId("material-row")).toHaveCount(50);
  await page.goto("/ar/store/71000000-0000-4000-8000-000000000001"); await expect(page.getByText(s.buyersOnly)).toBeVisible(); await expect(page.getByRole("button", { name: s.addToCart })).toHaveCount(0);
});
