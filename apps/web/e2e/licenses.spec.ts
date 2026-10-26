import { expect, test, type Page } from "@playwright/test";
import ar from "../messages/ar.json" with { type: "json" };
const l = ar.licenses;
async function login(page: Page, role: string) {
  await page.goto("/ar/login"); await page.getByLabel(ar.email).fill(`${role}@example.test`); await page.getByLabel(ar.password, { exact: true }).fill("synthetic-password"); await page.getByLabel(ar.totp, { exact: true }).fill("123456"); await page.getByRole("button", { name: ar.signIn, exact: true }).click();
}
test.beforeEach(async ({ request }) => { await request.post("http://127.0.0.1:3201/__test/reset"); });

test("a buyer reads the license certificate and downloads the counted delivery package", async ({ page }) => {
  await login(page, "buyer"); await expect(page).toHaveURL(/\/ar\/store$/);
  await page.getByRole("navigation", { name: ar.workspace }).getByRole("link", { name: l.nav }).click();
  await expect(page.getByTestId("license-row")).toHaveCount(2);
  await page.getByTestId("license-row").filter({ hasText: "PH-2026-7K3M9Q2XRT" }).getByRole("link", { name: l.open }).click();
  const certificate = page.getByTestId("certificate");
  await expect(certificate).toContainText("PH-2026-7K3M9Q2XRT"); await expect(certificate).toContainText(ar.templates.usageNames.tv); await expect(certificate).toContainText(l.noExpiry);
  await expect(page.locator("main")).not.toContainText("never-display-canary");
  const download = page.waitForEvent("download"); await page.getByRole("button", { name: l.download }).click();
  expect((await download).suggestedFilename()).toMatch(/^delivery-.*\.zip$/);
  await expect(page.getByTestId("downloads-remaining")).toContainText("2");
  await page.screenshot({ path: ".artifacts/license-ar.png", fullPage: true });
  await page.goto("/ar/store/licenses/93000000-0000-4000-8000-000000000002");
  await expect(page.getByTestId("license-status")).toHaveText(l.statuses.revoked); await expect(page.getByRole("button", { name: l.download })).toBeDisabled();
});
test("the rights officer reads licenses without downloading", async ({ page }) => {
  await login(page, "reviewer"); await expect(page.getByTestId("material-row")).toHaveCount(50);
  await page.goto("/ar/store/licenses/93000000-0000-4000-8000-000000000001");
  await expect(page.getByTestId("certificate")).toBeVisible(); await expect(page.getByRole("button", { name: l.download })).toHaveCount(0);
});
