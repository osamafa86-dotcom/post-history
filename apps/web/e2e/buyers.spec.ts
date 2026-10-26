import { expect, test, type Page } from "@playwright/test";
import ar from "../messages/ar.json" with { type: "json" };
import en from "../messages/en.json" with { type: "json" };
const b = ar.buyers, other = "90000000-0000-4000-8000-000000000002";
async function login(page: Page, role: string, locale: "ar" | "en" = "ar") {
  const m = locale === "ar" ? ar : en;
  await page.goto(`/${locale}/login`); await page.getByLabel(m.email).fill(`${role}@example.test`); await page.getByLabel(m.password, { exact: true }).fill("synthetic-password"); await page.getByLabel(m.totp, { exact: true }).fill("123456"); await page.getByRole("button", { name: m.signIn, exact: true }).click();
}
test.beforeEach(async ({ request }) => { await request.post("http://127.0.0.1:3201/__test/reset"); });

test("a buyer lands in the store, sees only the store and their organization, and never a staff page", async ({ page }) => {
  await login(page, "buyer"); await expect(page).toHaveURL(/\/ar\/store$/);
  const nav = page.getByRole("navigation", { name: ar.workspace });
  await expect(nav.getByRole("link", { name: ar.inbox })).toHaveCount(0); await expect(nav.getByRole("link", { name: ar.store.title })).toBeVisible();
  await page.goto("/ar/inbox"); await expect(page).toHaveURL(/\/ar\/store$/);
  await nav.getByRole("link", { name: b.myOrganization }).click();
  await expect(page.getByRole("heading", { name: "شبكة الأخبار" })).toBeVisible(); await expect(page.getByTestId("organization-status")).toHaveText(b.statuses.active);
  await expect(page.getByRole("button", { name: b.edit })).toHaveCount(0); await expect(page.getByRole("region", { name: b.members })).toHaveCount(0);
  const leak = await page.evaluate(async id => (await fetch(`/api/bff/buyer-organizations/${id}`, { headers: { "X-Requested-With": "post-history-web" } })).status, other);
  expect(leak).toBe(404);
});
test("the organization admin edits the profile and manages members within the seats", async ({ page }) => {
  await login(page, "buyeradmin"); await expect(page).toHaveURL(/\/ar\/store$/); await page.goto("/ar/organization");
  await page.getByRole("button", { name: b.edit }).click();
  await expect(page.getByLabel(b.seats)).toBeDisabled();
  await page.getByLabel(b.billingEmail).fill("accounts@example.test"); await page.getByRole("button", { name: b.save }).click();
  await expect(page.getByTestId("organization-profile")).toContainText("accounts@example.test");
  const members = page.getByRole("region", { name: b.members }); await expect(members.getByTestId("member-row")).toHaveCount(2);
  await members.getByLabel(b.inviteEmail).fill("desk@example.test"); await members.getByRole("button", { name: b.invite }).click();
  await expect(members.getByTestId("member-row")).toHaveCount(3); await expect(members.getByTestId("member-row").last()).toContainText(b.memberStatuses.invited);
  await expect(members.getByTestId("invite-token")).toHaveText("synthetic-invite-token-member-000000001"); await expect(members.getByRole("button", { name: /نسخ|copy/i })).toHaveCount(0);
  expect(await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }))).not.toContain("synthetic-invite-token");
  await members.getByRole("button", { name: b.done }).click(); await expect(members.getByTestId("invite-token")).toHaveCount(0);
  await page.reload(); await expect(members.getByTestId("member-row")).toHaveCount(3); await expect(page.getByTestId("invite-token")).toHaveCount(0);
  await expect(members.getByRole("button", { name: b.invite })).toBeDisabled(); await expect(members.getByText(b.seatsFull)).toBeVisible();
  await members.getByTestId("member-row").filter({ hasText: "buyeradmin@" }).getByRole("button", { name: b.suspend }).click();
  await expect(members.getByText(b.memberConflict)).toBeVisible();
  await members.getByTestId("member-row").filter({ hasText: "buyer@example" }).getByRole("button", { name: b.suspend }).click();
  await expect(members.getByTestId("member-row").filter({ hasText: "buyer@example" })).toContainText(b.memberStatuses.suspended);
  await expect(page.locator("main")).not.toContainText("never-display-canary");
  await page.screenshot({ path: ".artifacts/organization-ar.png", fullPage: true });
});
test("the system admin creates and activates an organization; finance reads only", async ({ page, context }) => {
  await login(page, "admin", "en"); await expect(page.getByTestId("material-row")).toHaveCount(50);
  const e = en.buyers; await page.getByRole("link", { name: e.nav }).click();
  await expect(page.getByTestId("organization-row")).toHaveCount(2);
  await page.getByRole("button", { name: e.new }).click();
  await page.getByLabel(e.legalName).fill("Synthetic Press LLC");
  const name = page.getByRole("group", { name: e.displayName }); await name.getByLabel(en.templates.arabic).fill("صحافة اصطناعية"); await name.getByLabel(en.templates.english).fill("Synthetic Press");
  await page.getByLabel(e.country).fill("jo"); await page.getByLabel(e.billingEmail).fill("billing@press.example.test");
  await page.getByRole("button", { name: e.create }).click(); await expect(page.getByRole("alert").filter({ hasText: e.invalid })).toBeVisible();
  await page.getByLabel(e.firstAdmin).fill("admin@press.example.test"); await page.getByRole("button", { name: e.create }).click();
  await expect(page.getByTestId("invite-token")).toHaveText("synthetic-invite-token-organization-0001"); await expect(page.getByText(e.tokenOnce)).toBeVisible();
  await page.getByRole("button", { name: e.done }).click();
  const row = page.getByTestId("organization-row").filter({ hasText: "Synthetic Press" }); await expect(row).toContainText(e.statuses.pending_verification);
  await expect(page.locator("main")).not.toContainText("never-display-canary");
  await row.getByRole("button", { name: e.open }).click(); await page.getByRole("button", { name: e.edit }).click();
  await page.getByLabel(e.status).selectOption("active"); await page.getByRole("button", { name: e.save }).click();
  await expect(page.getByTestId("organization-status")).toHaveText(e.statuses.active);
  await context.clearCookies(); await login(page, "finance"); await expect(page).toHaveURL(/\/ar\/inbox$/); await page.goto("/ar/buyer-organizations");
  await expect(page.getByText(b.readOnly)).toBeVisible(); await expect(page.getByRole("button", { name: b.new })).toHaveCount(0);
});
