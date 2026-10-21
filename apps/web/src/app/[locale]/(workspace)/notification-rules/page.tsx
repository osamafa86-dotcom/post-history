import { NotificationRules } from "@/components/notification-rules";
import { isLocale } from "@/lib/i18n";
export default async function NotificationRulesPage({ params }: { params: Promise<{ locale: string }> }) { const { locale } = await params; return <NotificationRules locale={isLocale(locale) ? locale : "ar"} />; }
