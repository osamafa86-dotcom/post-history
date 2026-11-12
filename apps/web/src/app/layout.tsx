import type { Viewport } from "next";
import { headers } from "next/headers";
import { messages, isLocale } from "@/lib/i18n";
import { themeColor } from "@/lib/theme-color";
import "@/generated/tokens.css";
import "./globals.css";
import "./store.css";
import "./pages.css";
import "./desk-tools.css";
export const dynamic = "force-dynamic";
/** لون شريط المتصفح للوضعين من رموز التصميم. وسم `viewport` على حاله: لا `viewport-fit` ما دامت المناطق الآمنة بلا معالجة. */
export const viewport: Viewport = { themeColor: [{ media: "(prefers-color-scheme: light)", color: themeColor.light }, { media: "(prefers-color-scheme: dark)", color: themeColor.dark }] };
export async function generateMetadata() {
  const value = (await headers()).get("x-web-locale") ?? "ar", locale = isLocale(value) ? value : "ar";
  const m = messages[locale]; return { title: `${m.product} | ${m.brand}`, robots: { index: false, follow: false } };
}
export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const value = (await headers()).get("x-web-locale") ?? "ar", locale = isLocale(value) ? value : "ar";
  return <html lang={locale} dir={locale === "ar" ? "rtl" : "ltr"}><body>{children}</body></html>;
}
