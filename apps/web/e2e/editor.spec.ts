import { expect, test, type Page } from "@playwright/test";
import ar from "../messages/ar.json" with { type: "json" };
import en from "../messages/en.json" with { type: "json" };
async function login(page: Page, role = "reviewer", locale: "ar" | "en" = "ar") {
  const m = locale === "ar" ? ar : en;
  await page.goto(`/${locale}/login`); await page.getByLabel(m.email).fill(`${role}@example.test`); await page.getByLabel(m.password, { exact: true }).fill("synthetic-password"); await page.getByLabel(m.totp, { exact: true }).fill("123456"); await page.getByRole("button", { name: m.signIn, exact: true }).click(); await expect(page.getByTestId("material-row")).toHaveCount(50);
}
test.beforeEach(async ({ request }) => { await request.post("http://127.0.0.1:3201/__test/reset"); });

test("the inbox leads with unseen urgent material and the newsroom counters", async ({ page }) => {
  await login(page); const alert = page.getByTestId("urgent-alert");
  await expect(alert).toBeVisible(); await expect(alert).toContainText(ar.editor.urgentMany.replace("{n}", "10")); await expect(alert.locator(".mono")).toHaveText(/^\d{1,}:\d{2}/);
  await expect(page.getByTestId("stat-urgent")).toBeVisible();
  await alert.getByRole("button", { name: ar.editor.showUrgent }).click(); await expect(page.getByTestId("material-row")).toHaveCount(40); await expect(page.getByTestId("material-row").filter({ hasText: ar.states.priority.urgent })).toHaveCount(40);
  await expect(page.locator(".filter-panel")).not.toHaveAttribute("open");
  await page.screenshot({ path: ".artifacts/editor-inbox-ar.png" });
});

test("the transition dialog shows the reporter's message and asks twice before rejecting", async ({ page }) => {
  await login(page); await page.goto("/ar/materials/20000000-0000-4000-8000-000000000001");
  await page.getByRole("button", { name: ar.review.open, exact: true }).click();
  const dialog = page.getByRole("dialog", { name: ar.review.dialogTitle });
  await dialog.getByRole("radio", { name: ar.states.editorial_state.rejected }).check(); await dialog.getByLabel(ar.review.reason, { exact: true }).fill("short");
  await expect(dialog.getByRole("region", { name: ar.review.previewTitle })).toContainText(ar.states.editorial_state.rejected);
  await dialog.getByLabel(ar.review.reason, { exact: true }).fill("خارج نطاق التغطية"); await expect(dialog.getByText(ar.review.rejectHelp)).toBeVisible();
  await dialog.getByRole("button", { name: ar.review.confirmTo.replace("{state}", ar.states.editorial_state.rejected) }).click();
  const final = dialog.getByRole("button", { name: ar.review.confirmReject }); await expect(final).toBeVisible(); await page.screenshot({ path: ".artifacts/editor-dialog-ar.png" });
  await final.click(); await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator(".state-grid [data-track='editorial_state']")).toHaveText(ar.states.editorial_state.rejected);
  await expect(page.getByRole("status").filter({ hasText: ar.states.editorial_state.rejected })).toBeVisible();
});

test("the reason must be at least five characters and Escape returns focus to the opener", async ({ page }) => {
  await login(page, "reviewer", "en"); await page.goto("/en/materials/20000000-0000-4000-8000-000000000001");
  const open = page.getByRole("button", { name: en.review.open, exact: true }); await open.click();
  const dialog = page.getByRole("dialog"); await dialog.getByRole("radio", { name: en.states.editorial_state.acknowledged }).check(); await dialog.getByLabel(en.review.reason, { exact: true }).fill("ok");
  await expect(dialog.getByRole("button", { name: en.review.confirmTo.replace("{state}", en.states.editorial_state.acknowledged) })).toBeDisabled();
  await page.keyboard.press("Escape"); await expect(page.getByRole("dialog")).toHaveCount(0); await expect(open).toBeFocused();
});

