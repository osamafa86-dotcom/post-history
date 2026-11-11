import { expect, test, type Page } from "@playwright/test";
import ar from "../messages/ar.json" with { type: "json" };
import en from "../messages/en.json" with { type: "json" };

async function signIn(page: Page, role: string, locale: "ar" | "en" = "ar") {
  const m = locale === "ar" ? ar : en;
  await page.goto(`/${locale}/login`); await page.getByLabel(m.email).fill(`${role}@example.test`); await page.getByLabel(m.password, { exact: true }).fill("synthetic-password"); await page.getByLabel(m.totp, { exact: true }).fill("123456");
  await page.getByRole("button", { name: m.signIn, exact: true }).click(); await page.waitForURL(url => !url.pathname.endsWith("/login"));
}
test.beforeEach(async ({ request }) => { await request.post("http://127.0.0.1:3201/__test/reset"); });

test("on a phone a material opens with its player, then the title and states; the assignment card comes after them", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await signIn(page, "reviewer"); await page.goto("/ar/materials/20000000-0000-4000-8000-000000000001");
  await expect(page.getByTestId("assignment-card")).toBeVisible();
  const top = async (selector: string) => (await page.locator(selector).first().boundingBox())!.y + await page.evaluate(() => window.scrollY);
  const player = await top(".preview-panel"), title = await top(".material-title"), states = await top(".states-card"), sensitivity = await top("[data-testid='sensitivity-line']"), assignment = await top("[data-testid='assignment-card']");
  expect(player).toBeLessThan(title); expect(title).toBeLessThan(states); expect(states).toBeLessThan(sensitivity); expect(sensitivity).toBeLessThan(assignment);
  // لا بطاقة قبل المشغّل.
  const before = await page.locator(".material-layout .card, .material-layout section").evaluateAll((nodes, limit) => nodes.filter(node => node.getClientRects().length && node.getBoundingClientRect().top + window.scrollY < limit && !node.classList.contains("preview-panel") && !node.closest(".preview-panel")).length, player);
  expect(before).toBe(0);
});

for (const [width, rows] of [[390, 60], [1440, 30]] as const) {
  test(`my materials is one grid in a few sections by time, not a section per coverage (${width}px)`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 }); await signIn(page, "reporter"); await page.goto("/ar/my-materials");
    const cards = page.getByTestId("mine-row"); await expect(cards).toHaveCount(100);
    expect(await page.getByTestId("mine-section").count()).toBeLessThanOrEqual(12);
    const lines = await cards.evaluateAll(nodes => new Set(nodes.map(node => Math.round(node.getBoundingClientRect().top + window.scrollY))).size);
    expect(lines).toBeLessThanOrEqual(rows);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  });
}

test("a coverage with several materials is one cover card with their count, and opens in place", async ({ page, request }) => {
  await request.post(`http://127.0.0.1:3201/__test/titles?title=${encodeURIComponent("تغطية واحدة")}`);
  await signIn(page, "reporter"); await page.goto("/ar/my-materials");
  const cover = page.getByTestId("mine-cover"), toggle = cover.getByRole("button"); await expect(cover).toHaveCount(1);
  await expect(cover).toContainText("تغطية واحدة"); await expect(cover).toContainText("100"); await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByTestId("mine-row")).toHaveCount(0);
  await toggle.click(); await expect(toggle).toHaveAttribute("aria-expanded", "true"); await expect(page.getByTestId("mine-row")).toHaveCount(100);
  // موادها في الشبكة نفسها بعد الغلاف.
  expect(await page.getByTestId("mine-row").first().evaluate(node => node.parentElement === document.querySelector("[data-testid='mine-cover']")!.parentElement)).toBe(true);
  await toggle.click(); await expect(page.getByTestId("mine-row")).toHaveCount(0);
  // التجميع بالنوع كما كان.
  await page.getByRole("button", { name: ar.mine.groupBy.type, exact: true }).click(); await expect(page.getByTestId("mine-row")).toHaveCount(100); await expect(page.getByTestId("mine-cover")).toHaveCount(0);
});
