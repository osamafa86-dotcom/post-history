import { test, expect } from "@playwright/test";
import ar from "../messages/ar.json" with { type: "json" };
import en from "../messages/en.json" with { type: "json" };

for (const [locale, m, direction] of [["ar", ar.privacy, "rtl"], ["en", en.privacy, "ltr"]] as const) {
  test(`public temporary privacy page ${locale}`, async ({ page }) => {
    await page.goto(`/${locale}/privacy`);
    await expect(page.getByRole("heading", { level: 1, name: m.title })).toBeVisible();
    await expect(page.getByRole("note")).toHaveText(m.temporary);
    await expect(page.locator("main")).toHaveAttribute("dir", direction);
    await expect(page.locator("html")).toHaveAttribute("lang", locale);
    await page.getByRole("link", { name: m.otherLanguage }).click();
    await expect(page).toHaveURL(new RegExp(`/${locale === "ar" ? "en" : "ar"}/privacy$`));
  });
}
