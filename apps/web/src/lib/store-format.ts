import type { Locale } from "./i18n";

// عرض المتجر (#203 بند 27). الأشكال بنيوية مطابقة لعقد v0.3 (#178): Money وLocalizedText؛ تُستبدل بالأنواع المولَّدة عند دمجه.
export type Localized = { ar: string; en: string };
export type Price = { amount_minor: number; currency: "USD" | "ILS" };

export const localized = (text: Localized, locale: Locale) => text[locale];

/** المبلغ من أصغر وحدة؛ العملتان المسموحتان بمنزلتين عشريتين. */
export function formatMoney(price: Price, locale: Locale) {
  return new Intl.NumberFormat(locale === "ar" ? "ar-u-nu-latn" : "en", { style: "currency", currency: price.currency }).format(price.amount_minor / 100);
}

/** المجاميع لكل عملة على حدة؛ لا تُجمع عملتان (ADR 0025). */
export function totals(prices: Price[]): Price[] {
  const sums = new Map<Price["currency"], number>();
  for (const price of prices) sums.set(price.currency, (sums.get(price.currency) ?? 0) + price.amount_minor);
  return [...sums].map(([currency, amount_minor]) => ({ currency, amount_minor }));
}

/** أرخص عرض بعملة واحدة لبطاقة الكتالوج؛ لا مقارنة بين عملتين. */
export function lowest(prices: Price[]): Price | null {
  if (!prices.length) return null;
  const currency = prices[0].currency;
  return prices.filter(p => p.currency === currency).reduce((a, b) => (b.amount_minor < a.amount_minor ? b : a));
}

export function formatDuration(ms: number | null) {
  if (ms === null) return null;
  const total = Math.round(ms / 1000), h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}
