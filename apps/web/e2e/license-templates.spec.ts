import { expect, test, type Page } from "@playwright/test";
import ar from "../messages/ar.json" with { type: "json" };
import en from "../messages/en.json" with { type: "json" };
const t = ar.templates;
async function login(page: Page, role: string, locale: "ar" | "en" = "ar") {
  const m = locale === "ar" ? ar : en;
  await page.goto(`/${locale}/login`); await page.getByLabel(m.email).fill(`${role}@example.test`); await page.getByLabel(m.password, { exact: true }).fill("synthetic-password"); await page.getByLabel(m.totp, { exact: true }).fill("123456"); await page.getByRole("button", { name: m.signIn, exact: true }).click(); await expect(page.getByTestId("material-row")).toHaveCount(50);
}
test.beforeEach(async ({ request }) => { await request.post("http://127.0.0.1:3201/__test/reset"); });

test("the rights officer creates a bilingual template and writes a new version of another", async ({ page }) => {
  await login(page, "reviewer"); await page.getByRole("link", { name: t.nav, exact: true }).click();
  await expect(page.getByTestId("template-row")).toHaveCount(1);
  await page.getByLabel(t.showDisabled).check(); await expect(page.getByTestId("template-row")).toHaveCount(2);
  await page.getByRole("button", { name: t.new, exact: true }).click();
  await page.getByRole("combobox", { name: t.type, exact: true }).selectOption("exclusive_temporary");
  const group = (legend: string) => page.getByRole("group", { name: legend, exact: true });
  await group(t.name).getByLabel(t.arabic).fill("حصري مؤقت"); await group(t.name).getByLabel(t.english).fill("Temporary exclusive");
  await group(t.terms).getByLabel(t.arabic).fill("شروط الحصرية");
  await group(t.attribution).getByLabel(t.arabic).fill("فلسطين بوست"); await group(t.attribution).getByLabel(t.english).fill("Palestine Post");
  await expect(group(t.prohibitions).getByLabel(ar.templates.prohibitionNames.ai_training)).toBeDisabled();
  await page.getByLabel(t.price, { exact: true }).fill("900");
  await page.getByRole("button", { name: t.save, exact: true }).click(); await expect(page.getByRole("alert").filter({ hasText: t.invalid })).toBeVisible();
  await group(t.terms).getByLabel(t.english).fill("Exclusivity terms"); await page.getByRole("button", { name: t.save, exact: true }).click();
  await expect(page.getByTestId("template-row").filter({ hasText: "حصري مؤقت" })).toContainText("900");
  await page.getByTestId("template-row").filter({ hasText: "تحريري لاستخدام واحد" }).getByRole("button", { name: t.edit }).click();
  await expect(page.getByText(t.newVersion)).toBeVisible(); await expect(page.getByRole("combobox", { name: t.type, exact: true })).toBeDisabled();
  await page.getByLabel(t.price, { exact: true }).fill("175"); await page.getByRole("button", { name: t.save, exact: true }).click();
  const row = page.getByTestId("template-row").filter({ hasText: "تحريري لاستخدام واحد" }); await expect(row).toContainText("175"); await expect(row.locator("td").nth(3)).toHaveText("2");
  await expect(page.locator("main")).not.toContainText("never-display-canary");
  await page.screenshot({ path: ".artifacts/license-templates-ar.png", fullPage: true });
});
test("a stale version keeps the draft and the editor in chief reads without editing", async ({ page, context }) => {
  await login(page, "reviewer", "en"); await page.goto("/en/license-templates");
  await page.getByTestId("template-row").first().getByRole("button", { name: en.templates.edit }).click();
  await page.getByLabel(en.templates.price, { exact: true }).fill("200");
  // إصدار أحدث يُكتب من مكان آخر قبل الحفظ.
  await page.evaluate(async () => {
    const id = "81000000-0000-4000-8000-000000000001";
    const read = await fetch(`/api/bff/license-templates/${id}`, { headers: { "X-Requested-With": "post-history-web" } });
    const body = await read.json(); delete body.id; delete body.version; delete body.created_at; delete body.created_by;
    await fetch(`/api/bff/license-templates/${id}`, { method: "PUT", headers: { "Content-Type": "application/json", "X-Requested-With": "post-history-web", "Idempotency-Key": crypto.randomUUID(), "If-Match": read.headers.get("ETag")! }, body: JSON.stringify(body) });
  });
  await page.getByRole("button", { name: en.templates.save, exact: true }).click();
  await expect(page.getByText(en.review.changed)).toBeVisible(); await expect(page.getByLabel(en.templates.price, { exact: true })).toHaveValue("200");
  await context.clearCookies(); await login(page, "chief"); await page.goto("/ar/license-templates");
  await expect(page.getByText(t.readOnly)).toBeVisible(); await expect(page.getByRole("button", { name: t.new })).toHaveCount(0); await expect(page.getByRole("button", { name: t.edit })).toHaveCount(0);
});
