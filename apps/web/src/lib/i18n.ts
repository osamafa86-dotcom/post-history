import ar from "../../messages/ar.json";
import en from "../../messages/en.json";
export type Locale = "ar" | "en";
export const isLocale = (s: string): s is Locale => s === "ar" || s === "en";
export const messages = { ar, en };
export function formatDate(value: string | null | undefined, locale: Locale) {
  if (!value || !Number.isFinite(Date.parse(value))) return messages[locale].notAvailable;
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}
