import { expect, test, type Page } from "@playwright/test";
import ar from "../messages/ar.json" with { type: "json" };
import en from "../messages/en.json" with { type: "json" };
const r = ar.review, l = ar.licenses, first = "20000000-0000-4000-8000-000000000001", revoked = "93000000-0000-4000-8000-000000000002", order = "92000000-0000-4000-8000-000000000001";
async function login(page: Page, role: string, locale: "ar" | "en" = "ar") {
  const m = locale === "ar" ? ar : en;
  await page.goto(`/${locale}/login`); await page.getByLabel(m.email).fill(`${role}@example.test`); await page.getByLabel(m.password, { exact: true }).fill("synthetic-password"); await page.getByLabel(m.totp, { exact: true }).fill("123456"); await page.getByRole("button", { name: m.signIn, exact: true }).click(); await page.waitForURL(url => !url.pathname.endsWith("/login"));
}
const plural = (n: number, forms: Record<string, string>) => (forms[new Intl.PluralRules("ar").select(n)] ?? forms.other).replace("{n}", String(n));
/** يفتح حوار التحويل ويختار مسار الحقوق والهدف والسبب. */
async function choose(page: Page, to: "documented" | "sellable" | "blocked" | "withdrawn", reason: string) {
  const dialog = page.getByRole("dialog");
  if (!await dialog.isVisible()) await page.getByRole("button", { name: r.open, exact: true }).click();
  if (await dialog.getByRole("combobox", { name: r.track, exact: true }).count()) await dialog.getByRole("combobox", { name: r.track, exact: true }).selectOption("rights");
  await dialog.getByRole("radio", { name: ar.states.rights_state[to] }).check(); await dialog.getByLabel(r.reason, { exact: true }).fill(reason);
  return dialog;
}
const state = (page: Page) => page.locator(".state-grid [data-track='rights_state']");
test.beforeEach(async ({ request }) => { await request.post("http://127.0.0.1:3201/__test/reset"); });

test("withdrawing the rights says how many paid licenses it revokes and for whom, asks twice, and finance then finds them unrefunded", async ({ page, context }) => {
  await login(page, "reviewer"); await page.goto(`/ar/materials/${first}`);
  // إلى «صالحة للترخيص»: لا إبطال، فلا تنبيه ولا تأكيد ثانٍ
  for (const to of ["documented", "sellable"] as const) {
    const dialog = await choose(page, to, "rights reviewed"); await expect(dialog.getByTestId("revocation-notice")).toHaveCount(0);
    await dialog.getByTestId("transition-submit").click(); await expect(state(page)).toHaveText(ar.states.rights_state[to]);
  }
  const dialog = await choose(page, "withdrawn", "contract ended");
  const notice = dialog.getByTestId("revocation-notice"); await expect(notice).toHaveAttribute("data-state", "some");
  await expect(notice).toContainText(r.revokeEffect.replace("{licenses}", plural(1, r.revokeLicenses)).replace("{organizations}", plural(1, r.revokeOrganizations))); await expect(notice).toContainText(r.revokeFinal);
  await expect(dialog.locator("label.choice.selected")).toContainText(r.consequences.withdrawn); await expect(dialog).not.toContainText("never-display-canary");
  // الضغطة الأولى تسلّح، والثانية تنفّذ
  const submit = dialog.getByTestId("transition-submit"); await expect(submit).toHaveText(r.confirmTo.replace("{state}", ar.states.rights_state.withdrawn)); await expect(dialog.getByTestId("revoke-help")).toHaveText(r.revokeHelp);
  await submit.click(); await expect(submit).toHaveText(r.confirmRevoke.replace("{state}", ar.states.rights_state.withdrawn)); await expect(submit).toHaveClass(/danger/);
  await expect(state(page)).toHaveText(ar.states.rights_state.sellable);
  await submit.click(); await expect(state(page)).toHaveText(ar.states.rights_state.withdrawn);

  // المالية: «أُبطلت لسبب حقوقي ولم تُسترد» تعرض الترخيص وتفتح طلبه
  await context.clearCookies(); await login(page, "finance"); await page.goto("/ar/store/licenses");
  await expect(page.getByTestId("refund-review")).toHaveCount(0);
  await page.getByTestId("unrefunded-toggle").getByRole("checkbox").check(); await expect(page.getByTestId("unrefunded-lead")).toHaveText(l.unrefundedLead);
  const rows = page.locator(".licenses-table tbody tr"); await expect(rows).toHaveCount(1); await expect(rows).toContainText(l.reasons.rights_withdrawn);
  await expect(rows.getByTestId("refund-review")).toHaveText(l.openOrder); await rows.getByTestId("refund-review").click(); await expect(page).toHaveURL(new RegExp(`/ar/store/orders/${order}$`));
  await expect(page.getByRole("region", { name: ar.refunds.title })).toBeVisible();
});

