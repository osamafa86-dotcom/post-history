import { expect, test, type Page } from "@playwright/test";
import ar from "../messages/ar.json" with { type: "json" };
import en from "../messages/en.json" with { type: "json" };
async function login(page: Page, role: string, locale: "ar" | "en" = "ar") {
  const m = locale === "ar" ? ar : en;
  await page.goto(`/${locale}/login`); await page.getByLabel(m.email).fill(`${role}@example.test`); await page.getByLabel(m.password, { exact: true }).fill("synthetic-password"); await page.getByLabel(m.totp, { exact: true }).fill("123456"); await page.getByRole("button", { name: m.signIn, exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/${locale}/inbox$`));
}
test.beforeEach(async ({ request }) => { await request.post("http://127.0.0.1:3201/__test/reset"); });

test("the system admin dismisses a pending conflict with a present code; a wrong code keeps the session", async ({ page }) => {
  const c = en.conflicts; await login(page, "admin", "en"); await page.getByRole("link", { name: c.nav, exact: true }).click();
  const rows = page.getByTestId("conflict-row"); await expect(rows).toHaveCount(1); await expect(rows).toContainText("existing.reporter@example.test");
  await expect(page.locator("main")).not.toContainText("never-display-canary");
  await rows.getByRole("button", { name: c.actions.dismissed }).click();
  const dialog = page.getByRole("dialog", { name: c.actions.dismissed }); await expect(dialog).toContainText(c.effects.dismissed);
  await expect(dialog.getByRole("button", { name: en.confirm })).toBeDisabled();
  await dialog.getByLabel(en.totp).fill("000000"); await dialog.getByRole("button", { name: en.confirm }).click();
  await expect(dialog.getByText(c.totpRejected)).toBeVisible(); await expect(dialog.getByLabel(en.totp)).toHaveValue("");
  await dialog.getByLabel(en.totp).fill("123456"); await dialog.getByRole("button", { name: en.confirm }).click();
  await expect(dialog).toHaveCount(0); await expect(page.getByText(c.empty)).toBeVisible();
  await page.getByLabel(c.state).selectOption("suspended"); await expect(rows).toHaveCount(1);
  await expect(rows.getByRole("button", { name: c.actions.suspended })).toHaveCount(0); await expect(rows.getByRole("button", { name: c.actions.dismissed })).toBeVisible();
  await page.getByLabel(c.state).selectOption(""); await expect(rows).toHaveCount(2); await expect(rows.filter({ hasText: "existing.reporter" })).toContainText(c.states.dismissed);
  await page.screenshot({ path: ".artifacts/invite-conflicts-en.png", fullPage: true });
});

test("other roles neither see the link nor the queue", async ({ page }) => {
  await login(page, "finance"); await expect(page.getByRole("link", { name: ar.conflicts.nav })).toHaveCount(0);
  await page.goto("/ar/invite-conflicts"); await expect(page.getByText(ar.conflicts.denied)).toBeVisible();
});
