import { expect, test, type Page } from "@playwright/test";
import ar from "../messages/ar.json" with { type: "json" };
import en from "../messages/en.json" with { type: "json" };
const first = "20000000-0000-4000-8000-000000000001", second = "20000000-0000-4000-8000-000000000002", target = "10000000-0000-4000-8000-000000000002";
async function login(page: Page, role = "reviewer", locale: "ar" | "en" = "ar") {
  const m = locale === "ar" ? ar : en;
  await page.goto(`/${locale}/login`); await page.getByLabel(m.email).fill(`${role}@example.test`); await page.getByLabel(m.password, { exact: true }).fill("synthetic-password"); await page.getByLabel(m.totp, { exact: true }).fill("123456"); await page.getByRole("button", { name: m.signIn, exact: true }).click(); await expect(page.getByTestId("material-row")).toHaveCount(50);
}
async function detail(page: Page, id = first, locale = "ar") { await page.goto(`/${locale}/materials/${id}`); await expect(page.getByRole("heading", { name: locale === "ar" ? ar.review.title : en.review.title, exact: true })).toBeVisible(); }
/** يفتح حوار التحويل إن لم يكن مفتوحًا ويختار المسار والهدف والسبب؛ زر التأكيد يُسمّى بالحالة الهدف. */
async function choose(page: Page, to: string, reason: string, track?: "editorial" | "rights" | "technical") {
  const dialog = page.getByRole("dialog");
  if (!await dialog.isVisible()) await page.getByRole("button", { name: ar.review.open, exact: true }).click();
  if (track && await dialog.getByRole("combobox", { name: ar.review.track, exact: true }).count()) await dialog.getByRole("combobox", { name: ar.review.track, exact: true }).selectOption(track);
  const column = ({ editorial: "editorial_state", rights: "rights_state", technical: "technical_state" } as const)[track ?? "editorial"];
  await dialog.getByRole("radio", { name: (ar.states[column] as Record<string, string>)[to] }).check();
  await dialog.getByLabel(ar.review.reason, { exact: true }).fill(reason);
}
const confirm = (page: Page) => page.getByRole("dialog").getByRole("button", { name: new RegExp(`^${ar.review.confirmTo.split("{state}")[0]}`) });
test.beforeEach(async ({ request }) => { await request.post("http://127.0.0.1:3201/__test/reset"); });

