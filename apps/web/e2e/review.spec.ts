import { expect, test, type Page } from "@playwright/test";
import ar from "../messages/ar.json" with { type: "json" };
import en from "../messages/en.json" with { type: "json" };
const first = "20000000-0000-4000-8000-000000000001", second = "20000000-0000-4000-8000-000000000002", target = "10000000-0000-4000-8000-000000000002";
async function login(page: Page, role = "reviewer", locale: "ar" | "en" = "ar") {
  const m = locale === "ar" ? ar : en;
  await page.goto(`/${locale}/login`); await page.getByLabel(m.email).fill(`${role}@example.test`); await page.getByLabel(m.password, { exact: true }).fill("synthetic-password"); await page.getByLabel(m.totp, { exact: true }).fill("123456"); await page.getByRole("button", { name: m.signIn, exact: true }).click(); await expect(page.getByTestId("material-row")).toHaveCount(50);
}
async function detail(page: Page, id = first, locale = "ar") { await page.goto(`/${locale}/materials/${id}`); await expect(page.getByRole("heading", { name: locale === "ar" ? ar.review.title : en.review.title, exact: true })).toBeVisible(); }
test.beforeEach(async ({ request }) => { await request.post("http://127.0.0.1:3201/__test/reset"); });

test("review changes one track and displays a safe state history", async ({ page }) => {
  await login(page); await detail(page);
  await page.getByRole("combobox", { name: ar.review.target, exact: true }).selectOption("acknowledged"); await page.getByLabel(ar.review.reason, { exact: true }).fill("synthetic review reason");
  await page.getByRole("button", { name: ar.review.apply, exact: true }).click();
  await expect(page.locator(".state-grid [data-track='editorial_state']")).toHaveText(ar.states.editorial_state.acknowledged);
  await expect(page.locator(".state-grid [data-track='technical_state']")).toHaveText(ar.states.technical_state.verified);
  await expect(page.locator(".state-grid [data-track='rights_state']")).toHaveText(ar.states.rights_state.unknown);
  await expect(page.locator(".history-list li")).toHaveCount(1); await expect(page.locator(".history-list")).not.toContainText("synthetic review reason");
  await page.getByRole("combobox", { name: ar.review.track, exact: true }).selectOption("rights"); await page.getByRole("combobox", { name: ar.review.target, exact: true }).selectOption("documented"); await page.getByLabel(ar.review.reason, { exact: true }).fill("rights checked"); await page.getByRole("button", { name: ar.review.apply, exact: true }).click();
  await expect(page.locator(".state-grid [data-track='rights_state']")).toHaveText(ar.states.rights_state.documented);
  await page.screenshot({ path: ".artifacts/review-ar.png", fullPage: true });
});
test("412 preserves the draft, blocks resubmission and requires explicit reload", async ({ page, request }) => {
  await login(page); await detail(page); await page.getByRole("combobox", { name: ar.review.target, exact: true }).selectOption("acknowledged"); await page.getByLabel(ar.review.reason, { exact: true }).fill("keep this draft");
  await request.post("http://127.0.0.1:3201/__test/bump"); await page.getByRole("button", { name: ar.review.apply, exact: true }).click();
  await expect(page.getByText(ar.review.changed, { exact: true })).toBeVisible(); await expect(page.getByLabel(ar.review.reason, { exact: true })).toHaveValue("keep this draft"); await expect(page.getByRole("button", { name: ar.review.apply, exact: true })).toBeDisabled();
  await page.getByRole("button", { name: ar.review.reload, exact: true }).click(); await expect(page.getByLabel(ar.review.reason, { exact: true })).toHaveValue("");
  await page.getByRole("combobox", { name: ar.review.target, exact: true }).selectOption("acknowledged"); await page.getByLabel(ar.review.reason, { exact: true }).fill("reviewed updated revision"); await page.getByRole("button", { name: ar.review.apply, exact: true }).click();
  await expect(page.locator(".state-grid [data-track='editorial_state']")).toHaveText(ar.states.editorial_state.acknowledged);
});
test("unknown write result retries the same key and duplicate clicks apply once", async ({ page, request }) => {
  await login(page); await detail(page); await page.getByRole("combobox", { name: ar.review.target, exact: true }).selectOption("acknowledged"); await page.getByLabel(ar.review.reason, { exact: true }).fill("idempotent review"); await request.post("http://127.0.0.1:3201/__test/drop-write");
  await page.getByRole("button", { name: ar.review.apply, exact: true }).evaluate((button: HTMLButtonElement) => { button.click(); button.click(); });
  await expect(page.getByText(ar.review.failed, { exact: true })).toBeVisible();
  await page.getByRole("button", { name: ar.review.apply, exact: true }).click(); await expect(page.locator(".state-grid [data-track='editorial_state']")).toHaveText(ar.states.editorial_state.acknowledged);
  const data = await (await request.get("http://127.0.0.1:3201/__test/state")).json(); expect(data.writes).toHaveLength(2); expect(data.writes[0].key).toBe(data.writes[1].key); expect(data.applied).toBe(1);
});
test("contributors require exact totals and reservation can be released", async ({ page }) => {
  await login(page); await detail(page, second);
  await page.getByRole("button", { name: ar.review.reserve, exact: true }).click(); await expect(page.getByText(ar.review.yourReservation, { exact: true })).toBeVisible();
  await page.getByRole("button", { name: ar.review.release, exact: true }).click(); await expect(page.getByText(ar.review.unreserved, { exact: true })).toBeVisible();
  await page.getByLabel(ar.review.share, { exact: true }).fill("33.33"); await expect(page.getByRole("button", { name: ar.review.saveContributors, exact: true })).toBeDisabled();
  await page.getByRole("button", { name: ar.review.add, exact: true }).click(); await page.getByLabel(ar.review.userId, { exact: true }).nth(1).fill(target); await page.getByLabel(ar.review.share, { exact: true }).nth(1).fill("66.67"); const saved = page.waitForResponse(r => r.url().endsWith("/contributors") && r.request().method() === "PUT"); await page.getByRole("button", { name: ar.review.saveContributors, exact: true }).click(); expect((await saved).status()).toBe(200);
  await expect(page.getByLabel(ar.review.userId, { exact: true })).toHaveCount(2); await expect(page.getByLabel(ar.review.share, { exact: true }).nth(1)).toHaveValue("66.67");
});
test("administrator grants independent permissions and suspends with enum-only payload", async ({ page, request }) => {
  await login(page, "admin", "en"); await page.getByRole("link", { name: en.admin.title, exact: true }).click(); await page.getByLabel(en.admin.target, { exact: true }).fill(target);
  for (const label of [en.admin.location, en.admin.source]) {
    await page.getByLabel(en.admin.reason, { exact: true }).fill("approved synthetic request"); await page.getByRole("article", { name: label }).getByRole("button", { name: en.admin.grant, exact: true }).click(); await page.getByRole("dialog").getByRole("button", { name: en.admin.confirm, exact: true }).click(); await expect(page.getByRole("dialog")).toHaveCount(0);
  }
  await page.getByRole("article", { name: en.admin.location }).getByRole("button", { name: en.admin.revoke, exact: true }).click(); await page.getByRole("dialog").getByRole("button", { name: en.admin.confirm, exact: true }).click(); await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: en.admin.suspend, exact: true }).click(); await expect(page.getByRole("dialog")).toContainText(en.admin.suspendWarning); await page.getByRole("dialog").getByRole("button", { name: en.admin.confirm, exact: true }).click(); await expect(page.getByRole("dialog")).toHaveCount(0);
  const data = await (await request.get("http://127.0.0.1:3201/__test/state")).json(); expect(data.writes.map((r: { path: string }) => r.path.split("/").at(-1))).toEqual(["sensitive_location:read", "protected_source:read", "sensitive_location:read", "status"]); expect(data.writes[3].body).toEqual({ status: "suspended" });
  await page.screenshot({ path: ".artifacts/admin-en.png", fullPage: true });
});
test("fresh BFF roles block an administrator whose role was revoked while the page was open", async ({ page, request }) => {
  await login(page, "admin"); await page.getByRole("link", { name: ar.admin.title, exact: true }).click(); await page.getByLabel(ar.admin.target, { exact: true }).fill(target); await page.getByRole("button", { name: ar.admin.suspend, exact: true }).click(); await request.post("http://127.0.0.1:3201/__test/revoke-role"); await page.getByRole("dialog").getByRole("button", { name: ar.admin.confirm, exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText(ar.review.forbidden); expect((await (await request.get("http://127.0.0.1:3201/__test/state")).json()).writes).toHaveLength(0);
});
test("sensitive reading permissions do not reveal administration or allow direct-page access", async ({ page }) => {
  await login(page, "permissions"); await expect(page.getByRole("link", { name: ar.admin.title, exact: true })).toHaveCount(0); await page.goto("/ar/admin"); await expect(page.getByText(ar.admin.denied, { exact: true })).toBeVisible(); await expect(page.getByLabel(ar.admin.target, { exact: true })).toHaveCount(0);
});
test("notification read and acknowledgment update counts without exposing raw text", async ({ page }) => {
  await login(page); await page.getByRole("link", { name: ar.notice.title, exact: true }).click(); await expect(page.getByTestId("notification")).toHaveCount(3); await expect(page.locator("body")).not.toContainText("never-display-canary");
  const payload = await page.request.get("/api/bff/notifications"); expect(await payload.text()).not.toContain("never-display-canary");
  await page.getByTestId("notification").first().getByRole("button", { name: ar.notice.read, exact: true }).click(); await expect(page.getByTestId("notification").first()).toContainText(ar.notice.readState);
  await page.getByTestId("notification").first().getByRole("button", { name: ar.notice.ack, exact: true }).click(); await expect(page.getByTestId("notification").first()).toContainText(ar.notice.acknowledged);
  await page.getByLabel(ar.notice.unread, { exact: true }).check(); await expect(page.getByTestId("notification")).toHaveCount(2); await page.screenshot({ path: ".artifacts/notifications-ar.png", fullPage: true });
});
test("reporter can retry the technical track on their own failed material", async ({ page }) => {
  await login(page, "reporter"); await detail(page, "20000000-0000-4000-8000-000000000003"); await page.getByRole("combobox", { name: ar.review.target, exact: true }).selectOption("pending"); await page.getByLabel(ar.review.reason, { exact: true }).fill("retry receipt"); await page.getByRole("button", { name: ar.review.apply, exact: true }).click(); await expect(page.locator(".state-grid [data-track='technical_state']")).toHaveText(ar.states.technical_state.pending); await expect(page.locator(".state-grid [data-track='editorial_state']")).toHaveText(ar.states.editorial_state.inbox);
});
