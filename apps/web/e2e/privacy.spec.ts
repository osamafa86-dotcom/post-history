import { test, expect } from "@playwright/test";
import ar from "../messages/ar.json" with { type: "json" };
import en from "../messages/en.json" with { type: "json" };

test("privacy policy has the same section count in both locales", () => {
  expect(ar.privacy.sections.length).toBeGreaterThanOrEqual(10);
  expect(ar.privacy.sections).toHaveLength(en.privacy.sections.length);
});

for (const [locale, m, direction] of [["ar", ar.privacy, "rtl"], ["en", en.privacy, "ltr"]] as const) {
  test(`public privacy policy page ${locale}`, async ({ page }) => {
    await page.goto(`/${locale}/privacy`);
    await expect(page.getByRole("heading", { level: 1, name: m.title })).toBeVisible();
    // خادم الاختبار يعمل بلا PRIVACY_CONTACT_EMAIL: الشريط ظاهر ونصّ «سيُنشر قريبًا» مكان البريد.
    await expect(page.getByRole("note")).toHaveText(m.temporary);
    await expect(page.locator('main a[href^="mailto:"]')).toHaveCount(0);
    await expect(page.locator("main")).toContainText(m.emailPending);
    await expect(page.locator("main")).toHaveAttribute("dir", direction);
    await expect(page.locator("html")).toHaveAttribute("lang", locale);
    await expect(page.locator("main h2")).toHaveCount(m.sections.length);
    await expect(page.locator("main h2").first()).toHaveText(m.sections[0].heading);
    await expect(page.locator("main h2").last()).toHaveText(m.sections[m.sections.length - 1].heading);
    await expect(page.locator("main section")).toHaveCount(m.sections.length);
    await page.getByRole("link", { name: m.otherLanguage }).click();
    await expect(page).toHaveURL(new RegExp(`/${locale === "ar" ? "en" : "ar"}/privacy$`));
    await expect(page.locator("main h2")).toHaveCount((locale === "ar" ? en : ar).privacy.sections.length);
  });
}
