import { AccountAdmin } from "@/components/account-admin";
import { isLocale } from "@/lib/i18n";
export default async function AdminPage({ params }: { params: Promise<{ locale: string }> }) { const { locale } = await params; return <AccountAdmin locale={isLocale(locale) ? locale : "ar"} />; }
