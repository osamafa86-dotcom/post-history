import { expect, test, type Page } from "@playwright/test";
import ar from "../messages/ar.json" with { type: "json" };
const api = "http://127.0.0.1:3201";
async function login(page: Page, email: string) {
  await page.goto("/ar/login");
  await page.getByLabel(ar.email).fill(email); await page.getByLabel(ar.password, { exact: true }).fill("synthetic-password"); await page.getByLabel(ar.totp, { exact: true }).fill("123456");
  await page.getByRole("button", { name: ar.signIn, exact: true }).click();
  await expect(page.getByTestId("material-row")).toHaveCount(50);
}
test.beforeEach(async ({ request }) => { await request.post(`${api}/__test/reset`); });

test("supervisor sees editorial columns, counts, urgent and overdue tiles and receipts without leaked fields", async ({ page }) => {
  await login(page, "reviewer@example.test");
  await page.getByRole("link", { name: ar.board.title }).click();
  await expect(page.getByTestId("column-inbox").getByTestId("board-card")).toHaveCount(20);
  await expect(page.getByTestId("column-accepted").getByTestId("board-card")).toHaveCount(1);
  await expect(page.getByTestId("column-inbox")).toContainText("199");
  await expect(page.getByTestId("urgent-open")).toContainText("40"); await expect(page.getByTestId("overdue")).toContainText("2");
  await expect(page.getByText(ar.board.more)).toHaveCount(1);
  await expect(page.locator(".receipt-list li")).toHaveCount(3);
  await expect(page.getByTestId("upload-progress")).toHaveCount(1); await expect(page.getByTestId("upload-progress")).toContainText("25%");
  expect(await page.locator("body").textContent()).not.toContain("never-display-canary");
  await page.screenshot({ path: ".artifacts/board-desktop.png", fullPage: true });
});

test("reporters do not see the board and the BFF refuses them", async ({ page }) => {
  await login(page, "reporter@example.test");
  await expect(page.getByRole("link", { name: ar.board.title })).toHaveCount(0);
  expect((await page.request.get("/api/bff/dashboard/newsroom")).status()).toBe(403);
  await page.goto("/ar/board"); await expect(page.getByText(ar.board.denied)).toBeVisible();
});

test("wall display: no workspace chrome, dark by default, big tiles, six columns of eight and no leaked fields", async ({ page }) => {
  await login(page, "reviewer@example.test");
  await page.getByRole("link", { name: ar.board.title }).click();
  await page.getByRole("link", { name: ar.board.openDisplay }).click();
  await expect(page).toHaveURL(/\/ar\/board\?display=1$/);
  await expect(page.getByTestId("board-display")).toBeVisible();
  await expect(page.locator(".site-header")).toBeHidden(); await expect(page.locator(".sidebar")).toBeHidden();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.getByTestId("wall-urgent-open")).toContainText("40"); await expect(page.getByTestId("wall-urgent-open")).toHaveClass(/tone-urgent/);
  await expect(page.getByTestId("wall-overdue")).toContainText("2");
  await expect(page.locator(".wall-tiles")).toHaveAttribute("aria-live", "polite");
  await expect(page.getByTestId("wall-column-inbox").getByTestId("wall-card")).toHaveCount(8);
  await expect(page.getByTestId("wall-column-inbox").getByTestId("wall-card").first()).toHaveClass(/urgent/);
  await expect(page.getByTestId("wall-column-inbox")).toContainText(ar.board.display.more.replace("{n}", "191"));
  await expect(page.getByTestId("wall-column-published")).toContainText(ar.board.display.empty);
  // Figma 193:862: دليل المسارات، رقم العمود الكبير بخط سفلي، وبطاقة بشريط داكن (إيصال وعمر) ولسان عاجل وخط مسارات وسطر محافظة.
  await expect(page.locator(".track-legend li")).toHaveCount(5); await expect(page.locator(".track-legend")).toContainText(ar.trackLine.legend);
  const head = page.getByTestId("wall-column-inbox").locator("h2"); await expect(head.locator(".wall-count")).toHaveText("199"); await expect(head).toHaveCSS("border-bottom-width", "2px");
  const card = page.getByTestId("wall-column-inbox").getByTestId("wall-card").first();
  await expect(card.locator(".wall-slate .wall-receipt")).toHaveText(/^RCPT-/); await expect(card.locator(".wall-priority.urgent")).toHaveText(ar.states.priority.urgent);
  await expect(card.getByTestId("track-line").locator(".track-seg")).toHaveCount(3); await expect(card.locator(".wall-place")).toHaveText(/\S/);
  await expect(page.locator(".wall-date")).toContainText(/\d{4}/);
  await expect(page.getByTestId("wall-upload")).toHaveCount(1); await expect(page.getByTestId("wall-upload")).toContainText("25%");
  await expect(page.getByTestId("wall-sound")).toContainText(ar.board.display.soundOff);
  await page.mouse.click(5, 5); await expect(page.getByTestId("wall-sound")).toContainText(ar.board.display.soundOn);
  expect(await page.locator("body").textContent()).not.toContain("never-display-canary");
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.screenshot({ path: ".artifacts/board-wall-1920.png" });
  await page.getByRole("link", { name: ar.board.display.exit }).focus(); await page.keyboard.press("Enter");
  await expect(page.locator(".site-header")).toBeVisible(); await expect(page.locator("html")).not.toHaveAttribute("data-theme", "dark");
});

test("wall display goes stale and dims when the snapshot fails, and can be light", async ({ page }) => {
  await login(page, "reviewer@example.test");
  await page.goto("/ar/board?display=1&theme=light");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(page.getByTestId("wall-urgent-open")).toContainText("40");
  await page.route("**/api/bff/dashboard/newsroom", route => route.fulfill({ status: 503, body: "{}" }));
  await expect(page.locator(".wall-banner.bad")).toContainText(ar.board.display.stale.split("{time}")[0].trim(), { timeout: 12000 });
  await expect(page.locator(".wall-body")).toHaveClass(/stale/);
});

test("ADR 0035 board and wall use server names and deadlines, tolerating null fields", async ({ page }) => {
  await login(page, "reviewer@example.test"); await page.goto("/ar/board");
  await expect(page.getByTestId("column-inbox")).toContainText(ar.board.reservedName.replace("{name}", "Synthetic staff"));
  await expect(page.getByTestId("ack-overdue")).toHaveCount(1);
  await expect(page.getByTestId("overdue")).toContainText(ar.board.oldestOverdue.split("{time}")[0]);
  await page.goto("/ar/board?display=1"); await expect(page.getByTestId("wall-column-inbox")).toContainText("Synthetic staff");
  await expect(page.getByTestId("wall-overdue")).toContainText(ar.board.oldestOverdue.split("{time}")[0]);
  await page.route("**/api/bff/materials?*", async route => { const response = await route.fetch(), data = await response.json(); for (const item of data.items) { item.reserved_by_name = null; item.acknowledgement_due_at = null; } await route.fulfill({ response, json: data }); });
  await page.route("**/api/bff/dashboard/newsroom", async route => { const response = await route.fetch(), data = await response.json(); data.oldest_overdue_acknowledgement_at = null; for (const item of data.reserved) item.reserved_by_name = null; await route.fulfill({ response, json: data }); });
  await page.reload(); await expect(page.getByTestId("wall-card")).not.toHaveCount(0); await expect(page.getByTestId("board-display")).not.toContainText("Synthetic staff");
  await expect(page.getByTestId("ack-overdue")).toHaveCount(0); await expect(page.getByTestId("wall-overdue")).not.toContainText(ar.board.oldestOverdue.split("{time}")[0]);
});
