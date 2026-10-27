import { expect, test, type Page } from "@playwright/test";
import ar from "../messages/ar.json" with { type: "json" };
import en from "../messages/en.json" with { type: "json" };
type Locale = "ar" | "en";
const dict = { ar, en };
async function login(page: Page, who: string, locale: Locale) {
  const m = dict[locale];
  await page.goto(`/${locale}/login`);
  await page.getByLabel(m.email).fill(`${who}@example.test`); await page.getByLabel(m.password, { exact: true }).fill("synthetic-password"); await page.getByLabel(m.totp, { exact: true }).fill("123456");
  await page.getByRole("button", { name: m.signIn, exact: true }).click();
  await expect(page.getByRole("banner")).toBeVisible();
}
test.beforeEach(async ({ request }) => { await request.post("http://127.0.0.1:3201/__test/reset"); });

// قرار المالك 2026-10-27: الشريط العلوي الداكن (Figma 193:593 وَ185:333) على كل الصفحات الرئيسية بالعربية والإنجليزية.
for (const locale of ["ar", "en"] as Locale[]) {
  const m = dict[locale];
  test(`staff top bar is present and marks the current page on each main page (${locale})`, async ({ page }) => {
    await login(page, "reviewer", locale);
    const pages: [string, string][] = [["inbox", m.inbox], ["board", m.board.title], ["upload", m.upload.nav], ["notifications", m.notice.title], ["form-preview", m.formPreview]];
    for (const [path, label] of pages) {
      await page.goto(`/${locale}/${path}`);
      const bar = page.getByRole("banner"); await expect(bar).toBeVisible(); await expect(bar).toHaveClass(/topbar/);
      const nav = bar.getByRole("navigation", { name: m.workspace }); await expect(nav).toBeVisible();
      await expect(nav.locator("[aria-current='page']")).toHaveCount(1); await expect(nav.locator("[aria-current='page']")).toHaveText(label);
      await expect(page.getByRole("main")).toHaveCount(1);
    }
  });
  test(`top bar puts the brand at the start edge and the user at the end edge (${locale})`, async ({ page }) => {
    await login(page, "reviewer", locale);
    await expect(page.locator("html")).toHaveAttribute("dir", locale === "ar" ? "rtl" : "ltr");
    const bar = page.getByRole("banner"), brand = await bar.locator(".topbar-brand").boundingBox(), nav = await bar.locator(".topbar-nav").boundingBox(), end = await bar.locator(".topbar-end").boundingBox(), whole = await bar.boundingBox();
    expect(brand && nav && end && whole).toBeTruthy();
    if (locale === "ar") { expect(brand!.x).toBeGreaterThan(nav!.x); expect(nav!.x).toBeGreaterThan(end!.x); expect(brand!.x + brand!.width).toBeGreaterThan(whole!.x + whole!.width - 48); expect(end!.x).toBeLessThan(whole!.x + 48); }
    else { expect(brand!.x).toBeLessThan(nav!.x); expect(nav!.x).toBeLessThan(end!.x); expect(brand!.x).toBeLessThan(whole!.x + 48); expect(end!.x + end!.width).toBeGreaterThan(whole!.x + whole!.width - 48); }
    // مظهر داكن: خلفية الشريط أغمق من لون الصفحة الفاتحة، وخط سفلي للنشط ببعد 3px.
    const luminance = await bar.evaluate(el => { const [r, g, b] = getComputedStyle(el).backgroundColor.match(/\d+/g)!.map(Number); return 0.2126 * r + 0.7152 * g + 0.0722 * b; });
    expect(luminance).toBeLessThan(60);
    const underline = await bar.locator("[aria-current='page']").evaluate(el => { const s = getComputedStyle(el, "::after"); return { height: s.height, bottom: s.insetBlockEnd }; });
    expect(underline).toEqual({ height: "3px", bottom: "0px" });
    await expect(bar.getByTestId("topbar-user")).toHaveText(/\S/);
    await expect(bar.getByRole("button", { name: m.logout, exact: true })).toBeVisible(); await expect(bar.getByRole("link", { name: m.language, exact: true })).toBeVisible();
  });
  test(`buyer top bar shows the store destinations and no staff pages (${locale})`, async ({ page }) => {
    await login(page, "buyer", locale);
    await expect(page).toHaveURL(new RegExp(`/${locale}/store$`));
    const nav = page.getByRole("banner").getByRole("navigation", { name: m.workspace });
    await expect(nav.getByRole("link")).toHaveText([m.store.title, m.licenses.nav, m.orders.nav, m.buyers.myOrganization]);
    await expect(nav.locator("[aria-current='page']")).toHaveText(m.store.title);
    await nav.getByRole("link", { name: m.licenses.nav }).click(); await expect(nav.locator("[aria-current='page']")).toHaveText(m.licenses.nav);
    await nav.getByRole("link", { name: m.buyers.myOrganization }).click(); await expect(nav.locator("[aria-current='page']")).toHaveText(m.buyers.myOrganization);
  });
}

test("the top bar stays within a phone viewport and its nav scrolls on its own", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await login(page, "admin", "ar");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const nav = page.getByRole("banner").getByRole("navigation", { name: ar.workspace });
  expect(await nav.evaluate(el => el.scrollWidth > el.clientWidth)).toBe(true);
  await nav.getByRole("link", { name: ar.admin.title }).click(); await expect(page).toHaveURL(/\/ar\/admin$/);
});
