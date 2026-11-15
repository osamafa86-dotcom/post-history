import { expect, test, type Page } from "@playwright/test";
import ar from "../messages/ar.json" with { type: "json" };
const l = ar.listing, c = l.conditions, r = ar.refusals, first = "20000000-0000-4000-8000-000000000001";
const enabled = "81000000-0000-4000-8000-000000000001", disabled = "81000000-0000-4000-8000-000000000002";
async function login(page: Page, role: string) {
  await page.goto("/ar/login"); await page.getByLabel(ar.email).fill(`${role}@example.test`); await page.getByLabel(ar.password, { exact: true }).fill("synthetic-password"); await page.getByLabel(ar.totp, { exact: true }).fill("123456"); await page.getByRole("button", { name: ar.signIn, exact: true }).click();
}
test.beforeEach(async ({ request }) => { await request.post("http://127.0.0.1:3201/__test/reset"); });

test("the listing panel shows the four conditions before any attempt, and a refused save names the conditions that failed", async ({ page }) => {
  await login(page, "reviewer"); await expect(page.getByTestId("material-row")).toHaveCount(50); await page.goto(`/ar/materials/${first}`);
  const panel = page.getByRole("region", { name: l.title }), conditions = panel.getByTestId("listing-conditions");
  for (const name of [c.rights_state, c.editorial_state, c.technical_state, c.sensitivity]) await expect(conditions).toContainText(name);
  await expect(conditions.locator("li")).toHaveCount(4);
  await expect(conditions.locator("li").filter({ hasText: c.rights_state })).toHaveAttribute("data-met", "false");
  await panel.getByRole("button", { name: l.create }).click();
  const group = (legend: string) => panel.getByRole("group", { name: legend, exact: true });
  await group(l.listingTitle).getByLabel(ar.templates.english).fill("Synthetic footage");
  await group(l.description).getByLabel(ar.templates.arabic).fill("وصف"); await group(l.description).getByLabel(ar.templates.english).fill("Description");
  await panel.getByTestId("listing-offer").getByRole("checkbox").check();
  // الخادم يرفض بما فشل: الرسالة تسمّي الشرطين، لا الرسالة العامة
  await page.route(`**/api/bff/materials/${first}/listing`, route => route.request().method() === "GET" ? route.fallback() : route.fulfill({ status: 409, json: { code: "listing_conditions_unmet", details: { failed: ["editorial_state", "technical_state"] } } }));
  await panel.getByRole("button", { name: l.save }).click();
  const alert = panel.locator("[data-refusal='listing_conditions_unmet']");
  await expect(alert).toContainText(r.listing_conditions_unmet.split("{conditions}")[0]); await expect(alert).toContainText(c.editorial_state); await expect(alert).toContainText(c.technical_state);
  await expect(panel).not.toContainText(ar.review.conflict);
});

test("opening a listing that offers a disabled template drops that offer and says so, and the save carries the others alone", async ({ page }) => {
  await login(page, "reviewer"); await expect(page.getByTestId("material-row")).toHaveCount(50);
  const created = await page.evaluate(async ([id, offers]) => (await fetch(`/api/bff/materials/${id}/listing`, { method: "POST", headers: { "Content-Type": "application/json", "X-Requested-With": "post-history-web", "Idempotency-Key": crypto.randomUUID() },
    body: JSON.stringify({ title: { ar: "عنوان", en: "Title" }, description: { ar: "وصف", en: "Description" }, state: "draft", offers }) })).status, [first, [{ license_template_id: enabled, price_override: null }, { license_template_id: disabled, price_override: null }]] as const);
  expect(created).toBe(201);
  await page.goto(`/ar/materials/${first}`);
  const panel = page.getByRole("region", { name: l.title });
  await panel.getByRole("button", { name: l.edit }).click();
  await expect(panel.getByTestId("dropped-offers")).toHaveText(l.droppedOffers.replace("{n}", "1"));
  await expect(panel.getByTestId("listing-offer").getByRole("checkbox")).toBeChecked();
  const saved = page.waitForRequest(req => req.url().endsWith(`/api/bff/materials/${first}/listing`) && req.method() === "PUT");
  await panel.getByRole("button", { name: l.save }).click();
  expect((await saved).postDataJSON().offers).toEqual([{ license_template_id: enabled, price_override: null }]);
  await expect(panel.getByTestId("listing-summary")).toBeVisible(); await expect(panel.getByTestId("dropped-offers")).toHaveCount(0);
});

test("the cart says why the order was refused, and a new template does not offer the produced cut", async ({ page, context }) => {
  await login(page, "buyer"); await expect(page).toHaveURL(/\/ar\/store$/);
  await page.goto("/ar/store/71000000-0000-4000-8000-000000000001"); await page.getByRole("radio").first().check(); await page.getByTestId("add-to-cart").click();
  await page.goto("/ar/store/cart");
  await page.route("**/api/bff/orders", route => route.request().method() === "POST" ? route.fulfill({ status: 409, json: { code: "exclusive_unavailable" } }) : route.fallback());
  await page.getByRole("button", { name: ar.store.cartPage.checkout }).click();
  await expect(page.locator("[data-refusal='exclusive_unavailable']")).toHaveText(r.exclusive_unavailable); await expect(page.getByText(ar.orders.conflict)).toHaveCount(0);
  await context.clearCookies(); await login(page, "reviewer"); await expect(page.getByTestId("material-row")).toHaveCount(50);
  await page.getByRole("link", { name: ar.templates.nav, exact: true }).click(); await page.getByRole("button", { name: ar.templates.new, exact: true }).click();
  const offered = page.getByRole("group", { name: ar.templates.deliverables, exact: true }).getByRole("checkbox");
  await expect(offered).toHaveCount(3); await expect(page.getByLabel(ar.templates.deliverableNames.produced, { exact: true })).toHaveCount(0);
  await expect(page.getByLabel(ar.templates.deliverableNames.original, { exact: true })).toBeChecked();
});
