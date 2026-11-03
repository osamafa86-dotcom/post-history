import { notFound } from "next/navigation";
import { InvoicePage } from "@/components/store/invoice";
import { isLocale } from "@/lib/i18n";
import { uuid } from "@/lib/query";
// الفاتورة (S7) للطلب المدفوع: ورقة فاتحة داخل المتجر الداكن، وطباعتها من المتصفح.
export default async function InvoiceRoute({ params }: { params: Promise<{ locale: string; id: string }> }) {
  const { locale, id } = await params;
  if (!uuid.test(id)) notFound();
  return <InvoicePage locale={isLocale(locale) ? locale : "ar"} id={id} />;
}
