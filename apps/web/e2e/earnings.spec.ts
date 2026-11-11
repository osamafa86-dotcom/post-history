import { expect, test, type Page } from "@playwright/test";
import ar from "../messages/ar.json" with { type: "json" };
import en from "../messages/en.json" with { type: "json" };
async function login(page: Page, role: string, locale: "ar" | "en" = "ar") {
  const m = locale === "ar" ? ar : en;
  await page.goto(`/${locale}/login`); await page.getByLabel(m.email).fill(`${role}@example.test`); await page.getByLabel(m.password, { exact: true }).fill("synthetic-password"); await page.getByLabel(m.totp, { exact: true }).fill("123456"); await page.getByRole("button", { name: m.signIn, exact: true }).click();
  // المالية لا تقرأ المواد: تهبط في الصرف، والبقية في الوارد.
  await expect(page).toHaveURL(new RegExp(`/${locale}/${role === "finance" ? "payouts" : role === "reporter" ? "my-materials" : "inbox"}$`));
}
test.beforeEach(async ({ request }) => { await request.post("http://127.0.0.1:3201/__test/reset"); });

test("a reporter reads balances and statement, requests a sandbox payout and cancels it", async ({ page }) => {
  const t = en.earnings; await login(page, "reporter", "en"); await page.getByRole("link", { name: t.nav, exact: true }).click();
  const usd = page.getByRole("region", { name: "USD" }); await expect(usd).toContainText("$300.00"); await expect(usd).toContainText("$270.00");
  await expect(page.getByTestId("entry-row")).toHaveCount(3); await expect(page.locator("main")).not.toContainText("never-display-canary");
  await page.getByRole("region", { name: t.entries }).getByLabel(t.state).selectOption("pending"); await expect(page.getByTestId("entry-row")).toHaveCount(1);
  const form = page.getByRole("region", { name: t.requestTitle }); await expect(form.getByTestId("payout-limits")).toContainText("$50.00");
  await form.getByLabel(t.amount).fill("280"); await form.getByRole("button", { name: t.request }).click(); await expect(form.getByText(t.invalid)).toBeVisible();
  await form.getByLabel(t.amount).fill("100"); await form.getByRole("button", { name: t.request }).click();
  const row = page.getByTestId("my-payout-row"); await expect(row).toHaveCount(1); await expect(row).toContainText(t.states.requested); await expect(row).toContainText("0/1");
  await expect(usd).toContainText("$200.00");
  await row.getByRole("button", { name: t.cancel }).click(); await expect(row).toContainText(t.states.cancelled); await expect(usd).toContainText("$300.00");
});

test("finance approves, rejects with a coded reason, reads balances; only the admin adds a policy", async ({ page, context }) => {
  const t = ar.payouts, e = ar.earnings; await login(page, "finance"); await page.getByRole("link", { name: t.nav, exact: true }).click();
  const rows = page.getByTestId("payout-row"); await expect(rows).toHaveCount(2); await expect(page.locator("main")).not.toContainText("never-display-canary");
  // الاعتماد لا يُرسل من الصف: حوار يسمّي المبلغ والمساهم وأيّ الاعتمادين هذا، و«تراجع» لا يرسل شيئًا.
  const dual = rows.filter({ hasText: t.dual }), dialog = page.getByTestId("payout-dialog"), sent: string[] = [];
  page.on("request", request => { if (request.method() === "POST" && /payout-requests\/[^/]+\/(approve|reject)$/.test(request.url())) sent.push(request.url()); });
  await dual.getByRole("button", { name: t.approve, exact: true }).click(); await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("heading")).toContainText((await dual.locator("td.num").first().innerText()).trim());
  await expect(dialog.getByTestId("approval-step")).toHaveText(t.approvalStep.replace("{n}", "1").replace("{of}", "2"));
  await dialog.getByRole("button", { name: t.back, exact: true }).click(); await expect(dialog).toHaveCount(0); await expect(dual).toContainText("0/2"); expect(sent).toEqual([]);
  await dual.getByRole("button", { name: t.approve, exact: true }).click(); await dialog.getByRole("button", { name: t.confirmApprove, exact: true }).click();
  await expect(dialog).toHaveCount(0); await expect(dual).toContainText("1/2"); expect(sent).toHaveLength(1);
  await expect(dual.getByRole("button", { name: t.approve, exact: true })).toHaveCount(0);
  // الرفض حوار بسبب مرمّز، لا قائمة داخل الصف: الصف سطر واحد من الأزرار.
  const single = rows.filter({ hasNotText: t.dual }); await expect(single.locator("select")).toHaveCount(0);
  await single.getByRole("button", { name: t.reject, exact: true }).click(); await expect(dialog.getByTestId("approval-step")).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: t.confirmReject, exact: true })).toBeDisabled();
  await dialog.getByLabel(t.reason).selectOption("documents_missing"); await dialog.getByRole("button", { name: t.confirmReject, exact: true }).click();
  await expect(rows).toHaveCount(1); expect(sent).toHaveLength(2);
  await page.getByLabel(e.state).selectOption("rejected"); await expect(rows).toContainText(e.reasons.documents_missing);
  await rows.getByRole("button", { name: new RegExp(t.balances) }).click(); await expect(page.getByRole("region", { name: new RegExp(t.balancesOf) })).toContainText(e.noBalance);
  const policies = page.getByRole("region", { name: t.policies }); await expect(policies.getByTestId("policy-row")).toHaveCount(3);
  await expect(policies.getByTestId("policy-row").filter({ hasText: "20%" })).toContainText(t.superseded);
  await expect(policies.getByText(t.policyReadOnly)).toBeVisible(); await expect(policies.getByRole("button", { name: t.newPolicy })).toHaveCount(0);
  await page.screenshot({ path: ".artifacts/payouts-ar.png", fullPage: true });
  await context.clearCookies(); await login(page, "admin", "en"); await page.goto("/en/payouts");
  const p = en.payouts, adminPolicies = page.getByRole("region", { name: p.policies });
  await adminPolicies.getByRole("button", { name: p.newPolicy }).click(); await adminPolicies.getByLabel(p.reserve).fill("60"); await adminPolicies.getByRole("button", { name: p.savePolicy }).click();
  await expect(adminPolicies.getByText(p.invalid)).toBeVisible();
  await adminPolicies.getByLabel(p.reserve).fill("15"); await adminPolicies.getByLabel(p.effectiveFrom).fill("2099-01-01T00:00"); await adminPolicies.getByRole("button", { name: p.savePolicy }).click();
  await expect(adminPolicies.getByTestId("policy-row")).toHaveCount(4); await expect(adminPolicies.getByTestId("policy-row").filter({ hasText: "15%" })).toContainText(p.scheduled);
});

test("staff and reporters do not see each other's pages", async ({ page, context }) => {
  await login(page, "reporter"); await expect(page.getByRole("link", { name: ar.payouts.nav })).toHaveCount(0);
  await page.goto("/ar/payouts"); await expect(page.getByText(ar.payouts.denied)).toBeVisible();
  await context.clearCookies(); await login(page, "finance"); await expect(page.getByRole("link", { name: ar.earnings.nav })).toHaveCount(0);
});
