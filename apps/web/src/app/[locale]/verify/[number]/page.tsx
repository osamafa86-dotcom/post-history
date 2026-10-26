import { notFound } from "next/navigation";
import { isLocale } from "@/lib/i18n";
import { LicenseVerify } from "@/components/store/license-verify";

// صفحة التحقق العامة من ترخيص (التدفق د، D5): بلا تسجيل دخول.
export default async function VerifyPage({ params }: { params: Promise<{ locale: string; number: string }> }) {
  const { locale, number } = await params;
  if (!isLocale(locale)) notFound();
  return <LicenseVerify locale={locale} number={decodeURIComponent(number)} />;
}
