import { PayoutsPage } from "@/components/payouts";
import { isLocale } from "@/lib/i18n";
import { pageMetadata } from "@/lib/page-titles";
export const generateMetadata = pageMetadata("payouts");
export default async function Page({ params }: { params: Promise<{ locale: string }> }) { const { locale } = await params; return <PayoutsPage locale={isLocale(locale) ? locale : "ar"} />; }
