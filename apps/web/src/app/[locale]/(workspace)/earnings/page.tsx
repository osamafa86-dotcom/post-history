import { EarningsPage } from "@/components/earnings";
import { isLocale } from "@/lib/i18n";
export default async function Page({ params }: { params: Promise<{ locale: string }> }) { const { locale } = await params; return <EarningsPage locale={isLocale(locale) ? locale : "ar"} />; }
