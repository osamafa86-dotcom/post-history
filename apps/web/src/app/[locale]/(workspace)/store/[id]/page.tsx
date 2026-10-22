import { StoreItem } from "@/components/store/store-item";
import { isLocale } from "@/lib/i18n";
import { uuid } from "@/lib/query";
import { notFound } from "next/navigation";
export default async function StoreItemPage({ params }: { params: Promise<{ locale: string; id: string }> }) { const { locale, id } = await params; if (!uuid.test(id)) notFound(); return <StoreItem locale={isLocale(locale) ? locale : "ar"} id={id} />; }
