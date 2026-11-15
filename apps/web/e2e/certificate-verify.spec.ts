import { expect, test, type Page } from "@playwright/test";
import ar from "../messages/ar.json" with { type: "json" };
import en from "../messages/en.json" with { type: "json" };
const l = ar.licenses, v = l.verify, active = "PH-2026-7K3M9Q2XRT", revoked = "PH-2026-4HJ8NP0WVZ", expired = "PH-2026-9WQ3T6M1KD", license = "93000000-0000-4000-8000-000000000001";
async function login(page: Page, role: string, locale: "ar" | "en" = "ar") {
  const m = locale === "ar" ? ar : en;
  await page.goto(`/${locale}/login`); await page.getByLabel(m.email).fill(`${role}@example.test`); await page.getByLabel(m.password, { exact: true }).fill("synthetic-password"); await page.getByLabel(m.totp, { exact: true }).fill("123456"); await page.getByRole("button", { name: m.signIn, exact: true }).click();
}
const rewrite = <T,>(page: Page, url: string | RegExp, change: (data: T) => void) =>
  page.route(url, async route => { try { const response = await route.fetch(), data = await response.json() as T; change(data); await route.fulfill({ response, json: data }); } catch { /* غادرت الصفحة قبل الرد */ } });
test.beforeEach(async ({ request }) => { await request.post("http://127.0.0.1:3201/__test/reset"); });

test("a reader types the license number into one field, in any letter case, and lands on its canonical page", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto("/ar/verify");
  const lookup = page.getByTestId("verification-lookup"); await expect(lookup.getByRole("heading", { level: 1 })).toHaveText(v.title); await expect(lookup).toContainText(v.formLead);
  await expect(lookup.locator("input")).toHaveCount(1); expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await lookup.getByLabel(v.number).fill("  ph-2026 7k3m9q2xrt "); await lookup.getByRole("button", { name: v.formSubmit }).click();
  await expect(page).toHaveURL(new RegExp(`/ar/verify/${active}$`)); await expect(page.getByTestId("verification-status")).toHaveText(l.statuses.active);
  await expect(page.getByTestId("verification-lead")).toHaveText(v.lead); await expect(page.getByTestId("verification")).toContainText(v.noExpiry);
  // الرقم بحروف صغيرة في العنوان نفسه يتحوّل إلى صيغة الشهادة، والـBFF يقرؤه كذلك
  await page.goto(`/en/verify/${active.toLowerCase()}`); await expect(page).toHaveURL(new RegExp(`/en/verify/${active}$`)); await expect(page.getByTestId("verification-status")).toHaveText(en.licenses.statuses.active);
  const raw = await page.request.get(`/api/bff/license-verifications/${active.toLowerCase()}`); expect(raw.status()).toBe(200); expect((await raw.json()).license_number).toBe(active);
  // ما ليس رقم ترخيص يُقال عنه في النموذج نفسه ويبقى ما كُتب
  await page.goto("/ar/verify?number=hello"); await expect(page.getByTestId("verification-invalid")).toHaveText(v.formInvalid); await expect(page.getByLabel(v.number)).toHaveValue("hello");
  // الرقم غير الموجود يعيد القارئ إلى الإدخال
  await page.goto("/ar/verify/PH-2026-0000000000"); await expect(page.getByRole("heading", { level: 1 })).toHaveText(v.notFound);
  await page.getByTestId("verify-another").click(); await expect(page).toHaveURL(/\/ar\/verify$/); await expect(page.getByTestId("verification-lookup")).toBeVisible();
});

test("a revoked or expired license says it is no longer valid, with no «ends» line that reads as still running", async ({ page }) => {
  await page.goto(`/ar/verify/${revoked}`);
  const card = page.getByTestId("verification"); await expect(page.getByTestId("verification-status")).toHaveText(l.statuses.revoked);
  await expect(page.getByTestId("verification-lead")).toHaveText(v.leadRevoked); await expect(card).not.toContainText(v.noExpiry);
  await expect(card.locator("dt", { hasText: new RegExp(`^${v.ends}$`) })).toHaveCount(0); await expect(card).not.toContainText("قائم");
  await page.goto(`/ar/verify/${expired}`);
  await expect(page.getByTestId("verification-status")).toHaveText(l.statuses.expired); await expect(page.getByTestId("verification-lead")).toHaveText(v.leadExpired);
  await expect(card.locator("dt", { hasText: new RegExp(`^${v.ended}$`) })).toHaveCount(1); await expect(card).toContainText("2026"); await expect(card).not.toContainText(v.noExpiry);
  await expect(card).not.toContainText(/canary|Synthetic|worldwide/i);
});

