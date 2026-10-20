import { headers } from "next/headers";
import { messages, isLocale } from "@/lib/i18n";
import "./globals.css";
export const dynamic = "force-dynamic";
export async function generateMetadata() {
  const value = (await headers()).get("x-web-locale") ?? "ar", locale = isLocale(value) ? value : "ar";
  const m = messages[locale]; return { title: `${m.product} | ${m.brand}`, robots: { index: false, follow: false } };
}
export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const value = (await headers()).get("x-web-locale") ?? "ar", locale = isLocale(value) ? value : "ar";
  return <html lang={locale} dir={locale === "ar" ? "rtl" : "ltr"}><body>{children}</body></html>;
}
