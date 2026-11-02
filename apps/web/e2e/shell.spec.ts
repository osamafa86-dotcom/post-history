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
const probe = (page: Page, property: "backgroundColor" | "color", token: string) => page.evaluate(([p, t]) => { const i = document.createElement("i"); i.style[p as "color"] = `var(${t})`; document.body.append(i); const value = getComputedStyle(i)[p as "color"]; i.remove(); return value; }, [property, token]);
test.beforeEach(async ({ request }) => { await request.post("http://127.0.0.1:3201/__test/reset"); });

// هيكل v2 (W1، T1، M1؛ ADR 0085 وweb-v2.md): الشريط الجانبي في جهة البداية بثلاث مجموعات، والشريط العلوي بالبحث والجرس والحساب.
for (const locale of ["ar", "en"] as Locale[]) {
  const m = dict[locale];
  test(`the sidebar marks the current page on each main page (${locale})`, async ({ page }) => {
    await login(page, "reviewer", locale);
    const pages: [string, string][] = [["inbox", m.inbox], ["board", m.board.title], ["upload", m.upload.nav], ["notifications", m.notice.title], ["form-preview", m.formPreview]];
    for (const [path, label] of pages) {
      await page.goto(`/${locale}/${path}`);
      await expect(page.getByRole("banner")).toHaveClass(/topbar workspace/);
      const nav = page.getByRole("navigation", { name: m.workspace }); await expect(nav).toBeVisible();
      await expect(nav.locator("[aria-current='page']")).toHaveCount(1); await expect(nav.locator("[aria-current='page']")).toHaveAccessibleName(label);
      await expect(page.getByRole("main")).toHaveCount(1);
    }
    await expect(page.getByRole("navigation", { name: m.workspace }).getByText(m.shell.groups.newsroom, { exact: true })).toBeVisible();
  });
  test(`the sidebar sits on the start edge and the bar carries search, bell and account, in v2 tokens (${locale})`, async ({ page }) => {
    await login(page, "reviewer", locale);
    await expect(page.locator("html")).toHaveAttribute("dir", locale === "ar" ? "rtl" : "ltr");
    const sidebar = (await page.getByTestId("sidebar").boundingBox())!, main = (await page.getByRole("main").boundingBox())!, width = page.viewportSize()!.width;
    if (locale === "ar") { expect(sidebar.x).toBeGreaterThan(main.x); expect(sidebar.x + sidebar.width).toBeGreaterThan(width - 2); } else { expect(sidebar.x).toBeLessThan(main.x); expect(sidebar.x).toBeLessThan(2); }
    expect(sidebar.width).toBe(240);
    const bar = page.getByRole("banner");
    await expect(bar.getByRole("searchbox", { name: m.inboxSearch.label })).toBeVisible();
    await expect(bar.getByRole("button", { name: m.shell.bell.open })).toBeVisible();
    // الألوان من رموز v2 الدلالية نفسها: سطح الشريط bg/raised والصفحة bg/base.
    expect(await bar.evaluate(el => getComputedStyle(el).backgroundColor)).toBe(await probe(page, "backgroundColor", "--v2-c-bg-raised"));
    expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe(await probe(page, "backgroundColor", "--v2-c-bg-base"));
    // الخطوط مستضافة على الأصل نفسه (CSP font-src 'self'): العنوان بـ Rubik والنص بـ Readex Pro.
    expect(await page.getByRole("heading", { level: 1 }).evaluate(el => getComputedStyle(el).fontFamily)).toMatch(/^"?Rubik/);
    expect(await page.evaluate(() => getComputedStyle(document.body).fontFamily)).toMatch(/^"?Readex Pro/);
    await expect.poll(() => page.evaluate(() => document.fonts.check('16px "Readex Pro"') && document.fonts.check('700 22px "Rubik"'))).toBe(true);
    const account = bar.getByRole("button", { name: new RegExp(`^${m.shell.account}`) }); await account.click();
    await expect(page.getByTestId("topbar-user")).toHaveText(/\S/); await expect(page.getByTestId("topbar-user")).not.toContainText("@");
    await expect(page.getByRole("button", { name: m.logout, exact: true })).toBeVisible(); await expect(page.getByRole("link", { name: m.language, exact: true })).toBeVisible();
    await page.keyboard.press("Escape"); await expect(page.getByRole("button", { name: m.logout, exact: true })).toHaveCount(0);
  });
  test(`buyer bar shows the store destinations and no staff pages, in the store's dark face (${locale})`, async ({ page }) => {
    await login(page, "buyer", locale);
    await expect(page).toHaveURL(new RegExp(`/${locale}/store$`));
    await expect(page.getByTestId("sidebar")).toHaveCount(0); await expect(page.getByTestId("bottombar")).toHaveCount(0);
    await expect(page.locator(".app-shell")).toHaveAttribute("data-mode", "dark");
    const nav = page.getByRole("banner").getByRole("navigation", { name: m.workspace });
    await expect(nav.getByRole("link")).toHaveText([m.store.title, m.licenses.nav, m.orders.nav, m.buyers.myOrganization]);
    await expect(nav.locator("[aria-current='page']")).toHaveText(m.store.title);
    await nav.getByRole("link", { name: m.licenses.nav }).click(); await expect(nav.locator("[aria-current='page']")).toHaveText(m.licenses.nav);
    await nav.getByRole("link", { name: m.buyers.myOrganization }).click(); await expect(nav.locator("[aria-current='page']")).toHaveText(m.buyers.myOrganization);
  });
}

test("the bell opens the notifications panel (W10): tabs, urgent first, mark all read and a link to the full page", async ({ page }) => {
  await login(page, "reviewer", "ar"); const t = ar.shell.bell;
  await page.getByRole("banner").getByRole("button", { name: t.open }).click();
  const panel = page.getByTestId("notifications-panel"); await expect(panel).toBeVisible();
  await expect(panel.getByRole("tab")).toHaveText([new RegExp(`^${t.tabs.all}`), t.tabs.mine, t.tabs.urgent]);
  await expect(panel.getByTestId("bell-item")).toHaveCount(3); await expect(panel).not.toContainText("never-display-canary");
  await panel.getByRole("tab", { name: t.tabs.urgent }).click(); await expect(panel.getByRole("tab", { name: t.tabs.urgent })).toHaveAttribute("aria-selected", "true");
  await panel.getByRole("tab", { name: new RegExp(`^${t.tabs.all}`) }).click();
  await panel.getByRole("button", { name: t.readAll }).click(); await expect(panel.getByRole("button", { name: t.readAll })).toBeDisabled();
  await panel.getByRole("tab", { name: t.tabs.mine }).focus(); await page.keyboard.press("Escape"); await expect(panel).toHaveCount(0);
  await page.getByRole("banner").getByRole("button", { name: t.open }).click(); await page.getByTestId("notifications-panel").getByRole("link", { name: t.all }).click();
  await expect(page).toHaveURL(/\/ar\/notifications$/);
});

test("a tablet gets the icon rail with short labels and full names (T1)", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 }); await login(page, "reviewer", "ar");
  const sidebar = page.getByTestId("sidebar"); expect((await sidebar.boundingBox())!.width).toBe(76);
  await expect(sidebar.getByRole("link", { name: ar.inbox, exact: true })).toBeVisible();
  await expect(sidebar.locator(".nav-short").first()).toBeVisible(); expect((await sidebar.locator(".nav-group-title").first().boundingBox())!.width).toBeLessThanOrEqual(1);
  for (const button of await page.getByTestId("material-row").first().getByRole("button").all()) expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("a phone gets the bottom bar with five destinations and «more» holds the rest and the account (M1)", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await login(page, "admin", "ar");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await expect(page.getByTestId("sidebar")).not.toBeVisible();
  const bar = page.getByRole("navigation", { name: ar.shell.bottomNav }); await expect(bar).toBeVisible();
  await expect(bar.getByRole("listitem")).toHaveCount(5); await expect(bar.locator("[aria-current='page']")).toHaveAccessibleName(ar.inbox);
  for (const item of await bar.getByRole("listitem").all()) expect((await item.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await bar.getByRole("button", { name: ar.shell.more }).click();
  const sheet = page.locator("#more-sheet"); await expect(sheet.getByRole("button", { name: ar.logout, exact: true })).toBeVisible();
  await sheet.getByRole("link", { name: ar.admin.title }).click(); await expect(page).toHaveURL(/\/ar\/admin$/);
  await expect(bar.getByRole("button", { name: ar.shell.more })).toHaveAttribute("aria-current", "page");
});

test("a page outside the role says so, names the role and leads back (E5)", async ({ page }) => {
  await login(page, "reviewer", "ar"); await page.goto("/ar/payouts");
  const state = page.getByTestId("no-access"); await expect(state).toBeVisible();
  await expect(state.getByRole("alert")).toHaveText(ar.payouts.denied); await expect(state).toContainText(ar.shell.noAccess.title);
  await expect(page.getByTestId("sidebar").getByRole("link", { name: ar.payouts.nav })).toHaveCount(0);
  await state.getByRole("link", { name: ar.shell.noAccess.backInbox }).click(); await expect(page).toHaveURL(/\/ar\/inbox$/);
});
