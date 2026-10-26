import { MyOrganization } from "@/components/buyer-organizations";
import { isLocale } from "@/lib/i18n";
export default async function MyOrganizationPage({ params }: { params: Promise<{ locale: string }> }) { const { locale } = await params; return <MyOrganization locale={isLocale(locale) ? locale : "ar"} />; }
