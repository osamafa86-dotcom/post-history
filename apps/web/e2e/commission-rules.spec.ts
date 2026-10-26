import { expect, test, type Page } from "@playwright/test";
import ar from "../messages/ar.json" with { type: "json" };
import en from "../messages/en.json" with { type: "json" };
async function login(page: Page, role: string, locale: "ar" | "en" = "ar") {
  const m = locale === "ar" ? ar : en;
  await page.goto(`/${locale}/login`); await page.getByLabel(m.email).fill(`${role}@example.test`); await page.getByLabel(m.password, { exact: true }).fill("synthetic-password"); await page.getByLabel(m.totp, { exact: true }).fill("123456"); await page.getByRole("button", { name: m.signIn, exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/${locale}/inbox$`));
}
test.beforeEach(async ({ request }) => { await request.post("http://127.0.0.1:3201/__test/reset"); });

test("the system admin adds a scheduled version; earlier versions stay as history", async ({ page }) => {
  const c = en.commission; await login(page, "admin", "en"); await page.getByRole("link", { name: c.nav, exact: true }).click();
  const rows = page.getByTestId("commission-row"); await expect(rows).toHaveCount(3);
  await expect(rows.filter({ hasText: "30%" })).toContainText(c.current); await expect(rows.filter({ hasText: "35%" })).toContainText(c.superseded);
  await expect(page.locator("main")).not.toContainText("never-display-canary");
  await rows.filter({ hasText: "40%" }).getByRole("button", { name: c.newVersion }).click();
  await expect(page.getByLabel(c.licenseType)).toHaveValue("commercial"); await expect(page.getByLabel(c.target)).toHaveValue("aerial");
  await page.getByLabel(c.platformShare).fill("150"); await page.getByRole("button", { name: c.save }).click();
  await expect(page.getByRole("alert").filter({ hasText: c.invalid.replace("{max}", "100") })).toBeVisible();
  await page.getByLabel(c.platformShare).fill("42.5"); await page.getByLabel(c.effectiveFrom).fill("2099-01-01T00:00"); await page.getByRole("button", { name: c.save }).click();
  await expect(rows).toHaveCount(4); await expect(rows.first()).toContainText("42.5%"); await expect(rows.first()).toContainText(c.scheduled);
  await page.getByLabel(c.scope).selectOption("default"); await expect(rows).toHaveCount(2);
});

test("finance reads the rules without adding versions; others do not see the page", async ({ page, context }) => {
  const c = ar.commission; await login(page, "finance"); await page.getByRole("link", { name: c.nav, exact: true }).click();
  await expect(page.getByTestId("commission-row")).toHaveCount(3); await expect(page.getByText(c.readOnly)).toBeVisible();
  await expect(page.getByRole("button", { name: c.new })).toHaveCount(0); await expect(page.getByRole("button", { name: c.newVersion })).toHaveCount(0);
  await page.screenshot({ path: ".artifacts/commission-rules-ar.png", fullPage: true });
  await context.clearCookies(); await login(page, "reviewer"); await expect(page.getByRole("link", { name: c.nav })).toHaveCount(0);
  await page.goto("/ar/commission-rules"); await expect(page.getByText(c.denied)).toBeVisible();
});
