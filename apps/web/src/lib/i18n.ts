import ar from "../../messages/ar.json";
import en from "../../messages/en.json";
export type Locale = "ar" | "en";
export const isLocale = (s: string): s is Locale => s === "ar" || s === "en";
export const messages = { ar, en };
export function formatDate(value: string | null | undefined, locale: Locale) {
  if (!value || !Number.isFinite(Date.parse(value))) return messages[locale].notAvailable;
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

/** التاريخ الطويل بأرقام لاتينية كما في تصاميم Figma («26 تشرين الأول 2026»)؛ العربية بتسمية الشام. */
export function longDate(value: string | null | undefined, locale: Locale) {
  if (!value || !Number.isFinite(Date.parse(value))) return messages[locale].notAvailable;
  return new Intl.DateTimeFormat(locale === "ar" ? "ar-PS-u-nu-latn" : "en", { dateStyle: "long" }).format(new Date(value));
}

/** الساعة والدقيقة (24 ساعة) بتوقيت الجهاز، أرقام لاتينية. */
export const shortTime = (value: string | null | undefined) => (value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false }) : "");

/** مدة بأكبر وحدة مناسبة بصيغة لغتها («4 دقائق»، «دقيقة»، «3 ساعات»)؛ أرقام لاتينية. */
export function humanDuration(ms: number, locale: Locale) {
  const seconds = Math.max(0, Math.round(ms / 1000)), unit = seconds < 60 ? "second" : seconds < 3600 ? "minute" : seconds < 86400 ? "hour" : "day";
  const value = unit === "second" ? seconds : unit === "minute" ? Math.floor(seconds / 60) : unit === "hour" ? Math.floor(seconds / 3600) : Math.floor(seconds / 86400);
  return new Intl.NumberFormat(locale === "ar" ? "ar-u-nu-latn" : "en", { style: "unit", unit, unitDisplay: "long" }).format(value);
}
