import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import PrivacyPage from "../src/app/[locale]/privacy/page";
import { messages } from "../src/lib/i18n";

const locales = ["ar", "en"] as const;
const allText = (locale: (typeof locales)[number]) => {
  const m = messages[locale].privacy;
  return [m.title, m.temporary, m.body, ...m.sections.flatMap((s) => [s.heading, ...s.paragraphs])].join("\n");
};
const placeholders = (locale: (typeof locales)[number]) => allText(locale).match(/\[[^\]]+\]/g) ?? [];
const escape = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");

describe("public privacy policy page", () => {
  for (const locale of locales) it(`renders the policy with semantic sections in ${locale}`, async () => {
    const m = messages[locale].privacy;
    const html = renderToStaticMarkup(await PrivacyPage({ params: Promise.resolve({ locale }) }));
    expect(html).toContain(escape(m.temporary));
    expect(html).toContain(`dir="${locale === "ar" ? "rtl" : "ltr"}"`);
    expect(html).toContain(`lang="${locale}"`);
    expect(html).toContain(`href="/${locale === "ar" ? "en" : "ar"}/privacy"`);
    expect(html.match(/<h1[ >]/g)).toHaveLength(1);
    expect(html.match(/<h2[ >]/g)).toHaveLength(m.sections.length);
    for (const section of m.sections) {
      expect(html).toContain(`>${escape(section.heading)}</h2>`);
      for (const paragraph of section.paragraphs) expect(html).toContain(`>${escape(paragraph)}</p>`);
    }
  });

  it("has the same section and paragraph structure in Arabic and English", () => {
    const { ar, en } = { ar: messages.ar.privacy, en: messages.en.privacy };
    expect(ar.sections.length).toBeGreaterThanOrEqual(10);
    expect(ar.sections).toHaveLength(en.sections.length);
    expect(ar.sections.map((s) => s.paragraphs.length)).toEqual(en.sections.map((s) => s.paragraphs.length));
    for (const locale of locales) for (const section of messages[locale].privacy.sections) {
      expect(section.heading.trim()).not.toBe("");
      expect(section.paragraphs.length).toBeGreaterThan(0);
      for (const paragraph of section.paragraphs) expect(paragraph.trim()).not.toBe("");
    }
  });

  it("marks every operator detail as an owner-set placeholder, identically in both languages", () => {
    const ar = placeholders("ar"), en = placeholders("en");
    expect(ar).toHaveLength(en.length);
    expect(new Set(ar).size).toBe(5);
    expect(new Set(en).size).toBe(5);
    for (const value of ar) expect(value).toContain("يحدد");
    for (const value of en) expect(value).toContain("set by the owner");
  });

  it("keeps the temporary banner saying the text awaits owner approval", () => {
    expect(messages.ar.privacy.temporary).toContain("اعتماد المالك");
    expect(messages.en.privacy.temporary).toContain("owner's approval");
  });

  it("states the documented data practices without inventing identifiers", () => {
    for (const locale of locales) {
      const text = allText(locale);
      expect(text).not.toMatch(/https?:\/\//i);
      expect(text).not.toMatch(/\b\d{1,3}(\.\d{1,3}){3}\b/);
      expect(text).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.]+/);
      expect(text).not.toMatch(/claude|anthropic|gemini|openai|gpt|codex|google|apple|stripe/i);
      expect(text).toContain("SHA-256");
      expect(text).toContain("APNs");
      expect(text).toContain("FCM");
    }
  });
});
