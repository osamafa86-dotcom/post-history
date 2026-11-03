import { StoreTrialNotice } from "@/components/store/trial-notice";
import { isLocale } from "@/lib/i18n";
/** هيكل المتجر: لافتة التجربة فوق كل صفحاته (الدفع تجريبي، قرار المالك 2026-10-21). */
export default async function StoreLayout({ children, params }: { children: React.ReactNode; params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  return <><StoreTrialNotice locale={isLocale(locale) ? locale : "ar"} />{children}</>;
}
