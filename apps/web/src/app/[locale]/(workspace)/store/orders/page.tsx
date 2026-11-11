import { OrdersPage } from "@/components/store/orders";
import { isLocale } from "@/lib/i18n";
import { pageMetadata } from "@/lib/page-titles";
export const generateMetadata = pageMetadata("store/orders");
export default async function OrdersPageRoute({ params }: { params: Promise<{ locale: string }> }) { const { locale } = await params; return <OrdersPage locale={isLocale(locale) ? locale : "ar"} />; }
