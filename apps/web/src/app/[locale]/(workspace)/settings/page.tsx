import { SettingsAdmin } from "@/components/settings-admin";
import { isLocale } from "@/lib/i18n";
import { pageMetadata } from "@/lib/page-titles";
export const generateMetadata = pageMetadata("settings");
export default async function SettingsPage({ params }: { params: Promise<{ locale: string }> }) { const { locale } = await params; return <SettingsAdmin locale={isLocale(locale) ? locale : "ar"} />; }
