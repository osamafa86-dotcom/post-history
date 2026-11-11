import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { fillNodes, Ltr, Money } from "../src/components/money";
import { dateLocale, governorateName, numberLocale } from "../src/lib/format";
import { formatDate, longDate } from "../src/lib/i18n";
import ar from "../messages/ar.json";
import en from "../messages/en.json";

const sources = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? sources(join(dir, entry.name)) : /\.tsx?$/.test(entry.name) ? [join(dir, entry.name)] : []);
const texts = (value: unknown): string[] => typeof value === "string" ? [value] : value && typeof value === "object" ? Object.values(value).flatMap(texts) : [];
const usd = (amount_minor: number) => ({ amount_minor, currency: "USD" as const });

describe("an amount inside a sentence", () => {
  it("is isolated left to right, so the currency sign stays on its side in Arabic", () => {
    const limits = renderToStaticMarkup(<p>{fillNodes(ar.earnings.limits, { min: <Money price={usd(5000)} locale="ar" />, max: <Money price={usd(27000)} locale="ar" /> })}</p>);
    expect(limits.match(/<bdi dir="ltr"/g)).toHaveLength(2);
    // لا رقم خارج عنصر العزل: ما يبقى بعد حذف العناصر المعزولة نص القالب وحده.
    expect(limits.replace(/<bdi dir="ltr"[^>]*>[^<]*<\/bdi>/g, "")).not.toMatch(/\d/);
    const refunded = renderToStaticMarkup(<p>{fillNodes(ar.buyers.refundedPart, { amount: <Money price={usd(12000)} locale="ar" /> })}</p>);
    expect(refunded).toMatch(/<bdi dir="ltr"[^>]*>[^<]*120\.00[^<]*<\/bdi>/);
    expect(renderToStaticMarkup(<Ltr>2 / 3</Ltr>)).toBe('<bdi dir="ltr">2 / 3</bdi>');
  });
  it("is never pasted into a template as plain text", () => {
    const pasted = sources(join(__dirname, "../src")).filter(file => /replace\("\{[a-zA-Z]+\}",\s*(formatMoney|plainAmount|money)\(|fill\([^)]*:\s*(formatMoney|plainAmount|money)\(/.test(readFileSync(file, "utf8")));
    expect(pasted).toEqual([]);
  });
});

describe("dates and numbers", () => {
  it("take a locale with pinned digits, never the bare interface locale", () => {
    expect(numberLocale("ar")).toBe("ar-u-nu-latn"); expect(dateLocale("ar")).toBe("ar-PS-u-nu-latn"); expect(numberLocale("en")).toBe("en"); expect(dateLocale("en")).toBe("en");
    const bare = sources(join(__dirname, "../src")).filter(file => /new Intl\.\w+\(\s*locale\s*[,)]/.test(readFileSync(file, "utf8")));
    expect(bare).toEqual([]);
  });
  it("write a date and time one way: long date, then the hour out of 24, in Latin digits", () => {
    const at = "2026-10-19T12:00:00Z", arabic = formatDate(at, "ar"), english = formatDate(at, "en");
    expect(arabic).toMatch(/^\d{1,2} تشرين الأول 2026، \d{2}:\d{2}$/); expect(english).toMatch(/^October \d{1,2}, 2026, \d{2}:\d{2}$/);
    expect(arabic.startsWith(longDate(at, "ar"))).toBe(true);
    for (const text of [arabic, english]) expect(text).not.toMatch(/[\u0660-\u0669\u200e\u200f]|AM|PM|ص$|م$/);
  });
  it("use Latin digits and the Latin percent sign in every Arabic message", () => {
    expect(texts(ar).filter(text => /[\u0660-\u0669\u066a]/.test(text))).toEqual([]);
    expect(ar.licenses.deliverySize).toContain("ميغابايت");
  });
});

describe("a governorate in the store", () => {
  it("reads in the interface language, and stays as sent when it is not in the table", () => {
    expect(governorateName("غزة", en.governorates)).toBe("Gaza"); expect(governorateName(" دير البلح ", en.governorates)).toBe("Deir al-Balah");
    expect(governorateName("غزة", ar.governorates)).toBe("غزة"); expect(governorateName("محافظة تجريبية", en.governorates)).toBe("محافظة تجريبية");
    expect(Object.keys(en.governorates)).toEqual(Object.keys(ar.governorates));
    for (const name of ["القدس", "رام الله والبيرة", "بيت لحم", "الخليل", "أريحا والأغوار", "نابلس", "جنين", "طولكرم", "قلقيلية", "سلفيت", "طوباس", "شمال غزة", "غزة", "دير البلح", "خان يونس", "رفح"]) expect(en.governorates[name as keyof typeof en.governorates]).toMatch(/^[A-Z][A-Za-z\- ]+$/);
  });
});