test("the certificate names the licensee and the issuer, and prints as a light page with labels in both languages", async ({ page }) => {
  await login(page, "buyeradmin"); await expect(page).toHaveURL(/\/ar\/store$/); await page.goto(`/ar/store/licenses/${license}`);
  const certificate = page.getByTestId("certificate"); await expect(certificate).toBeVisible();
  await expect(page.getByTestId("certificate-licensee")).toHaveText("شبكة الأخبار الاصطناعية ذ.م.م"); await expect(page.getByTestId("certificate-issuer")).toHaveText(`${ar.brand} · ${ar.product}`);
  const number = certificate.locator("dt", { hasText: new RegExp(`^${l.number}$`) }), second = () => number.evaluate(element => getComputedStyle(element, "::after").content);
  const ink = () => certificate.locator("dd").first().evaluate(element => { const [r, g, b] = getComputedStyle(element).color.match(/\d+(\.\d+)?/g)!.map(Number); return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255; });
  // على الشاشة: لغة الواجهة وحدها، ووجه المتجر الداكن بحبره الفاتح
  expect(await second()).toBe("none"); await expect(certificate).not.toHaveAttribute("data-mode", "light"); expect(await ink()).toBeGreaterThan(0.6);
  // في الطباعة: ورقة فاتحة بحبر داكن، وكل عنوان بلغته ثم بالأخرى
  await page.emulateMedia({ media: "print" }); await page.evaluate(() => window.dispatchEvent(new Event("beforeprint")));
  await expect(certificate).toHaveAttribute("data-mode", "light"); expect(await ink()).toBeLessThan(0.3);
  expect(await second()).toContain(en.licenses.number); expect(await certificate.locator(".eyebrow").evaluate(element => getComputedStyle(element, "::after").content)).toContain(en.licenses.certificate);
  await expect(page.locator(".no-print").first()).toBeHidden();
  await page.evaluate(() => window.dispatchEvent(new Event("afterprint"))); await page.emulateMedia({ media: "screen" });
  await expect(certificate).not.toHaveAttribute("data-mode", "light"); expect(await second()).toBe("none");
  // الإنجليزية: فاصلة القوائم بلغتها
  await page.goto(`/en/store/licenses/${license}`); const english = page.getByTestId("certificate");
  await expect(english).toContainText("TV, Web"); await expect(english).toContainText("Resale, AI training"); await expect(english).not.toContainText("،");
  await expect(page.locator("main")).not.toContainText("never-display-canary");
});

test("a delivery package that takes too long says so and whom to write to; a fresh one only asks to come back", async ({ page }) => {
  type Issued = { id: string; delivery_ready: boolean; issued_at: string };
  await login(page, "buyeradmin"); await expect(page).toHaveURL(/\/ar\/store$/);
  await rewrite<Issued>(page, `**/api/bff/licenses/${license}`, data => { data.delivery_ready = false; });
  await rewrite<{ items: Issued[] }>(page, /\/api\/bff\/licenses(\?.*)?$/, data => { for (const item of data.items) if (item.id === license) item.delivery_ready = false; });
  await page.goto(`/ar/store/licenses/${license}`);
  const wait = page.getByTestId("delivery-wait"); await expect(wait).toHaveText(l.late); await expect(wait).toHaveAttribute("data-late", "true");
  await expect(page.getByRole("button", { name: l.download, exact: true })).toBeDisabled();
  await page.goto("/ar/store/licenses"); const late = page.getByTestId("delivery-late");
  await expect(late).toHaveText(l.lateShort); await expect(late).toHaveAttribute("href", `/ar/store/licenses/${license}`);
  // صدر للتو: «قيد التجهيز» بلا تأخر
  await page.unroute(`**/api/bff/licenses/${license}`);
  await rewrite<Issued>(page, `**/api/bff/licenses/${license}`, data => { data.delivery_ready = false; data.issued_at = new Date().toISOString(); });
  await page.goto(`/ar/store/licenses/${license}`); await expect(wait).toHaveText(l.preparing); await expect(wait).not.toHaveAttribute("data-late", "true");
});
