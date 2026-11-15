import { expect, test, type Page } from "@playwright/test";
import ar from "../messages/ar.json" with { type: "json" };
const r = ar.refunds, t = ar.earnings, mo = ar.money, p = ar.payouts, o = ar.orders;
async function login(page: Page, role: string) {
  await page.goto("/ar/login"); await page.getByLabel(ar.email).fill(`${role}@example.test`); await page.getByLabel(ar.password, { exact: true }).fill("synthetic-password"); await page.getByLabel(ar.totp, { exact: true }).fill("123456"); await page.getByRole("button", { name: ar.signIn, exact: true }).click();
  await page.waitForURL(url => !url.pathname.endsWith("/login"));
}
/** يعدّل ردّ الـBFF في الطريق كما لو أعاد الخادم الحقول الجديدة. */
const rewrite = <T,>(page: Page, url: string | RegExp, change: (data: T) => void) =>
  page.route(url, async route => { if (route.request().method() !== "GET") return route.fallback(); try { const response = await route.fetch(), data = await response.json() as T; change(data); await route.fulfill({ response, json: data }); } catch { /* غادرت الصفحة */ } });
const usd = (amount_minor: number) => ({ amount_minor, currency: "USD" });
const paidOrder = "92000000-0000-4000-8000-000000000009";
test.beforeEach(async ({ request }) => { await request.post("http://127.0.0.1:3201/__test/reset"); });

test("finance confirms a pending sandbox refund from the order, and the refunds read as cards on a phone", async ({ page }) => {
  await login(page, "finance");
  const pending = { id: "96000000-0000-4000-8000-000000000001", order_id: paidOrder, order_item_ids: [], amount: usd(15000), reason_code: "buyer_request", status: "pending", created_by: "91000000-0000-4000-8000-000000000002", created_at: "2026-11-01T10:00:00Z", completed_at: null, provider: "sandbox" };
  let confirmed = false;
  await page.route(`**/api/bff/orders/${paidOrder}/refunds`, route => route.request().method() === "GET" ? route.fulfill({ json: { items: [confirmed ? { ...pending, status: "succeeded", completed_at: "2026-11-02T10:00:00Z" } : pending] } }) : route.fallback());
  const sent = page.waitForRequest(req => req.url().endsWith(`/api/bff/orders/${paidOrder}/refunds/${pending.id}/sandbox-confirmation`) && req.method() === "POST");
  await page.route(`**/api/bff/orders/${paidOrder}/refunds/${pending.id}/sandbox-confirmation`, route => { confirmed = true; return route.fulfill({ json: { ...pending, status: "succeeded", completed_at: "2026-11-02T10:00:00Z" } }); });
  await page.goto(`/ar/store/orders/${paidOrder}`);
  await expect(page.getByText(r.sandboxHelp)).toBeVisible();
  await page.getByTestId("sandbox-confirm").click(); await sent;
  await expect(page.getByTestId("refund-row")).toContainText(r.statuses.succeeded); await expect(page.getByTestId("sandbox-confirm")).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await expect(page.getByTestId("refund-row").locator("td").first()).toBeVisible();
});

test("the money page shows what went back to buyers and what the platform bore, on a phone too, and exports them", async ({ page }) => {
  await login(page, "admin");
  await rewrite<{ totals: Record<string, unknown>[] }>(page, /\/api\/bff\/contributor-earnings(\?.*)?$/, data => { for (const total of data.totals) Object.assign(total, { refunded_to_buyers: usd(23000), borne_by_platform: usd(11646) }); });
  await page.goto("/ar/payouts");
  await expect(page.getByTestId("kpi-refunded")).toContainText("230.00"); await expect(page.getByTestId("kpi-borne")).toContainText("116.46");
  await expect(page.getByTestId("kpi-net-after")).toBeVisible();
  const download = page.waitForEvent("download"); await page.getByRole("button", { name: mo.export }).click();
  const csv = await (await download).createReadStream().then(async stream => { let text = ""; for await (const chunk of stream) text += chunk; return text; });
  expect(csv).toContain(mo.kpiRefunded); expect(csv).toContain("230.00"); expect(csv).toContain(mo.kpiBorne); expect(csv).toContain("116.46");
  await page.setViewportSize({ width: 390, height: 844 }); await page.reload();
  for (const id of ["kpi-refunded", "kpi-net-after", "kpi-share"]) await expect(page.getByTestId(id)).toBeVisible();
});

