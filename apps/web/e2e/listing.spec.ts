import { expect, test, type Page } from "@playwright/test";
import ar from "../messages/ar.json" with { type: "json" };
import en from "../messages/en.json" with { type: "json" };
const l = ar.listing, first = "20000000-0000-4000-8000-000000000001";
async function login(page: Page, role: string, locale: "ar" | "en" = "ar") {
  const m = locale === "ar" ? ar : en;
  await page.goto(`/${locale}/login`); await page.getByLabel(m.email).fill(`${role}@example.test`); await page.getByLabel(m.password, { exact: true }).fill("synthetic-password"); await page.getByLabel(m.totp, { exact: true }).fill("123456"); await page.getByRole("button", { name: m.signIn, exact: true }).click(); await expect(page.getByTestId("material-row")).toHaveCount(50);
}
async function rights(page: Page, to: string) {
  await page.getByRole("combobox", { name: ar.review.track, exact: true }).selectOption("rights"); await page.getByRole("combobox", { name: ar.review.target, exact: true }).selectOption(to);
  await page.getByLabel(ar.review.reason, { exact: true }).fill("rights reviewed"); await page.getByRole("button", { name: ar.review.apply, exact: true }).click();
  await expect(page.locator(".state-grid [data-track='rights_state']")).toHaveText(ar.states.rights_state[to as "sellable"]);
}
test.beforeEach(async ({ request }) => { await request.post("http://127.0.0.1:3201/__test/reset"); });

test("the rights officer drafts a listing, then lists it once the rights are sellable", async ({ page }) => {
  await login(page, "reviewer"); await page.goto(`/ar/materials/${first}`);
  const panel = page.getByRole("region", { name: l.title }); await expect(panel.getByText(l.none)).toBeVisible(); await expect(panel.getByText(l.notSellable)).toBeVisible();
  await panel.getByRole("button", { name: l.create }).click();
  await expect(panel.locator("option[value='listed']")).toHaveAttribute("disabled", "");
  const group = (legend: string) => panel.getByRole("group", { name: legend, exact: true });
  await group(l.listingTitle).getByLabel(ar.templates.english).fill("Synthetic footage");
  await group(l.description).getByLabel(ar.templates.arabic).fill("لقطات اصطناعية للاختبار"); await group(l.description).getByLabel(ar.templates.english).fill("Synthetic test footage");
  await panel.getByRole("button", { name: l.save }).click(); await expect(panel.getByRole("alert").filter({ hasText: l.invalid })).toBeVisible();
  await expect(panel.getByTestId("listing-offer")).toHaveCount(1);
  await panel.getByTestId("listing-offer").getByRole("checkbox").check(); await panel.getByLabel(l.priceOverride).fill("120");
  await expect(panel.getByLabel(l.commercialAllowed)).toBeDisabled();
  await panel.getByRole("button", { name: l.save }).click();
  await expect(panel.getByTestId("listing-summary")).toContainText(l.states.draft);
  await rights(page, "documented"); await rights(page, "sellable");
  await panel.getByRole("button", { name: l.edit }).click(); await panel.getByRole("combobox", { name: l.state }).selectOption("listed"); await panel.getByRole("button", { name: l.save }).click();
  await expect(panel.getByTestId("listing-summary")).toContainText(l.states.listed); await expect(panel.getByText(l.notSellable)).toHaveCount(0);
  await expect(page.locator("main")).not.toContainText("never-display-canary");
  await page.screenshot({ path: ".artifacts/listing-ar.png", fullPage: true });
});
test("the listing stays hidden from roles outside the contract and read-only for the editor in chief", async ({ page, context }) => {
  await login(page, "reporter"); await page.goto(`/ar/materials/${first}`);
  await expect(page.getByRole("heading", { name: ar.review.title, exact: true })).toBeVisible(); await expect(page.getByRole("region", { name: l.title })).toHaveCount(0);
  await context.clearCookies(); await login(page, "chief", "en"); await page.goto(`/en/materials/${first}`);
  const panel = page.getByRole("region", { name: en.listing.title }); await expect(panel.getByText(en.listing.none)).toBeVisible();
  await expect(panel.getByRole("button", { name: en.listing.create })).toHaveCount(0);
});
