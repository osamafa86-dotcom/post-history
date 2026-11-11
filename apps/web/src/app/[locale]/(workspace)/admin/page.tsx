import { UsersAdmin } from "@/components/users-admin";
import { isLocale } from "@/lib/i18n";
import { pageMetadata } from "@/lib/page-titles";
export const generateMetadata = pageMetadata("admin");
export default async function AdminPage({ params }: { params: Promise<{ locale: string }> }) { const { locale } = await params; return <UsersAdmin locale={isLocale(locale) ? locale : "ar"} />; }
