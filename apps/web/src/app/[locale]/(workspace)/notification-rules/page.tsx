import { NotificationRules } from "@/components/notification-rules";
import { isLocale } from "@/lib/i18n";
import { pageMetadata } from "@/lib/page-titles";
export const generateMetadata = pageMetadata("notification-rules");
export default async function NotificationRulesPage({ params }: { params: Promise<{ locale: string }> }) { const { locale } = await params; return <NotificationRules locale={isLocale(locale) ? locale : "ar"} />; }
