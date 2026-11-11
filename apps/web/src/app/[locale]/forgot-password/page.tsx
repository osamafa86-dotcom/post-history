import { notFound } from "next/navigation";
import { isLocale } from "@/lib/i18n";
import { ForgotPassword } from "@/components/forgot-password";
import { pageMetadata } from "@/lib/page-titles";
export const generateMetadata = pageMetadata("forgot-password");

// «نسيت كلمة المرور» (P1، ADR 0108): بلا جلسة، يشرح طريقي الاستعادة بلا بريد.
export default async function ForgotPasswordPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  return <ForgotPassword locale={locale} />;
}
