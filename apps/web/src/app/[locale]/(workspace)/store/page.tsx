import { StoreCatalog } from "@/components/store/store-catalog";
import { filtersFromSearch } from "@/lib/catalog-filters";
import { isLocale } from "@/lib/i18n";
import { pageMetadata } from "@/lib/page-titles";
export const generateMetadata = pageMetadata("store");
// المرشحات من الرابط (`?q=…&governorate=…`): المعروف منها بقيمه المقبولة وحده، فالرجوع من مادة أو رابط يُرسل لزميل يفتح البحث نفسه.
export default async function StorePage({ params, searchParams }: { params: Promise<{ locale: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { locale } = await params;
  return <StoreCatalog locale={isLocale(locale) ? locale : "ar"} initial={filtersFromSearch(await searchParams)} />;
}
