import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import PrivacyPage from "../src/app/[locale]/privacy/page";
import { messages } from "../src/lib/i18n";

describe("public privacy placeholder", () => {
  for (const locale of ["ar", "en"] as const) it(locale, async () => {
    const html = renderToStaticMarkup(await PrivacyPage({ params: Promise.resolve({ locale }) }));
    expect(html).toContain(messages[locale].privacy.temporary);
    expect(html).toContain(`dir="${locale === "ar" ? "rtl" : "ltr"}"`);
    expect(html).toContain(`href="/${locale === "ar" ? "en" : "ar"}/privacy"`);
  });
});
