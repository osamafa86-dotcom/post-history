import { expect, test, type Page } from "@playwright/test";
import ar from "../messages/ar.json" with { type: "json" };

const api = "http://127.0.0.1:3201";
async function signIn(page: Page, role = "reviewer") {
  await page.goto("/ar/login"); await page.getByLabel(ar.email).fill(`${role}@example.test`); await page.getByLabel(ar.password, { exact: true }).fill("synthetic-password"); await page.getByLabel(ar.totp, { exact: true }).fill("123456");
  await page.getByRole("button", { name: ar.signIn, exact: true }).click(); await page.waitForURL(url => !url.pathname.endsWith("/login"));
}
const rows = (page: Page) => page.getByTestId("material-row");
test.beforeEach(async ({ request }) => { await request.post(`${api}/__test/reset`); });

test("a material stays in «under review» after it is acknowledged, and only the publisher has a final-review tab", async ({ page, request }) => {
  await request.post(`${api}/__test/board-mix`);
  await signIn(page); await expect(rows(page)).toHaveCount(50);
  await expect(page.getByTestId("tab-final_review")).toHaveCount(0);
  const reviewing = page.getByTestId("tab-reviewing"); await expect(reviewing).toHaveText(new RegExp(`^${ar.inboxTabs.reviewing}\\s*3$`));
  await reviewing.click(); await expect(reviewing).toHaveAttribute("aria-pressed", "true"); await expect(rows(page)).toHaveCount(3);
  for (const state of ["acknowledged", "reviewing", "needs_changes"] as const) await expect(rows(page).filter({ hasText: ar.states.editorial_state[state] })).toHaveCount(1);
  // لوحة التصفية تحمل التبويب خيارًا، فـ«تطبيق» لا يسقطه
  await page.getByRole("button", { name: ar.filters, exact: true }).click(); await expect(page.locator("#inbox-filters select[name=editorial_state]")).toHaveValue("acknowledged,reviewing,needs_changes");
  await page.getByRole("button", { name: ar.apply, exact: true }).click(); await expect(rows(page)).toHaveCount(3); await expect(reviewing).toHaveAttribute("aria-pressed", "true");
  // رئيس التحرير: ما ينتظر نشره في تبويبه
  await page.context().clearCookies(); await signIn(page, "chief");
  const final = page.getByTestId("tab-final_review"); await expect(final).toHaveText(new RegExp(`^${ar.inboxTabs.final_review}\\s*1$`));
  await final.click(); await expect(rows(page)).toHaveCount(1); await expect(rows(page)).toContainText(ar.states.editorial_state.final_review);
});

test("the review tab pages through its states without losing or repeating a material", async ({ page, request }) => {
  await request.post(`${api}/__test/review-load`);
  await signIn(page); await page.getByTestId("tab-reviewing").click();
  // الصفحة الأولى: 50 من «اطّلع عليها» و5 «قيد المراجعة»؛ الثانية: العشر الباقية من «اطّلع عليها» وحدها
  await expect(rows(page)).toHaveCount(55); const firstPage = await rows(page).locator("a").first().getAttribute("href");
  const seen = new Set(await rows(page).evaluateAll(list => list.map(row => row.querySelector("a")?.getAttribute("href"))));
  await page.getByRole("button", { name: ar.next, exact: true }).click(); await expect(rows(page)).toHaveCount(10);
  for (const href of await rows(page).evaluateAll(list => list.map(row => row.querySelector("a")?.getAttribute("href")))) { expect(seen.has(href)).toBe(false); seen.add(href); }
  expect(seen.size).toBe(65); await expect(page.getByRole("button", { name: ar.next, exact: true })).toBeDisabled();
  await page.getByRole("button", { name: ar.previous, exact: true }).click(); await expect(rows(page)).toHaveCount(55); await expect(rows(page).locator("a").first()).toHaveAttribute("href", firstPage!);
});

test("search reads Arabic-Indic digits as Latin ones, and the filter panel asks for no account identifier", async ({ page }) => {
  await signIn(page); await expect(rows(page)).toHaveCount(50);
  await page.locator("#shell-search").fill("٠٠٧"); await expect(rows(page)).toHaveCount(1); await expect(rows(page)).toContainText("007");
  await page.locator("#shell-search").fill(""); await page.getByRole("button", { name: ar.filters, exact: true }).click();
  await expect(page.locator("#inbox-filters input[name=governorate]")).toBeVisible(); await expect(page.locator("#inbox-filters input[name=reporter_id]")).toHaveCount(0);
  await expect(page.locator("#inbox-filters .sort-tools option")).toHaveCount(5);
});

test("the board names its first column by what it counts, and Escape leaves the wall", async ({ page }) => {
  await signIn(page); await page.goto("/ar/board");
  await expect(page.locator("#column-incoming")).toContainText(ar.board.columns.incoming); expect(ar.board.columns.incoming).not.toBe(ar.inboxTabs.inbox);
  await page.goto("/ar/board?display=1"); await expect(page.getByTestId("wall-card")).toHaveCount(8);
  // صندوق السطر الثاني وحشوه يسعان ما ينزل من الياء تحت السطر، والحشو لا يبلغ رأس ألف مهموزة في سطر ثالث مقصوص
  const fit = await page.locator(".tile-title").first().evaluate(node => {
    const style = getComputedStyle(node), ctx = document.createElement("canvas").getContext("2d")!; ctx.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    const font = ctx.measureText("x"), half = (parseFloat(style.lineHeight) - font.fontBoundingBoxAscent - font.fontBoundingBoxDescent) / 2, pad = parseFloat(style.paddingBottom);
    return { below: half + font.fontBoundingBoxDescent + pad, yaa: ctx.measureText("\u064a").actualBoundingBoxDescent, above: half + font.fontBoundingBoxAscent - pad, alef: ctx.measureText("\u0623").actualBoundingBoxAscent };
  });
  expect(fit.yaa).toBeGreaterThan(0); expect(fit.below).toBeGreaterThanOrEqual(fit.yaa); expect(fit.above).toBeGreaterThanOrEqual(fit.alef);
  await page.keyboard.press("Escape"); await expect(page).toHaveURL(/\/ar\/board$/); await expect(page.getByTestId("board-display")).toHaveCount(0);
  await expect(page.locator("#column-incoming")).toBeVisible();
});
