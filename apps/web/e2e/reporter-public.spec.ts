import { expect, test, type Page } from "@playwright/test";
import ar from "../messages/ar.json" with { type: "json" };
import en from "../messages/en.json" with { type: "json" };
const api = "http://127.0.0.1:3201";
type Locale = "ar" | "en";
async function login(page: Page, role: string, locale: Locale = "ar") {
  const m = locale === "ar" ? ar : en;
  await page.goto(`/${locale}/login`); await page.getByLabel(m.email).fill(`${role}@example.test`); await page.getByLabel(m.password, { exact: true }).fill("synthetic-password"); await page.getByLabel(m.totp, { exact: true }).fill("123456"); await page.getByRole("button", { name: m.signIn, exact: true }).click();
  await expect(page).not.toHaveURL(/\/login/);
}
const noSideScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
test.beforeEach(async ({ request }) => { await request.post(`${api}/__test/reset`); });

test("«موادي» is a gallery: cards with three separate states, coverage grouping, chips, and no sideways scroll at 1280 and 375 (ADR 0103)", async ({ page }) => {
  const t = ar.mine; await login(page, "reporter"); await page.setViewportSize({ width: 1280, height: 800 }); await page.goto("/ar/my-materials");
  await expect(page.getByTestId("mine-row")).toHaveCount(100);
  const card = page.getByTestId("mine-row").first();
  await expect(card.locator("[data-track]")).toHaveCount(3);
  await expect(page.getByTestId("mine-kpis").locator("[data-kpi='action'] strong")).toHaveText("1");
  await expect(page.locator(".mine-group").first().locator("header p")).toContainText(/·/);
  await page.getByRole("button", { name: t.groupBy.type }).click(); await expect(page.getByRole("button", { name: t.groupBy.type })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("navigation", { name: t.filtersLabel }).getByRole("button", { name: t.filters.urgent }).click();
  const urgent = await page.getByTestId("mine-row").count(); expect(urgent).toBeLessThan(100);
  for (const row of (await page.getByTestId("mine-row").all()).slice(0, 3)) await expect(row).toContainText(ar.states.priority.urgent);
  // لا تُطلب مصغّرة من الخادم للمادة الحسّاسة: البطاقة تقول «لا معاينة سحابية».
  const sensitive = page.locator("[data-testid='mine-row'][data-sensitive='true']");
  if (await sensitive.count()) { await expect(sensitive.first()).toContainText(t.noCloudPreview); await expect(sensitive.first().locator("img")).toHaveCount(0); }
  expect(await noSideScroll(page)).toBe(true); await page.screenshot({ path: ".artifacts/mine-1280-ar.png" });
  await page.setViewportSize({ width: 375, height: 812 }); expect(await noSideScroll(page)).toBe(true);
  await page.reload(); await expect(page.getByRole("button", { name: t.groupBy.type })).toHaveAttribute("aria-pressed", "true");
  await page.screenshot({ path: ".artifacts/mine-375-ar.png", fullPage: true });
});

test("«أرباحي» carries the store's fixed trial wording and its tables become records on the phone", async ({ page }) => {
  await login(page, "reporter", "en"); await page.goto("/en/earnings");
  const banner = page.getByTestId("sandbox-banner"); await expect(banner).toContainText(en.store.cartPage.sandbox); await expect(banner).toContainText(en.money.sandbox);
  await expect(page.getByRole("region", { name: "USD" }).locator(".kpi")).toHaveCount(4); await expect(page.getByText(en.earnings.formula)).toBeVisible();
  await page.setViewportSize({ width: 1280, height: 800 }); expect(await noSideScroll(page)).toBe(true);
  await page.setViewportSize({ width: 375, height: 812 }); expect(await noSideScroll(page)).toBe(true);
  await expect(page.getByTestId("entry-row").first().locator("td").first()).toHaveCSS("display", "flex");
  await page.screenshot({ path: ".artifacts/earnings-375-en.png", fullPage: true });
});

test("the full notifications page follows W10: all, mine and store tabs with an empty-tab state", async ({ page }) => {
  const t = ar.notice; await login(page, "reviewer"); await page.goto("/ar/notifications");
  const tabs = page.getByRole("navigation", { name: t.tabsLabel }); await expect(tabs.getByRole("button")).toHaveCount(3);
  await expect(page.getByTestId("notification")).toHaveCount(3);
  await tabs.getByRole("button", { name: new RegExp(`^${t.pageTabs.store}`) }).click();
  await expect(page.getByTestId("notification")).toHaveCount(0); await expect(page.getByText(t.emptyTab)).toBeVisible();
  await page.setViewportSize({ width: 375, height: 812 }); await tabs.getByRole("button", { name: new RegExp(`^${t.pageTabs.all}`) }).click();
  await expect(page.getByTestId("notification")).toHaveCount(3); expect(await noSideScroll(page)).toBe(true);
});

test("W9 ready archive: published cards, search with E4 and removable chips, period chips, at 1280 and 375", async ({ page, request }) => {
  const t = ar.archive, w = ar.shell.inbox; await request.post(`${api}/__test/published`);
  await login(page, "reviewer"); await page.setViewportSize({ width: 1280, height: 800 });
  await page.getByTestId("sidebar").getByRole("link", { name: t.nav }).click(); await expect(page).toHaveURL(/\/ar\/archive$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(t.title);
  const cards = page.getByTestId("archive-card"); await expect(cards).toHaveCount(5);
  await expect(cards.filter({ has: page.locator(".badge.sensitive") })).toHaveCount(1); await expect(page.locator("main")).not.toContainText("never-display-canary");
  await page.getByRole("navigation", { name: t.chipsLabel }).getByRole("button", { name: t.periods.week }).click(); await expect(cards).toHaveCount(4);
  await page.getByLabel(t.search).fill("بحث تجريبي"); await page.getByRole("button", { name: t.searchButton, exact: true }).click();
  const empty = page.getByTestId("archive-no-results"); await expect(empty).toContainText(t.noResultsFor.replace("{q}", "بحث تجريبي"));
  await expect(page.getByRole("list", { name: w.activeFilters }).getByRole("button", { name: w.removeFilter.replace("{filter}", t.periods.week) })).toBeVisible();
  await empty.getByRole("button", { name: t.showAll.replace("{n}", "5") }).click(); await expect(cards).toHaveCount(5);
  expect(await noSideScroll(page)).toBe(true); await page.screenshot({ path: ".artifacts/archive-1280-ar.png" });
  await page.setViewportSize({ width: 375, height: 812 }); expect(await noSideScroll(page)).toBe(true);
  await expect(page.getByRole("navigation", { name: ar.shell.bottomNav }).getByRole("link", { name: t.nav })).toBeVisible();
  await page.screenshot({ path: ".artifacts/archive-375-ar.png", fullPage: true });
});

test("the archive is not a reporter destination, and a direct visit says the role (E5)", async ({ page }) => {
  await login(page, "reporter"); await expect(page.getByRole("link", { name: ar.archive.nav })).toHaveCount(0);
  await page.goto("/ar/archive"); await expect(page.getByTestId("no-access")).toContainText(ar.archive.denied);
});

test("S5 invite: the token from the link, a 12-character password, then TOTP; the same link again is S5b", async ({ page }) => {
  const t = ar.store.invite, token = "synthetic-invite-token-member-0001";
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(`/ar/invite#token=${token}`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(t.title); await expect(page.getByLabel(t.token)).toHaveCount(0);
  await expect(page).toHaveURL(/\/ar\/invite$/);
  await page.getByLabel(t.newPassword).fill("short"); await page.getByLabel(t.repeatPassword).fill("short"); await page.getByRole("button", { name: t.submit }).click();
  await expect(page.getByText(t.passwordShort)).toBeVisible();
  await page.getByLabel(t.newPassword).fill("synthetic-pass-12"); await page.getByLabel(t.repeatPassword).fill("synthetic-pass-12"); await page.getByRole("button", { name: t.submit }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(t.totpTitle); await expect(page.getByTestId("totp-secret")).toHaveText("AAAA BBBB CCCC DDDD EEEE FFFF");
  expect(await noSideScroll(page)).toBe(true); await page.screenshot({ path: ".artifacts/invite-totp-375-ar.png" });
  await page.getByLabel(t.code).fill("000000"); await page.getByRole("button", { name: t.confirm }).click(); await expect(page.getByText(t.codeWrong)).toBeVisible();
  await page.getByLabel(t.code).fill("123456"); await page.getByRole("button", { name: t.confirm }).click(); await expect(page).toHaveURL(/\/ar\/store$/);
  await expect(page.getByTestId("catalog-card")).toHaveCount(2);
  await page.context().clearCookies(); await page.goto(`/ar/invite#token=${token}`);
  await page.getByLabel(t.newPassword).fill("synthetic-pass-12"); await page.getByLabel(t.repeatPassword).fill("synthetic-pass-12"); await page.getByRole("button", { name: t.submit }).click();
  await expect(page.getByTestId("invite-invalid")).toContainText(t.invalidTitle); await expect(page.getByRole("link", { name: t.signIn })).toHaveAttribute("href", "/ar/login");
});

test("S5 without a link asks for the code, in English and at 1280", async ({ page }) => {
  const t = en.store.invite; await page.setViewportSize({ width: 1280, height: 800 }); await page.goto("/en/invite");
  await expect(page.getByLabel(t.token)).toBeVisible(); await page.getByLabel(t.token).fill("short");
  await page.getByLabel(t.newPassword).fill("synthetic-pass-12"); await page.getByLabel(t.repeatPassword).fill("synthetic-pass-12"); await page.getByRole("button", { name: t.submit }).click();
  await expect(page.getByText(t.tokenInvalid)).toBeVisible(); expect(await noSideScroll(page)).toBe(true);
  await expect(page.locator(".public-shell")).toHaveAttribute("data-mode", "dark");
});

test("S6: a pending organization sees its verification card instead of the catalog, without its legal name", async ({ page }) => {
  const t = ar.store.org; await login(page, "pendingbuyer"); await page.goto("/ar/store");
  const card = page.getByTestId("org-pending"); await expect(card).toBeVisible(); await expect(card).toContainText(t.pendingTitle); await expect(card).toContainText(t.checkRegistry);
  await expect(card.getByRole("link", { name: t.invite })).toHaveAttribute("href", "/ar/organization");
  await expect(page.getByTestId("catalog-card")).toHaveCount(0); await expect(page.locator("main")).not.toContainText("never-display-canary");
  await page.setViewportSize({ width: 375, height: 812 }); expect(await noSideScroll(page)).toBe(true);
});

for (const locale of ["ar", "en"] as Locale[]) test(`P2 and P3 follow the public frame, at 1280 and 375 (${locale})`, async ({ page }) => {
  const v = (locale === "ar" ? ar : en).licenses.verify;
  for (const width of [1280, 375]) {
    await page.setViewportSize({ width, height: 800 });
    await page.goto(`/${locale}/verify/PH-2026-7K3M9Q2XRT`); await expect(page.getByTestId("verification")).toContainText(v.ends); expect(await noSideScroll(page)).toBe(true);
    await page.goto(`/${locale}/verify/PH-2026-0000000000`); await expect(page.getByRole("heading", { level: 1 })).toHaveText(v.notFound); expect(await noSideScroll(page)).toBe(true);
  }
  await page.screenshot({ path: `.artifacts/verify-p3-375-${locale}.png` });
});
