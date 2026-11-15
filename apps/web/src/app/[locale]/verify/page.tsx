import { notFound, redirect } from "next/navigation";
import { isLocale } from "@/lib/i18n";
import { LicenseLookup } from "@/components/store/license-verify";
import { licenseNumberPattern, normalizeLicenseNumber } from "@/lib/issued-licenses";
import { pageMetadata } from "@/lib/page-titles";
export const generateMetadata = pageMetadata("verify");

// صفحة إدخال رقم الترخيص للتحقق العام (D5): بلا تسجيل دخول، وبنموذج GET يعمل بلا سكربت. الرقم الصحيح ينتقل إلى صفحته، وغيره يُقال عنه هنا.
export default async function VerifyLookupPage({ params, searchParams }: { params: Promise<{ locale: string }>; searchParams: Promise<{ number?: string | string[] }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const raw = (await searchParams).number, typed = typeof raw === "string" ? raw.slice(0, 80) : "", normalized = normalizeLicenseNumber(typed);
  if (licenseNumberPattern.test(normalized)) redirect(`/${locale}/verify/${normalized}`);
  return <LicenseLookup locale={locale} typed={typed} invalid={typed.trim().length > 0} />;
}
