import { notFound } from "next/navigation";
import { OrderPage } from "@/components/store/orders";
import { isLocale } from "@/lib/i18n";
import { uuid } from "@/lib/query";
// ?returned=1 يضعه رابط العودة من المزوّد؛ لا يؤكد الدفع، ويبدأ قراءة الطلب حتى يتغير.
export default async function OrderRoute({ params, searchParams }: { params: Promise<{ locale: string; id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { locale, id } = await params, query = await searchParams;
  if (!uuid.test(id)) notFound();
  return <OrderPage locale={isLocale(locale) ? locale : "ar"} id={id} returned={query.returned === "1"} />;
}
