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
