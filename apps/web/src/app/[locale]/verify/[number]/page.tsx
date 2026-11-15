import { notFound, redirect } from "next/navigation";
import { isLocale } from "@/lib/i18n";
import { LicenseVerify } from "@/components/store/license-verify";
import { licenseNumberPattern, normalizeLicenseNumber } from "@/lib/issued-licenses";
import { pageMetadata } from "@/lib/page-titles";
export const generateMetadata = pageMetadata("verify/[number]");

// صفحة التحقق العامة من ترخيص (التدفق د، D5): بلا تسجيل دخول.
export default async function VerifyPage({ params }: { params: Promise<{ locale: string; number: string }> }) {
  const { locale, number } = await params;
  if (!isLocale(locale)) notFound();
  // الرقم بحروف صغيرة أو بفراغات يُحوَّل إلى عنوانه القانوني، فيُتحقق منه ويُشارَك بصيغة الشهادة.
  const typed = decodeURIComponent(number), normalized = normalizeLicenseNumber(typed);
  if (normalized !== typed && licenseNumberPattern.test(normalized)) redirect(`/${locale}/verify/${normalized}`);
  return <LicenseVerify locale={locale} number={typed} />;
}
