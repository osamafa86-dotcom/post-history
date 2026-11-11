import type { Locale } from "./i18n";

import type { components } from "@/generated/schema";
import { dateLocale } from "./format";
// عرض المتجر (#203 بندا 27–29): أنواع عقد v0.3 المولَّدة.
export type Localized = components["schemas"]["LocalizedText"];
export type Price = components["schemas"]["Money"];
export type CatalogItem = components["schemas"]["CatalogItem"];
export type LicenseType = components["schemas"]["LicenseType"];

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

/** يوم من العقد بلا ساعة أو تحويل منطقة زمنية؛ غياب الحقل لا يُستبدل بتاريخ مُستنتج. */
export function catalogDay(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value ? value : null;
}
/**
 * نوع الملف بكلمات القارئ بدل رمز MIME: صنفه (فيديو، صورة، صوت، ملف) واسم صيغته المعروف إن وُجد. ما لا يُعرف صنفه «ملف» بلا اسم.
 */
const formatNames: Record<string, string> = {
  "video/mp4": "MP4", "video/quicktime": "MOV", "video/webm": "WebM", "image/jpeg": "JPEG", "image/png": "PNG", "image/webp": "WebP",
  "audio/mpeg": "MP3", "audio/mp4": "M4A", "audio/wav": "WAV", "application/pdf": "PDF", "application/zip": "ZIP",
};
export function fileFormat(mime: string | null | undefined): { kind: "video" | "image" | "audio" | "file"; name: string | null } {
  const type = (mime ?? "").trim().toLowerCase().split(";")[0], family = type.split("/")[0];
  return { kind: family === "video" || family === "image" || family === "audio" ? family : "file", name: formatNames[type] ?? null };
}
export function formatDay(value: unknown, locale: Locale): string | null {
  const day = catalogDay(value);
  return day ? new Intl.DateTimeFormat(dateLocale(locale), { dateStyle: "medium", timeZone: "UTC" }).format(new Date(`${day}T00:00:00Z`)) : null;
}

/** يوم من العقد بتاريخ طويل («28 تشرين الأول 2026») بأرقام لاتينية وبلا ساعة، بالتسمية نفسها في `longDate`. */
export function longDay(value: unknown, locale: Locale): string | null {
  const day = catalogDay(typeof value === "string" ? value.slice(0, 10) : value);
  return day ? new Intl.DateTimeFormat(locale === "ar" ? "ar-PS-u-nu-latn" : "en", { dateStyle: "long", timeZone: "UTC" }).format(new Date(`${day}T00:00:00Z`)) : null;
}

/** المبلغ بمنزلتيه بلا رمز العملة، لخلايا عمود يحمل العملة في رأسه (S7). */
export function formatAmount(price: Price, locale: Locale) {
  return new Intl.NumberFormat(locale === "ar" ? "ar-u-nu-latn" : "en", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(price.amount_minor / 100);
}

// أرقام الطلب المقروءة (ADR 0100) بصيغها في العقد؛ يطابقها contract-drift.
export const orderNumberPattern = /^ORD-[0-9]{4}-[0-9A-HJKMNP-TV-Z]{8}$/;
export const invoiceNumberPattern = /^INV-[0-9]{4}-[0-9]{6,}$/;
export const purchaseOrderPattern = /^[A-Za-z0-9](?:[A-Za-z0-9 ._/#-]{0,62}[A-Za-z0-9])?$/;
export const purchaseOrderMax = 64;

/** ما يعرّف الطلب للمشتري: رقمه المقروء، وإن غاب (ردّ لم يحمله) فأول ثمانية من معرّفه كما في S7 قبل الرقم. */
export const orderLabel = (order: { id: string; order_number?: string | null }) => order.order_number ?? order.id.slice(0, 8).toUpperCase();