test("state cards filter the timeline by their track", async ({ page }) => {
  await login(page); await page.goto("/ar/materials/20000000-0000-4000-8000-000000000001");
  await page.getByRole("button", { name: ar.review.open, exact: true }).click(); const dialog = page.getByRole("dialog");
  await dialog.getByRole("radio", { name: ar.states.editorial_state.acknowledged }).check(); await dialog.getByLabel(ar.review.reason, { exact: true }).fill("seen in review"); await dialog.getByRole("button", { name: /^تأكيد/ }).click();
  await expect(page.locator(".history-list li")).toHaveCount(1);
  const rights = page.locator(".state-card.track-rights"); await rights.click(); await expect(rights).toHaveAttribute("aria-pressed", "true"); await expect(page.locator(".history-list li")).toHaveCount(0);
  await rights.click(); await expect(page.locator(".history-list li")).toHaveCount(1);
});

test("notifications are compact, sectioned and navigable with j/k", async ({ page }) => {
  await login(page); await page.getByRole("link", { name: ar.notice.title, exact: true }).click();
  const rows = page.getByTestId("notification"); await expect(rows).toHaveCount(3);
  await rows.first().focus(); await page.keyboard.press("j"); await expect(rows.nth(1)).toHaveClass(/selected/);
  await expect(page.locator(".notification-preview-panel")).not.toContainText(ar.notice.choose);
  await page.getByRole("button", { name: ar.notice.readAll }).click(); await expect(page.getByRole("button", { name: ar.notice.readAll })).toBeDisabled();
});

test("below 760px the inbox table becomes stacked cards", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await login(page);
  await expect(page.locator(".table-panel thead")).toHaveCSS("position", "absolute"); await expect(page.locator(".table-panel tr").nth(1)).toHaveCSS("display", "block");
  await page.screenshot({ path: ".artifacts/editor-inbox-phone-ar.png" });
});

for (const locale of ["ar", "en"] as const) test(`ADR 0035 timeline uses work names and neutral null actors (${locale})`, async ({ page }) => {
  const m = locale === "ar" ? ar : en;
  await login(page, "reviewer", locale);
  await page.route("**/api/bff/materials/*/transitions", route => route.fulfill({ json: { items: [
    { id: "one", track: "editorial", from: "inbox", to: "reviewing", reason: "", actor_id: "10000000-0000-4000-8000-000000000002", actor_name: "Synthetic staff", occurred_at: "2026-10-27T10:00:00Z" },
    { id: "two", track: "editorial", from: "reviewing", to: "accepted", reason: "", actor_id: "10000000-0000-4000-8000-000000000003", actor_name: null, occurred_at: "2026-10-27T10:01:00Z" },
  ] } }));
  await page.goto(`/${locale}/materials/20000000-0000-4000-8000-000000000001`);
  await expect(page.locator(".history-list")).toContainText("Synthetic staff"); await expect(page.locator(".history-list")).toContainText(m.material.neutralActor);
  await expect(page.locator(".history-list")).not.toContainText("10000000");
});

test("ADR 0035 read-all sends one stable request and cutoff across a lost response", async ({ page }) => {
  await login(page); await page.goto("/ar/notifications");
  const writes: { key: string | undefined; body: unknown }[] = [];
  await page.route("**/api/bff/notifications/read-all", async route => {
    writes.push({ key: route.request().headers()["idempotency-key"], body: route.request().postDataJSON() });
    if (writes.length === 1) await route.fulfill({ status: 503, json: { code: "temporarily_unavailable" } }); else await route.continue();
  });
  const button = page.getByRole("button", { name: ar.notice.readAll, exact: true }); await button.click();
  await expect(page.getByRole("alert")).toBeVisible(); await button.click(); await expect(button).toBeDisabled();
  expect(writes).toHaveLength(2); expect(writes[1]).toEqual(writes[0]); expect(writes[0].key).toBeTruthy(); expect(Object.keys(writes[0].body as object)).toEqual(["before"]);
});
