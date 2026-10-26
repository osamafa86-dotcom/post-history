import { CommissionRules } from "@/components/commission-rules";
import { isLocale } from "@/lib/i18n";
export default async function CommissionRulesPage({ params }: { params: Promise<{ locale: string }> }) { const { locale } = await params; return <CommissionRules locale={isLocale(locale) ? locale : "ar"} />; }
