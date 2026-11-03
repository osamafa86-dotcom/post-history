import { RecoveryApproval } from "@/components/recovery-approval";
import { isLocale } from "@/lib/i18n";

// اعتماد طلب استعادة حساب (ADR 0108): المشرف ومدير النظام، من تنبيه الطلب.
export default async function RecoveryRequestPage({ params }: { params: Promise<{ locale: string; id: string }> }) {
  const { locale, id } = await params;
  return <RecoveryApproval locale={isLocale(locale) ? locale : "ar"} id={id} />;
}
