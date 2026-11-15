import { expect, test, type Page } from "@playwright/test";
import ar from "../messages/ar.json" with { type: "json" };
import en from "../messages/en.json" with { type: "json" };
const dict = { ar, en };
async function login(page: Page, role = "reporter") {
  await page.goto("/ar/login"); await page.getByLabel(ar.email).fill(`${role}@example.test`); await page.getByLabel(ar.password, { exact: true }).fill("synthetic-password"); await page.getByLabel(ar.totp, { exact: true }).fill("123456");
  await page.getByRole("button", { name: ar.signIn, exact: true }).click(); await expect(page).not.toHaveURL(/login/);
}
test.beforeEach(async ({ request }) => { await request.post("http://127.0.0.1:3201/__test/reset"); });

for (const locale of ["ar", "en"] as const) test(`a missing page loads without a script error, one h1 and the unified title (${locale})`, async ({ page }) => {
  const m = dict[locale], errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await page.goto(`/${locale}/no-such-page`); await expect(page.getByTestId("page-not-found")).toBeVisible();
  await expect(page).toHaveTitle(`${m.pageNotFound.title} · ${m.product}`); await expect(page.locator("html")).toHaveAttribute("lang", locale);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(m.pageNotFound.title); await expect(page.locator("h2 h1, h1 h1")).toHaveCount(0);
  // يُترك وقت للترطيب كي يظهر خطأ عدم التطابق إن وقع
  await page.waitForLoadState("networkidle"); expect(errors).toEqual([]);
});

test("an unknown language in the path is a missing page, titled as one", async ({ page }) => {
  await page.goto("/fr/login"); await expect(page.getByTestId("page-not-found")).toBeVisible();
  await expect(page).toHaveTitle(`${ar.pageNotFound.title} · ${ar.product}`);
});

test("the account button's name starts with what it shows, and its menu closes when focus leaves it", async ({ page }) => {
  await login(page);
  const avatar = page.getByTestId("topbar").locator(".avatar"), shown = (await avatar.innerText()).trim();
  expect(shown.length).toBeGreaterThan(0); expect(await avatar.getAttribute("aria-label")).toMatch(new RegExp(`^${shown}`));
  await avatar.click(); const menu = page.locator("#account-menu"); await expect(menu).toBeVisible();
  // Tab بعد آخر بنودها يخرج التركيز منها فتُغلق
  const items = await menu.locator("a, button").count();
  for (let i = 0; i <= items; i++) await page.keyboard.press("Tab");
  await expect(menu).toHaveCount(0);
  // Escape من داخلها ما زال يغلقها ويعيد التركيز إلى زرّها
  await avatar.click(); await page.keyboard.press("Tab"); await page.keyboard.press("Escape"); await expect(menu).toHaveCount(0); await expect(avatar).toBeFocused();
});

test("date and time fields show the focus ring when reached by keyboard", async ({ page }) => {
  await login(page); await page.goto("/ar/upload");
  await page.getByLabel(ar.upload.choose).setInputFiles({ name: "A001C001.MOV", mimeType: "video/quicktime", buffer: Buffer.alloc(2048, 1) });
  for (const field of [page.getByLabel(ar.upload.shotAt), page.locator("#field-event_time")]) {
    await field.scrollIntoViewIfNeeded(); await field.focus(); await page.keyboard.press("Shift+Tab"); await page.keyboard.press("Tab");
    await expect(field).toBeFocused();
    const ring = await field.evaluate(element => { const style = getComputedStyle(element); return { style: style.outlineStyle, width: parseFloat(style.outlineWidth) }; });
    expect(ring.style).not.toBe("none"); expect(ring.width).toBeGreaterThanOrEqual(2);
  }
});