test("the dialog says nothing is revoked when no paid license is active, and never stays silent when it cannot count", async ({ page }) => {
  await login(page, "reviewer"); await page.goto(`/ar/materials/${first}`);
  for (const to of ["documented", "sellable"] as const) { const d = await choose(page, to, "rights reviewed"); await d.getByTestId("transition-submit").click(); await expect(state(page)).toHaveText(ar.states.rights_state[to]); }
  await page.route("**/api/bff/materials/*/active-licenses", route => route.fulfill({ json: { active_licenses: 0, organizations: 0 } }));
  let dialog = await choose(page, "blocked", "dispute");
  await expect(dialog.getByTestId("revocation-notice")).toHaveText(r.revokeNone); await expect(dialog.getByTestId("revoke-help")).toHaveCount(0);
  await page.keyboard.press("Escape"); await page.unroute("**/api/bff/materials/*/active-licenses");
  await page.route("**/api/bff/materials/*/active-licenses", route => route.fulfill({ status: 503, json: { code: "temporarily_unavailable" } }));
  dialog = await choose(page, "blocked", "dispute");
  await expect(dialog.getByTestId("revocation-notice")).toHaveText(r.revokeUnknown); await expect(dialog.getByTestId("revocation-notice")).toHaveAttribute("data-state", "unknown");
  const submit = dialog.getByTestId("transition-submit"); await submit.click(); await expect(submit).toHaveText(r.confirmRevoke.replace("{state}", ar.states.rights_state.blocked));
  await expect(state(page)).toHaveText(ar.states.rights_state.sellable);
});

test("the buyer has a bell in the store header: a revoked license and a changed order by their numbers, each opening its page", async ({ page, request }) => {
  const b = ar.shell.bell;
  await login(page, "buyeradmin"); await expect(page).toHaveURL(/\/ar\/store$/);
  const bell = page.getByRole("banner").getByRole("button", { name: new RegExp(`^${b.open}`) });
  await expect(bell).toBeVisible(); await expect(page.getByTestId("bell-count")).toHaveCount(0);
  await request.post("http://127.0.0.1:3201/__test/notices?for=buyer"); await page.reload();
  await expect(page.getByTestId("bell-count")).toHaveText("2"); await bell.click();
  const panel = page.getByTestId("notifications-panel"), items = panel.getByTestId("bell-item");
  await expect(panel.getByRole("tablist")).toHaveCount(0); await expect(panel.getByRole("link", { name: b.all })).toHaveCount(0);
  await expect(items).toHaveCount(2); await expect(panel).not.toContainText("never-display-canary");
  const license = items.filter({ hasText: b.buyer.licenseRevoked.replace("{number}", "PH-2026-4HJ8NP0WVZ") }), changed = items.filter({ hasText: b.buyer.orderChanged.replace("{number}", "ORD-2026-7K3M9Q2X") });
  await expect(license).toContainText(b.buyer.licenseRevokedText); await expect(license.getByRole("link")).toHaveAttribute("href", `/ar/store/licenses/${revoked}`);
  await expect(changed.getByRole("link")).toHaveAttribute("href", `/ar/store/orders/${order}`);
  // فتح البند يذهب إلى صفحته ويعلّمه مقروءًا
  await license.getByRole("link").click(); await expect(page).toHaveURL(new RegExp(`/ar/store/licenses/${revoked}$`)); await expect(page.getByTestId("license-status")).toHaveText(l.statuses.revoked);
  await expect(page.getByTestId("bell-count")).toHaveText("1");
  await page.setViewportSize({ width: 375, height: 800 }); await page.reload(); await expect(page.getByRole("banner").getByRole("button", { name: new RegExp(`^${b.open}`) })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
