import { BuyerOrganizations } from "@/components/buyer-organizations";
import { isLocale } from "@/lib/i18n";
import { pageMetadata } from "@/lib/page-titles";
export const generateMetadata = pageMetadata("buyer-organizations");
export default async function BuyerOrganizationsPage({ params }: { params: Promise<{ locale: string }> }) { const { locale } = await params; return <BuyerOrganizations locale={isLocale(locale) ? locale : "ar"} />; }
