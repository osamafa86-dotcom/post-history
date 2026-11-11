import { expect, test, type Page } from "@playwright/test";
import ar from "../messages/ar.json" with { type: "json" };
import en from "../messages/en.json" with { type: "json" };

async function signIn(page: Page, role: string, locale: "ar" | "en" = "ar") {
  const m = locale === "ar" ? ar : en;
  await page.goto(`/${locale}/login`); await page.getByLabel(m.email).fill(`${role}@example.test`); await page.getByLabel(m.password, { exact: true }).fill("synthetic-password"); await page.getByLabel(m.totp, { exact: true }).fill("123456");
  await page.getByRole("button", { name: m.signIn, exact: true }).click(); await page.waitForURL(url => !url.pathname.endsWith("/login"));
}
test.beforeEach(async ({ request }) => { await request.post("http://127.0.0.1:3201/__test/reset"); });

test("amounts inside Arabic sentences keep their currency sign on its side, and seats read as a count", async ({ page, context }) => {
  await signIn(page, "reporter"); await page.goto("/ar/earnings");
  const limits = page.getByTestId("payout-limits"); await expect(limits).toBeVisible();
  const amounts = limits.locator("bdi[dir='ltr']"); await expect(amounts).toHaveCount(2);
  // داخل العزل يُرسم المبلغ من اليسار: أول محرف فيه (رقم أو رمز العملة كما كتبه المنسّق) عند حافته اليسرى.
  for (const amount of await amounts.all()) {
    expect(await amount.evaluate(node => { const text = node.firstChild as Text, first = document.createRange(), last = document.createRange(), visible = text.data.replace(/[\u200e\u200f]/g, ""), start = text.data.indexOf(visible[0]), end = text.data.lastIndexOf(visible[visible.length - 1]); first.setStart(text, start); first.setEnd(text, start + 1); last.setStart(text, end); last.setEnd(text, end + 1); return first.getBoundingClientRect().left < last.getBoundingClientRect().left; })).toBe(true);
  }
  await context.clearCookies(); await signIn(page, "admin"); await page.goto("/ar/buyer-organizations");
  const pair = page.getByTestId("seats-pair").first(); await expect(pair).toHaveText(/^\d+ من \d+$/);
});

test("the English store names governorates in English and still filters by the value the server knows", async ({ page }) => {
  await signIn(page, "buyer", "en"); await page.goto("/en/store");
  const cards = page.getByTestId("catalog-card"); await expect(cards.first()).toBeVisible();
  await expect(cards.filter({ hasText: en.governorates["غزة"] }).first()).toBeVisible();
  const chip = page.getByRole("button", { name: en.governorates["غزة"], exact: true }); await expect(chip).toBeVisible();
  const asked = page.waitForRequest(request => request.url().includes("/catalog") && new URL(request.url()).searchParams.get("governorate") === "غزة");
  await chip.click(); await asked; await expect(chip).toHaveAttribute("aria-pressed", "true");
  await page.goto("/ar/store"); await expect(page.getByRole("button", { name: "غزة", exact: true })).toBeVisible();
});
