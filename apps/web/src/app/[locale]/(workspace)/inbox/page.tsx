import { Inbox } from "@/components/inbox";
import { isLocale } from "@/lib/i18n";
export default async function InboxPage({ params }: { params: Promise<{ locale: string }> }) { const { locale } = await params; return <Inbox locale={isLocale(locale) ? locale : "ar"} />; }
