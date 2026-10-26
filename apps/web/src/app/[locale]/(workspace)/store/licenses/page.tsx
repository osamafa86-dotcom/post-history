import { LicensesPage } from "@/components/store/licenses";
import { isLocale } from "@/lib/i18n";
export default async function LicensesRoute({ params }: { params: Promise<{ locale: string }> }) { const { locale } = await params; return <LicensesPage locale={isLocale(locale) ? locale : "ar"} />; }
