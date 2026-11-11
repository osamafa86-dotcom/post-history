import { StoreCatalog } from "@/components/store/store-catalog";
import { isLocale } from "@/lib/i18n";
import { pageMetadata } from "@/lib/page-titles";
export const generateMetadata = pageMetadata("store");
export default async function StorePage({ params }: { params: Promise<{ locale: string }> }) { const { locale } = await params; return <StoreCatalog locale={isLocale(locale) ? locale : "ar"} />; }
