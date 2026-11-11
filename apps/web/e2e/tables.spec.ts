import { expect, test, type Locator, type Page } from "@playwright/test";
import ar from "../messages/ar.json" with { type: "json" };
import en from "../messages/en.json" with { type: "json" };

async function signIn(page: Page, role: string, locale: "ar" | "en" = "ar") {
  const m = locale === "ar" ? ar : en;
  await page.goto(`/${locale}/login`); await page.getByLabel(m.email).fill(`${role}@example.test`); await page.getByLabel(m.password, { exact: true }).fill("synthetic-password"); await page.getByLabel(m.totp, { exact: true }).fill("123456");
  await page.getByRole("button", { name: m.signIn, exact: true }).click(); await page.waitForURL(url => !url.pathname.endsWith("/login"));
}
test.beforeEach(async ({ request }) => { await request.post("http://127.0.0.1:3201/__test/reset"); });

/** لكل عمود رقمي: تفاوت الحافة اليمنى لنصوص خلاياه (صفر حين تتراصّ الآحاد)، وهل أرقامه جدولية. */
const numericColumns = (table: Locator) => table.evaluate(node => {
  const rows = [...node.querySelectorAll("tbody tr")], heads = [...node.querySelectorAll("thead th")];
  return heads.map((head, i) => ({ head, i })).filter(({ head }) => head.classList.contains("num")).map(({ head, i }) => {
    const cells = rows.map(row => row.children[i] as HTMLElement), edges = cells.map(cell => { const range = document.createRange(); range.selectNodeContents(cell); return range.getBoundingClientRect().right; });
    return { name: head.textContent, spread: Math.round(Math.max(...edges) - Math.min(...edges)), tabular: cells.every(cell => getComputedStyle(cell).fontVariantNumeric.includes("tabular-nums")), headRight: Math.round(Math.abs(head.getBoundingClientRect().right - cells[0].getBoundingClientRect().right)) };
  });
});
/** خلايا الصف الأول المتكدّس التي تعرض قيمة بلا تسمية (العنوان الرئيسي للصف وخلية الأفعال لا تحتاجان تسمية). */
const unlabelled = (table: Locator) => table.evaluate(node => {
  const row = node.querySelector("tbody tr"); if (!row) return ["no row"];
  return [...row.children].filter(cell => cell.textContent?.trim() && !cell.classList.contains("cell-primary") && !cell.classList.contains("cell-actions") && !cell.classList.contains("cell-action") && getComputedStyle(cell).display !== "table-cell" && getComputedStyle(cell, "::before").content === "none").map(cell => cell.textContent!.trim().slice(0, 24));
});

test("money tables stack units under units, in tabular figures, each under its own name", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 }); await signIn(page, "finance"); await page.goto("/ar/payouts");
  await expect(page.getByTestId("payout-row")).toHaveCount(2); await expect(page.getByTestId("policy-row")).toHaveCount(3);
  for (const name of [ar.money.tableTitle, ar.payouts.title, ar.payouts.policies]) {
    const table = page.getByRole("table", { name, exact: true }); await expect(table).toBeVisible();
    const columns = await numericColumns(table); expect(columns.length, name).toBeGreaterThan(0);
    for (const column of columns) { expect(column.spread, `${name}: ${column.name}`).toBeLessThanOrEqual(1); expect(column.tabular, `${name}: ${column.name}`).toBe(true); expect(column.headRight, `${name}: ${column.name} header`).toBeLessThanOrEqual(1); }
  }
  // صف طلب الصرف سطر واحد: الفعلان زرّان، والسبب في الحوار.
  for (const row of await page.getByTestId("payout-row").all()) expect((await row.boundingBox())!.height).toBeLessThanOrEqual(64);
  // المعادلة مطويّة في رأس الجدول وتُفتح عند الطلب.
  const formula = page.getByTestId("money-formula"); await expect(formula.locator("p")).toBeHidden(); await formula.locator("summary").click(); await expect(formula.locator("p")).toBeVisible();
  await page.goto("/en/payouts"); await expect(page.getByTestId("payout-row")).toHaveCount(2);
  for (const column of await numericColumns(page.getByRole("table", { name: en.money.tableTitle, exact: true }))) expect(column.spread, column.name ?? "").toBeLessThanOrEqual(1);
});

for (const locale of ["ar", "en"] as const) {
  test(`stacked tables on a phone name every value and keep their actions on screen (${locale})`, async ({ page, context }) => {
    const m = locale === "ar" ? ar : en; await page.setViewportSize({ width: 390, height: 844 });
    const inside = async (target: Locator) => { const box = (await target.boundingBox())!; expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(390); };
    const sideways = () => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    await signIn(page, "finance", locale); await page.goto(`/${locale}/payouts`); await expect(page.getByTestId("payout-row")).toHaveCount(2);
    const payouts = page.getByRole("table", { name: m.payouts.title, exact: true }); expect(await unlabelled(payouts)).toEqual([]);
    // المبلغ والحالة في السطر الأول من بطاقة الصف.
    const first = page.getByTestId("payout-row").first(), top = async (cell: Locator) => (await cell.boundingBox())!.y;
    expect(await top(first.locator("td.num.lead"))).toBeLessThan(await top(first.locator("td").first()));
    await inside(first.getByRole("button", { name: m.payouts.reject, exact: true })); expect(await unlabelled(page.getByRole("table", { name: m.payouts.policies, exact: true }))).toEqual([]);
    await page.goto(`/${locale}/commission-rules`); await expect(page.getByTestId("commission-row").first()).toBeVisible();
    expect(await unlabelled(page.getByRole("table", { name: m.commission.title, exact: true }))).toEqual([]); expect(await sideways()).toBeLessThanOrEqual(0);
    await context.clearCookies(); await signIn(page, "admin", locale);
    await page.goto(`/${locale}/license-templates`); await expect(page.getByTestId("template-row").first()).toBeVisible();
    expect(await unlabelled(page.getByRole("table", { name: m.templates.title, exact: true }))).toEqual([]);
    await page.goto(`/${locale}/invite-conflicts`); await expect(page.getByTestId("conflict-row").first()).toBeVisible();
    expect(await unlabelled(page.getByRole("table", { name: m.conflicts.title, exact: true }))).toEqual([]);
    // المؤسسة باسمها، لا بمعرّفها.
    await expect(page.getByTestId("conflict-organization").first()).not.toHaveText(/[0-9a-f]{8}-[0-9a-f]{4}-/);
    await context.clearCookies(); await signIn(page, "buyeradmin", locale);
    await page.goto(`/${locale}/organization`); const member = page.getByTestId("member-row").first(); await expect(member).toBeVisible();
    expect(await unlabelled(page.getByRole("table", { name: m.buyers.members, exact: true }))).toEqual([]);
    await inside(member.getByRole("combobox")); await inside(page.getByTestId("member-row").filter({ has: page.getByRole("button") }).first().getByRole("button")); expect(await sideways()).toBeLessThanOrEqual(0);
  });
}
