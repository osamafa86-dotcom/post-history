import { expect, test, type Page } from "@playwright/test";
import ar from "../messages/ar.json" with { type: "json" };
import en from "../messages/en.json" with { type: "json" };
const first = "20000000-0000-4000-8000-000000000001";
async function login(page: Page, role: string, locale: "ar" | "en" = "ar") {
  const m = locale === "ar" ? ar : en;
  await page.goto(`/${locale}/login`); await page.getByLabel(m.email).fill(`${role}@example.test`); await page.getByLabel(m.password, { exact: true }).fill("synthetic-password"); await page.getByLabel(m.totp, { exact: true }).fill("123456"); await page.getByRole("button", { name: m.signIn, exact: true }).click(); await expect(page.getByTestId("material-row")).toHaveCount(50);
}
test.beforeEach(async ({ request }) => { await request.post("http://127.0.0.1:3201/__test/reset"); await request.post("http://127.0.0.1:3201/__test/request-changes"); });

test("the reporter sees their materials, what needs action and the supervisor's note", async ({ page }) => {
  await login(page, "reporter"); await page.getByRole("link", { name: ar.mine.nav, exact: true }).click();
  await expect(page.getByRole("heading", { name: ar.mine.title, exact: true })).toBeVisible();
  await expect(page.getByTestId("mine-row")).toHaveCount(100); await expect(page.getByText(ar.mine.firstPage)).toBeVisible();
  await expect(page.locator("[data-state='needs_changes'] strong")).toHaveText("1");
  const action = page.getByTestId("mine-action"); await expect(action).toHaveCount(2);
  await expect(action.first().getByTestId("supervisor-note")).toContainText("أعد اللقطة الافتتاحية بإضاءة أفضل");
  await expect(action.first().getByTestId("supervisor-note")).toContainText("00:42");
  await expect(page.getByText(ar.mine.uploadFailed)).toBeVisible();
  await expect(page.getByTestId("mine-row").filter({ hasText: "مكررة مع مادة سابقة" })).toHaveCount(1);
  await expect(page.locator("main")).not.toContainText("never-display-canary");
  await page.screenshot({ path: ".artifacts/my-materials-ar.png", fullPage: true });
  await action.first().getByRole("link").click(); await expect(page.locator(".history-list")).toContainText("أعد اللقطة الافتتاحية بإضاءة أفضل");
  await expect(page.locator(".history-list")).not.toContainText("never-display-canary");
});
test("the page reads in English and stays off the menu for staff, who never see the reason", async ({ page, context }) => {
  await login(page, "reporter", "en"); await page.goto("/en/my-materials");
  await expect(page.getByRole("heading", { name: en.mine.title, exact: true })).toBeVisible(); await expect(page.getByText(en.mine.action, { exact: true })).toBeVisible();
  await context.clearCookies(); await login(page, "reviewer");
  await expect(page.getByRole("link", { name: ar.mine.nav, exact: true })).toHaveCount(0);
  await page.goto(`/ar/materials/${first}`); await expect(page.locator(".history-list li")).toHaveCount(2);
  await expect(page.locator(".history-list")).not.toContainText("أعد اللقطة");
});
