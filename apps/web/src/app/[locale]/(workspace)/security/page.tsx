import { AccountSecurity } from "@/components/account-security";
import { isLocale } from "@/lib/i18n";

// الأمان (ADR 0108): مفاتيح المرور والرموز الاحتياطية لكل حساب بجلسة.
export default async function SecurityPage({ params }: { params: Promise<{ locale: string }> }) { const { locale } = await params; return <AccountSecurity locale={isLocale(locale) ? locale : "ar"} />; }
