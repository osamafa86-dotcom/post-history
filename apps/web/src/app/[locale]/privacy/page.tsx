import Link from "next/link";
import { notFound } from "next/navigation";
import { isLocale, messages } from "@/lib/i18n";

export default async function PrivacyPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const m = messages[locale].privacy;
  return <main dir={locale === "ar" ? "rtl" : "ltr"} lang={locale} className="mx-auto max-w-3xl px-6 py-12">
    <h1 className="mb-6 text-3xl font-bold">{m.title}</h1>
    <p role="note" className="mb-6 rounded border p-4 font-semibold">{m.temporary}</p>
    <p className="mb-8 leading-8">{m.body}</p>
    <nav aria-label={m.languageNavigation}>
      <Link href={`/${locale === "ar" ? "en" : "ar"}/privacy`} hrefLang={locale === "ar" ? "en" : "ar"} lang={locale === "ar" ? "en" : "ar"}>{m.otherLanguage}</Link>
    </nav>
  </main>;
}
