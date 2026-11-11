import { CartPage } from "@/components/store/orders";
import { isLocale } from "@/lib/i18n";
import { pageMetadata } from "@/lib/page-titles";
export const generateMetadata = pageMetadata("store/cart");
export default async function CartPageRoute({ params }: { params: Promise<{ locale: string }> }) { const { locale } = await params; return <CartPage locale={isLocale(locale) ? locale : "ar"} />; }
