import { expect, test, type Page } from "@playwright/test";
import ar from "../messages/ar.json" with { type: "json" };
import en from "../messages/en.json" with { type: "json" };

async function signIn(page: Page, role: string, locale: "ar" | "en" = "ar") {
  const m = locale === "ar" ? ar : en;
  await page.goto(`/${locale}/login`); await page.getByLabel(m.email).fill(`${role}@example.test`); await page.getByLabel(m.password, { exact: true }).fill("synthetic-password"); await page.getByLabel(m.totp, { exact: true }).fill("123456");
  await page.getByRole("button", { name: m.signIn, exact: true }).click(); await page.waitForURL(url => !url.pathname.endsWith("/login"));
}
async function inbox(page: Page, locale: "ar" | "en" = "ar") {
  await signIn(page, "reviewer", locale); if (!page.url().endsWith("/inbox")) await page.goto(`/${locale}/inbox`);
  await expect(page.getByTestId("material-row")).toHaveCount(50);
}
test.beforeEach(async ({ request }) => { await request.post("http://127.0.0.1:3201/__test/reset"); });

test("urgent material not yet received is one number: the alert, the counter and the rows its button lists, and receiving one lowers them together", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 }); await inbox(page);
  const alert = page.getByTestId("urgent-alert"), count = alert.getByTestId("urgent-count"), stat = page.getByTestId("stat-urgent");
  const tabs = page.getByRole("navigation", { name: ar.inboxTabs.label }), open = tabs.getByRole("button", { name: new RegExp(`^${ar.inboxTabs.urgent}`) });
  // الصفحة المحمّلة فيها عشر من الأربعين: الرقم ليس عدّ الصفحة.
  await expect(page.getByTestId("material-row").filter({ hasText: ar.states.priority.urgent })).toHaveCount(10);
  await expect(count).toHaveText("40"); await expect(stat.locator("strong")).toHaveText("40");
  await expect(alert.getByRole("heading")).toContainText(ar.shell.inbox.kpiUrgent); await expect(stat).toContainText(ar.shell.inbox.kpiUrgent);
  await expect(alert.getByTestId("urgent-since")).toHaveText(/\S/);
  await alert.getByRole("button", { name: ar.editor.showUrgent }).click(); await expect(page.getByTestId("material-row")).toHaveCount(40);
  // الاستلام يُنقص «لم يُستلم» في الموضعين، والعاجل المفتوح (لم يُنشر ولم يُرفض) باقٍ كما هو: عدّان باسمين.
  await page.getByTestId("material-row").first().getByRole("button", { name: new RegExp(`^${ar.shell.inbox.receive}`) }).click();
  await expect(count).toHaveText("39"); await expect(stat.locator("strong")).toHaveText("39"); await expect(page.getByTestId("material-row")).toHaveCount(39);
  await expect(open).toContainText("40");
});

for (const locale of ["ar", "en"] as const) {
  test(`on a phone the first material is on the first screen under one row of chips (${locale})`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 }); await inbox(page, locale); const m = locale === "ar" ? ar : en;
    await expect(page.getByTestId("urgent-alert")).toBeVisible();
    const box = async (selector: string) => (await page.locator(selector).first().boundingBox())!;
    const first = await box("[data-testid='material-row']");
    expect(first.y, "top of the first material").toBeLessThanOrEqual(300);
    expect(first.y + first.height, "the whole first material is above the bottom bar").toBeLessThanOrEqual((await box("[data-testid='bottombar']")).y);
    // صف رقاقات واحد: التبويبات ثم الأنواع بالتمرير الأفقي، والترتيب والمرشحات خلف «تصفية».
    const tab = await box(".inbox-tools .quick-tabs .chip"), type = await box("[data-testid='type-chips'] .chip");
    expect(type.y).toBe(tab.y);
    await expect(page.locator(".inbox-summary")).toHaveCount(0); await expect(page.locator(".sort-tools")).toBeHidden();
    const toggle = page.getByRole("button", { name: m.filters, exact: true }); await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await toggle.click(); await expect(toggle).toHaveAttribute("aria-expanded", "true"); await expect(page.locator(".sort-tools select")).toBeVisible(); await expect(page.getByLabel(m.governorate, { exact: true })).toBeVisible();
    // لا سطر بيانات يبدأ بفاصلة: شريط فاصل أول جزء في كل سطر خارج حدّ القصّ.
    const orphans = await page.locator(".row-meta").evaluateAll(metas => metas.reduce((count, meta) => {
      const rtl = getComputedStyle(meta).direction === "rtl", clip = /inset\(([^)]+)\)/.exec(getComputedStyle(meta).clipPath)?.[1].split(" ").map(parseFloat) ?? [0, 0, 0, 0];
      const cut = rtl ? clip[1] ?? clip[0] : clip[3] ?? clip[1] ?? clip[0], box = meta.getBoundingClientRect(), parts = [...meta.children].filter(part => part.getClientRects().length);
      return count + parts.filter((part, i) => {
        const at = part.getBoundingClientRect(); if (i > 0 && Math.abs(at.top - parts[i - 1].getBoundingClientRect().top) < 4) return false;
        const strip = parseFloat(getComputedStyle(part).paddingInlineStart) || 0, lead = rtl ? box.right - at.right : at.left - box.left;
        return getComputedStyle(part, "::before").content !== "none" && !(strip > 0 && lead + strip <= cut + 0.5);
      }).length;
    }, 0));
    expect(orphans).toBe(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  });
}

