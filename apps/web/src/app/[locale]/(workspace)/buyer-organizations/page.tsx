import { BuyerOrganizations } from "@/components/buyer-organizations";
import { isLocale } from "@/lib/i18n";
export default async function BuyerOrganizationsPage({ params }: { params: Promise<{ locale: string }> }) { const { locale } = await params; return <BuyerOrganizations locale={isLocale(locale) ? locale : "ar"} />; }