test("review changes one track and displays a safe state history", async ({ page }) => {
  await login(page); await detail(page);
  await choose(page, "acknowledged", "synthetic review reason"); await confirm(page).click();
  await expect(page.getByRole("status").filter({ hasText: ar.review.transitioned.split("«")[0] })).toBeVisible();
  await expect(page.locator(".state-grid [data-track='editorial_state']")).toHaveText(ar.states.editorial_state.acknowledged);
  await expect(page.locator(".state-grid [data-track='technical_state']")).toHaveText(ar.states.technical_state.verified);
  await expect(page.locator(".state-grid [data-track='rights_state']")).toHaveText(ar.states.rights_state.unknown);
  await expect(page.locator(".history-list li")).toHaveCount(1); await expect(page.locator(".history-list")).not.toContainText("synthetic review reason");
  await choose(page, "documented", "rights checked", "rights"); await confirm(page).click();
  await expect(page.locator(".state-grid [data-track='rights_state']")).toHaveText(ar.states.rights_state.documented);
  await page.screenshot({ path: ".artifacts/review-ar.png", fullPage: true });
});
test("412 preserves the draft, blocks resubmission and requires explicit reload", async ({ page, request }) => {
  await login(page); await detail(page); await choose(page, "acknowledged", "keep this draft");
  await request.post("http://127.0.0.1:3201/__test/bump"); await confirm(page).click();
  await expect(page.getByText(ar.review.changed, { exact: true })).toBeVisible(); await expect(page.getByRole("dialog").getByLabel(ar.review.reason, { exact: true })).toHaveValue("keep this draft"); await expect(confirm(page)).toBeDisabled();
  await page.getByRole("button", { name: ar.review.reloadChanges, exact: true }).click(); await expect(page.getByRole("dialog")).toHaveCount(0);
  await choose(page, "acknowledged", "reviewed updated revision"); await confirm(page).click();
  await expect(page.locator(".state-grid [data-track='editorial_state']")).toHaveText(ar.states.editorial_state.acknowledged);
});
test("unknown write result retries the same key and duplicate clicks apply once", async ({ page, request }) => {
  await login(page); await detail(page); await choose(page, "acknowledged", "idempotent review"); await request.post("http://127.0.0.1:3201/__test/drop-write");
  await confirm(page).evaluate((button: HTMLButtonElement) => { button.click(); button.click(); });
  await expect(page.getByText(ar.review.failed, { exact: true })).toBeVisible();
  await confirm(page).click(); await expect(page.locator(".state-grid [data-track='editorial_state']")).toHaveText(ar.states.editorial_state.acknowledged);
  const data = await (await request.get("http://127.0.0.1:3201/__test/state")).json(); expect(data.writes).toHaveLength(2); expect(data.writes[0].key).toBe(data.writes[1].key); expect(data.applied).toBe(1);
});
test("contributors require exact totals and reservation can be released", async ({ page }) => {
  await login(page); await detail(page, second);
  await page.getByRole("button", { name: ar.review.reserve, exact: true }).click(); await expect(page.getByText(ar.review.yourReservation, { exact: true })).toBeVisible();
  await page.getByRole("button", { name: ar.review.releaseMine, exact: true }).click(); await expect(page.getByText(ar.review.unreserved, { exact: true })).toBeVisible();
  await page.getByLabel(ar.review.share, { exact: true }).fill("33.33"); await expect(page.getByRole("button", { name: ar.review.saveContributors, exact: true })).toBeDisabled();
  await page.getByRole("button", { name: ar.review.add, exact: true }).click(); await page.getByLabel(ar.review.userId, { exact: true }).nth(1).fill(target); await page.getByLabel(ar.review.share, { exact: true }).nth(1).fill("66.67"); const saved = page.waitForResponse(r => r.url().endsWith("/contributors") && r.request().method() === "PUT"); await page.getByRole("button", { name: ar.review.saveContributors, exact: true }).click(); expect((await saved).status()).toBe(200);
  await expect(page.getByLabel(ar.review.userId, { exact: true })).toHaveCount(2); await expect(page.getByLabel(ar.review.share, { exact: true }).nth(1)).toHaveValue("66.67");
});
test("administrator grants independent permissions and suspends with enum-only payload", async ({ page, request }) => {
  await login(page, "admin", "en"); await page.getByRole("link", { name: en.admin.title, exact: true }).click(); await page.getByLabel(en.admin.target, { exact: true }).fill(target);
  for (const label of [en.admin.location, en.admin.source, en.admin.identity]) {
    await page.getByLabel(en.admin.reason, { exact: true }).fill("approved synthetic request"); await page.getByRole("article", { name: label }).getByRole("button", { name: en.admin.grant, exact: true }).click(); await page.getByRole("dialog").getByRole("button", { name: en.admin.confirm, exact: true }).click(); await expect(page.getByRole("dialog")).toHaveCount(0);
  }
  await page.getByRole("article", { name: en.admin.location }).getByRole("button", { name: en.admin.revoke, exact: true }).click(); await page.getByRole("dialog").getByRole("button", { name: en.admin.confirm, exact: true }).click(); await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("article", { name: en.admin.identity, exact: true }).getByRole("button", { name: en.admin.revoke, exact: true }).click(); await page.getByRole("dialog").getByRole("button", { name: en.admin.confirm, exact: true }).click(); await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: en.admin.suspend, exact: true }).click(); await expect(page.getByRole("dialog")).toContainText(en.admin.suspendWarning); await page.getByRole("dialog").getByRole("button", { name: en.admin.confirm, exact: true }).click(); await expect(page.getByRole("dialog")).toHaveCount(0);
  const data = await (await request.get("http://127.0.0.1:3201/__test/state")).json(); expect(data.writes.map((r: { path: string }) => r.path.split("/").at(-1))).toEqual(["sensitive_location:read", "protected_source:read", "reporter_identity:read", "sensitive_location:read", "reporter_identity:read", "status"]); expect(data.writes[5].body).toEqual({ status: "suspended" });
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
  await login(page, "reporter"); await detail(page, "20000000-0000-4000-8000-000000000003"); await choose(page, "pending", "retry receipt", "technical"); await confirm(page).click(); await expect(page.locator(".state-grid [data-track='technical_state']")).toHaveText(ar.states.technical_state.pending); await expect(page.locator(".state-grid [data-track='editorial_state']")).toHaveText(ar.states.editorial_state.inbox);
});