test("on a desktop the list starts in the upper half, with the counters once", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 }); await inbox(page, "en");
  const first = (await page.getByTestId("material-row").first().boundingBox())!;
  expect(first.y, "top of the first material").toBeLessThanOrEqual(420);
  await expect(page.locator(".inbox-summary")).toHaveCount(0); await expect(page.getByTestId("kpis").locator(".kpi")).toHaveCount(4);
});

test("a failed load says what failed where the list would be, with one way to try again", async ({ page }) => {
  await signIn(page, "reviewer");
  await page.route("**/api/bff/materials?*", route => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ code: "temporarily_unavailable" }) }));
  await page.goto("/ar/inbox"); const failed = page.getByTestId("inbox-error");
  await expect(failed).toBeVisible(); await expect(failed).toHaveAttribute("role", "alert");
  await expect(failed.getByRole("heading")).toHaveText(ar.shell.inbox.loadFailed); await expect(failed).toContainText(ar.shell.inbox.loadFailedBody);
  await expect(failed.getByRole("button")).toHaveCount(1); await expect(page.getByTestId("inbox-empty")).toHaveCount(0); await expect(page.getByTestId("material-row")).toHaveCount(0);
  expect(await failed.evaluate(node => !!node.closest(".inbox-list"))).toBe(true);
  await page.unroute("**/api/bff/materials?*"); await failed.getByRole("button", { name: ar.retry, exact: true }).click();
  await expect(page.getByTestId("material-row")).toHaveCount(50); await expect(page.getByTestId("inbox-error")).toHaveCount(0);
});

test("an empty list says so in the same pattern, with its next step and no page controls under it", async ({ page }) => {
  await signIn(page, "admin");
  await page.route("**/api/bff/notification-rules", route => route.request().method() === "GET" ? route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ items: [] }) }) : route.fallback());
  await page.goto("/ar/notification-rules"); const rules = page.getByTestId("rules-empty");
  await expect(rules).toBeVisible(); await expect(rules.getByRole("button", { name: ar.rules.new, exact: true })).toBeVisible();
  await page.route("**/api/bff/notifications?*", route => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ items: [], unread_count: 0, next_cursor: null }) }));
  await page.goto("/ar/notifications"); await expect(page.getByTestId("notifications-empty")).toBeVisible(); await expect(page.locator(".pagination")).toHaveCount(0);
});

test("a reporter with no materials yet is pointed to the desktop upload", async ({ page }) => {
  await signIn(page, "reporter");
  await page.route("**/api/bff/materials?*", route => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ items: [], next_cursor: null }) }));
  await page.goto("/ar/my-materials"); const empty = page.getByTestId("mine-empty");
  await expect(empty).toBeVisible(); await expect(empty.getByRole("link", { name: ar.upload.nav, exact: true })).toHaveAttribute("href", "/ar/upload");
});
