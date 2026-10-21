import { Notifications } from "@/components/notifications";
import { isLocale } from "@/lib/i18n";
export default async function NotificationsPage({ params }: { params: Promise<{ locale: string }> }) { const { locale } = await params; return <Notifications locale={isLocale(locale) ? locale : "ar"} />; }
