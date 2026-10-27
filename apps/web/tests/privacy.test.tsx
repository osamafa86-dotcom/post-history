import { afterEach, describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import PrivacyPage from "../src/app/[locale]/privacy/page";
import { messages } from "../src/lib/i18n";
import { privacyContactEmail } from "../src/server/privacy-contact";

const locales = ["ar", "en"] as const;
const allText = (locale: (typeof locales)[number]) => {
  const m = messages[locale].privacy;
  return [m.title, m.temporary, m.body, ...m.sections.flatMap((s) => [s.heading, ...s.paragraphs])].join("\n");
};
const placeholders = (locale: (typeof locales)[number]) => allText(locale).match(/\[[^\]]+\]/g) ?? [];
const TEST_EMAIL = "privacy@example.com"; // example.com مسموح؛ لا بريد حقيقي في المستودع
const render = async (locale: (typeof locales)[number]) => renderToStaticMarkup(await PrivacyPage({ params: Promise.resolve({ locale }) }));
const withEmailToken = (text: string) => text.split("{email}");
const escape = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");

afterEach(() => { vi.unstubAllEnvs(); });

describe("public privacy policy page", () => {
  for (const locale of locales) it(`renders the policy with semantic sections in ${locale}`, async () => {
    const m = messages[locale].privacy;
    vi.stubEnv("PRIVACY_CONTACT_EMAIL", "");
    const html = await render(locale);
    expect(html).toContain(escape(m.temporary));
    expect(html).toContain(`dir="${locale === "ar" ? "rtl" : "ltr"}"`);
    expect(html).toContain(`lang="${locale}"`);
    expect(html).toContain(`href="/${locale === "ar" ? "en" : "ar"}/privacy"`);
    expect(html.match(/<h1[ >]/g)).toHaveLength(1);
    expect(html.match(/<h2[ >]/g)).toHaveLength(m.sections.length);
    for (const section of m.sections) {
      expect(html).toContain(`>${escape(section.heading)}</h2>`);
      for (const paragraph of section.paragraphs) {
        const parts = withEmailToken(paragraph).map(escape);
        expect(html).toContain(`>${parts.join(escape(m.emailPending))}</p>`);
      }
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

  it("leaves no owner-set placeholder in the resources", () => {
    for (const locale of locales) {
      expect(placeholders(locale)).toEqual([]);
      expect(allText(locale)).not.toMatch(/يحدده|يحددها|يحددهما|set by the owner/);
    }
  });

  it("states the owner's decisions in each locale's own format", () => {
    const text = { ar: allText("ar"), en: allText("en") };
    expect(text.ar).toContain("فلسطين بوست");
    expect(text.en).toContain("Palestine Post");
    expect(text.ar).toContain("1 تشرين الثاني/نوفمبر 2026");
    expect(text.en).toContain("1 November 2026");
    expect(text.ar).toContain("القانون الفلسطيني");
    expect(text.en).toContain("Palestinian law");
    for (const value of Object.values(text)) expect(value).toContain("GoDaddy");
  });

  it("states retention without inventing periods and keeps the backup sentence", () => {
    const retention = (locale: (typeof locales)[number]) => messages[locale].privacy.sections[9].paragraphs;
    expect(retention("ar").join("\n")).toContain("دون مدة حذف تلقائية");
    expect(retention("ar").join("\n")).toContain("حتى تنتهي مدة الاحتفاظ بها");
    expect(retention("en").join("\n")).toContain("no automatic deletion period");
    expect(retention("en").join("\n")).toContain("until their retention period ends");
    for (const locale of locales) expect(retention(locale).join("\n")).not.toMatch(/\d+\s*(يوم|أيام|شهر|أشهر|سنة|سنوات|days?|months?|years?)/i);
  });

  it("carries the email token in exactly one paragraph per locale, and no address", () => {
    for (const locale of locales) {
      const paragraphs = messages[locale].privacy.sections.flatMap((s) => s.paragraphs);
      expect(paragraphs.filter((p) => p.includes("{email}"))).toHaveLength(1);
      expect(allText(locale).match(/\{[^}]*\}/g)).toEqual(["{email}"]);
    }
  });

  it("shows the temporary banner and the neutral text when the env var is unset or empty", async () => {
    for (const value of [undefined, "", "   "]) for (const locale of locales) {
      vi.stubEnv("PRIVACY_CONTACT_EMAIL", value);
      expect(process.env.PRIVACY_CONTACT_EMAIL).toBe(value);
      const html = await render(locale), m = messages[locale].privacy;
      expect(html).toContain('role="note"');
      expect(html).toContain(escape(m.temporary));
      expect(html).toContain(escape(m.emailPending));
      expect(html).not.toContain("mailto:");
      expect(html).not.toContain("{email}");
    }
  });

  it("renders the env email as a mailto link without the banner, read at request time", async () => {
    for (const locale of locales) {
      vi.stubEnv("PRIVACY_CONTACT_EMAIL", "");
      expect(await render(locale)).toContain('role="note"');
      vi.stubEnv("PRIVACY_CONTACT_EMAIL", ` ${TEST_EMAIL} `);
      const html = await render(locale), m = messages[locale].privacy;
      expect(html).toContain(`<a href="mailto:${TEST_EMAIL}" dir="ltr">${TEST_EMAIL}</a>`);
      expect(html.match(/mailto:/g)).toHaveLength(1);
      expect(html).not.toContain('role="note"');
      expect(html).not.toContain(escape(m.temporary));
      expect(html).not.toContain(escape(m.emailPending));
      expect(html).not.toContain("{email}");
    }
  });

  it("never renders a malformed or injecting env value", async () => {
    for (const bad of ["not-an-email", "a@b", "a b@example.com", "a@example.com?bcc=x@example.com", '"><script>alert(1)</script>@example.com', "a@example.com,b@example.com", "<b@example.com>", `${"a".repeat(250)}@example.com`]) {
      expect(privacyContactEmail({ PRIVACY_CONTACT_EMAIL: bad })).toBeNull();
      vi.stubEnv("PRIVACY_CONTACT_EMAIL", bad);
      const html = await render("en");
      expect(html).not.toContain("mailto:");
      expect(html).not.toContain("<script>");
      expect(html).toContain('role="note"');
    }
    expect(privacyContactEmail({ PRIVACY_CONTACT_EMAIL: TEST_EMAIL })).toBe(TEST_EMAIL);
    expect(privacyContactEmail({})).toBeNull();
  });

  it("keeps the temporary banner saying only that the contact details are pending", () => {
    expect(messages.ar.privacy.temporary).toContain("تفاصيل التواصل بانتظار النشر");
    expect(messages.en.privacy.temporary).toContain("Contact details pending");
    for (const locale of locales) expect(messages[locale].privacy.temporary).not.toMatch(/owner|المالك|\[|\]/);
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