test("identity policy requires a coded reason and confirmation, cancels safely, and retries one write", async ({ page, request }) => {
  await login(page, "admin"); await page.getByRole("link", { name: ar.admin.title, exact: true }).click();
  const card = page.getByRole("region", { name: ar.admin.identityTitle, exact: true });
  await expect(card.getByRole("combobox", { name: ar.admin.identityAccess, exact: true })).toHaveValue("separate");
  await card.getByRole("combobox", { name: ar.admin.identityAccess, exact: true }).selectOption("protected_source");
  await expect(card.getByRole("button", { name: ar.admin.saveSetting, exact: true })).toBeDisabled();
  await card.getByRole("combobox", { name: ar.admin.codedReason, exact: true }).selectOption("operational_need");
  await card.getByRole("button", { name: ar.admin.saveSetting, exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText(ar.admin.sourceAccessWarning);
  await page.getByRole("dialog").getByRole("button", { name: ar.cancel, exact: true }).click();
  expect((await (await request.get("http://127.0.0.1:3201/__test/state")).json()).writes).toHaveLength(0);
  await request.post("http://127.0.0.1:3201/__test/drop-write"); await card.getByRole("button", { name: ar.admin.saveSetting, exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: ar.admin.confirm, exact: true }).evaluate((button: HTMLButtonElement) => { button.click(); button.click(); });
  await expect(page.getByRole("dialog")).toContainText(ar.review.failed);
  await page.getByRole("dialog").getByRole("button", { name: ar.admin.confirm, exact: true }).click(); await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(card.getByRole("status")).toHaveText(ar.review.saved);
  const state = await (await request.get("http://127.0.0.1:3201/__test/state")).json();
  expect(state.writes).toHaveLength(2); expect(state.applied).toBe(1); expect(state.auditCount).toBe(22);
  expect(state.writes[0].key).toBe(state.writes[1].key); expect(state.writes[0].body).toEqual({ access: "protected_source", reason_code: "operational_need" });
  expect(await (await page.request.get("/api/bff/admin/settings/reporter-identity")).text()).not.toContain("never-display-canary");
  await card.screenshot({ path: ".artifacts/identity-ar.png" });
  await page.getByLabel(ar.admin.target, { exact: true }).fill(target); await page.getByRole("button", { name: ar.admin.loadHistory, exact: true }).click();
  await expect(page.getByTestId("permission-history").locator("li").first()).toContainText(ar.admin.historyKinds.setting_changed);
  await expect(page.getByTestId("permission-history").locator("li").first()).toContainText(ar.admin.globalSetting);
  await expect(page.getByTestId("permission-history")).not.toContainText("never-display-canary");
});

test("administrator can restore separate identity access with an explicit new reason", async ({ page }) => {
  await login(page, "admin", "en"); await page.getByRole("link", { name: en.admin.title, exact: true }).click();
  const card = page.getByRole("region", { name: en.admin.identityTitle, exact: true });
  for (const access of ["protected_source", "separate"]) {
    await expect(card.getByRole("combobox", { name: en.admin.identityAccess, exact: true })).toBeVisible();
    await card.getByRole("combobox", { name: en.admin.identityAccess, exact: true }).selectOption(access);
    await expect(card.getByRole("button", { name: en.admin.saveSetting, exact: true })).toBeDisabled();
    await card.getByRole("combobox", { name: en.admin.codedReason, exact: true }).selectOption("audit_finding");
    await card.getByRole("button", { name: en.admin.saveSetting, exact: true }).click();
    await expect(page.getByRole("dialog")).toContainText(access === "separate" ? en.admin.separateAccessHelp : en.admin.sourceAccessWarning);
    await page.getByRole("dialog").getByRole("button", { name: en.admin.confirm, exact: true }).click(); await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(card.getByRole("combobox", { name: en.admin.identityAccess, exact: true })).toHaveValue(access);
    await expect(card.getByRole("combobox", { name: en.admin.codedReason, exact: true })).toHaveValue("");
  }
});

test("permission history pages, isolates the selected account, clears failed reads and refreshes", async ({ page, request }) => {
  await login(page, "admin", "en"); await page.getByRole("link", { name: en.admin.title, exact: true }).click();
  const card = page.getByRole("region", { name: en.admin.history, exact: true });
  await page.getByLabel(en.admin.target, { exact: true }).fill(target); await card.getByRole("button", { name: en.admin.loadHistory, exact: true }).click();
  await expect(card.locator("li")).toHaveCount(20); await card.getByRole("button", { name: en.next, exact: true }).click(); await expect(card.locator("li")).toHaveCount(1);
  await expect(card.getByRole("button", { name: en.next, exact: true })).toBeDisabled(); await card.screenshot({ path: ".artifacts/permission-history-en.png" });
  await card.getByRole("button", { name: en.previous, exact: true }).click(); await expect(card.locator("li")).toHaveCount(20);
  await page.getByLabel(en.admin.target, { exact: true }).fill("10000000-0000-4000-8000-000000000003"); await expect(card.locator("li")).toHaveCount(0);
  await card.getByRole("button", { name: en.admin.loadHistory, exact: true }).click(); await expect(card.getByText(en.admin.emptyHistory, { exact: true })).toBeVisible();
  await page.getByLabel(en.admin.target, { exact: true }).fill(target); await card.getByRole("button", { name: en.admin.loadHistory, exact: true }).click(); await expect(card.locator("li")).toHaveCount(20);
  await request.post("http://127.0.0.1:3201/__test/history-unavailable"); await card.getByRole("button", { name: en.refresh, exact: true }).click();
  await expect(card.getByRole("alert")).toHaveText(en.admin.historyMissing); await expect(card.locator("li")).toHaveCount(0);
  await request.post("http://127.0.0.1:3201/__test/reset"); await card.getByRole("button", { name: en.refresh, exact: true }).click(); await expect(card.locator("li")).toHaveCount(20);
  await request.post("http://127.0.0.1:3201/__test/revoke-role"); await card.getByRole("button", { name: en.refresh, exact: true }).click(); await expect(card.getByRole("alert")).toHaveText(en.admin.denied); await expect(card.locator("li")).toHaveCount(0);
});

test("revoking the administrator role blocks a pending identity policy confirmation", async ({ page, request }) => {
  await login(page, "admin"); await page.getByRole("link", { name: ar.admin.title, exact: true }).click();
  await page.getByRole("combobox", { name: ar.admin.identityAccess, exact: true }).selectOption("protected_source"); await page.getByRole("combobox", { name: ar.admin.codedReason, exact: true }).selectOption("policy_change");
  await page.getByRole("button", { name: ar.admin.saveSetting, exact: true }).click(); await request.post("http://127.0.0.1:3201/__test/revoke-role");
  await page.getByRole("dialog").getByRole("button", { name: ar.admin.confirm, exact: true }).click(); await expect(page.getByRole("dialog")).toContainText(ar.review.forbidden);
  expect((await (await request.get("http://127.0.0.1:3201/__test/state")).json()).writes).toHaveLength(0);
});

test("ADR 0035 admin sets and clears staff work name and sees a safe 422", async ({ page }) => {
  await login(page, "admin"); await page.getByRole("link", { name: ar.admin.title, exact: true }).click();
  await page.getByLabel(ar.admin.target, { exact: true }).fill(target);
  const input = page.getByLabel(ar.admin.workName, { exact: true }); await input.fill("Synthetic staff");
  const saved = page.waitForRequest(r => r.url().endsWith(`/users/${target}/work-name`) && r.method() === "PUT");
  await page.getByRole("button", { name: ar.admin.workNameSave }).click(); const request = await saved; expect(request.postDataJSON()).toEqual({ work_name: "Synthetic staff" }); expect(request.headers()["idempotency-key"]).toBeTruthy();
  await expect(input).toHaveValue("");
  const cleared = page.waitForRequest(r => r.url().endsWith(`/users/${target}/work-name`) && r.method() === "PUT"); await page.getByRole("button", { name: ar.admin.workNameClear }).click(); expect((await cleared).postDataJSON()).toEqual({ work_name: null });
  await page.getByLabel(ar.admin.target, { exact: true }).fill("10000000-0000-4000-8000-000000000001"); await input.fill("Rejected staff"); await page.getByRole("button", { name: ar.admin.workNameSave }).click(); await expect(page.getByRole("alert")).toContainText(ar.admin.workNameRejected);
});