test("the reporter statement is one line per movement, says what a sale sold and when it is released, and the payout form refuses a third decimal", async ({ page }) => {
  await login(page, "reporter");
  const sale = { sold_at: "2026-11-01T10:00:00Z", items: [{ material_id: "20000000-0000-4000-8000-000000000001", title: "تقرير الميدان", license_type: "editorial_single", share: usd(7000) }] };
  const leg = (id: string, entry: string, kind: string, state: string, amount: number, extra: Record<string, unknown> = {}) => ({ id, entry_id: entry, kind, state, amount: usd(amount), reference_type: "order", reference_id: "92000000-0000-4000-8000-000000000001", occurred_at: "2026-11-01T10:00:00Z", sale: null, releases_at: null, ...extra });
  await page.route(/\/api\/bff\/me\/earnings\/entries(\?.*)?$/, route => route.fulfill({ json: { items: [leg("4", "rel", "release", "available", 7000), leg("3", "rel", "release", "pending", -7000), leg("2", "sale", "sale", "pending", 7000, { sale, releases_at: "2026-11-15T10:00:00Z" })], next_cursor: null } }));
  await page.goto("/ar/earnings");
  await expect(page.getByTestId("entry-row")).toHaveCount(2);
  // نوع الحركة بنصه كاملًا: «تحرير» جزء من اسم الترخيص «تحريري» في سطر البيعة
  const rowOf = (kind: string) => page.getByTestId("entry-row").filter({ has: page.getByText(kind, { exact: true }) }), saleRow = rowOf(t.kinds.sale);
  await expect(saleRow.getByTestId("entry-sale")).toContainText("تقرير الميدان"); await expect(saleRow.getByTestId("entry-sale")).toContainText(ar.store.licenseTypes.editorial_single);
  await expect(saleRow.getByTestId("entry-release")).toContainText(t.releasesOn.split("{date}")[0]);
  await expect(rowOf(t.kinds.release)).toContainText(t.fromState.replace("{state}", t.payable.pending));
  await expect(page.locator("main")).not.toContainText(/organization|buyer@|المشتري:/);
  await page.getByLabel(t.amount, { exact: true }).fill("100.555"); await page.getByRole("button", { name: t.request }).click();
  await expect(page.getByRole("alert").filter({ hasText: t.twoDecimals })).toBeVisible();
});

test("the invoice says what was refunded and its net; finance sees each order's organization and filters by it and by status", async ({ page }) => {
  await login(page, "finance");
  await page.route(`**/api/bff/orders/${paidOrder}/refunds`, route => route.request().method() === "GET" ? route.fulfill({ json: { items: [{ id: "96000000-0000-4000-8000-000000000002", order_id: paidOrder, order_item_ids: ["95000000-0000-4000-8000-000000000009"], amount: usd(10000), reason_code: "buyer_request", status: "succeeded", created_by: "91000000-0000-4000-8000-000000000002", created_at: "2026-11-01T10:00:00Z", completed_at: "2026-11-01T10:05:00Z" }] } }) : route.fallback());
  await page.goto(`/ar/store/orders/${paidOrder}/invoice`);
  await expect(page.getByTestId("invoice-refunded")).toContainText("-100.00"); await expect(page.getByTestId("invoice-net")).toBeVisible();
  await page.goto("/ar/store/orders");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(ar.store.nav.orders); await expect(page.getByText(o.staffLead)).toBeVisible();
  await expect(page.getByTestId("order-organization").first()).not.toBeEmpty();
  const filtered = page.waitForRequest(req => /\/api\/bff\/orders\?.*status=paid/.test(req.url()));
  await page.getByTestId("staff-filters").getByLabel(ar.staffFilters.status).selectOption("paid"); await filtered;
  await page.goto("/ar/store/licenses"); await expect(page.getByRole("heading", { level: 1 })).toHaveText(ar.licenses.issued);
});

test("a payout policy refuses a zero minimum and warns when the minimum is above the dual-approval limit", async ({ page }) => {
  await login(page, "admin"); await page.goto("/ar/payouts");
  await page.getByRole("button", { name: p.newPolicy }).click();
  await page.getByLabel(p.minimum, { exact: true }).fill("2000"); await page.getByLabel(p.dualAbove, { exact: true }).fill("1000");
  await expect(page.getByTestId("policy-dual-warning")).toHaveText(p.minimumAboveDual);
  await page.getByLabel(p.minimum, { exact: true }).fill("0"); await page.getByLabel(p.effectiveFrom).fill("2030-01-01T10:00");
  await page.getByRole("button", { name: p.savePolicy }).click(); await expect(page.getByRole("alert").filter({ hasText: p.invalid })).toBeVisible();
});
