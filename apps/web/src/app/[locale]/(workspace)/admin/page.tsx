import { UsersAdmin } from "@/components/users-admin";
import { isLocale } from "@/lib/i18n";
export default async function AdminPage({ params }: { params: Promise<{ locale: string }> }) { const { locale } = await params; return <UsersAdmin locale={isLocale(locale) ? locale : "ar"} />; }
