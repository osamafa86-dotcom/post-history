import { notFound } from "next/navigation";
import { MaterialDetail } from "@/components/material-detail";
import { isLocale } from "@/lib/i18n";
import { uuid } from "@/lib/query";
import { pageMetadata } from "@/lib/page-titles";
export const generateMetadata = pageMetadata("materials/[id]");
export default async function DetailPage({ params }: { params: Promise<{ locale: string; id: string }> }) {
  const { locale, id } = await params; if (!uuid.test(id)) notFound();
  return <MaterialDetail locale={isLocale(locale) ? locale : "ar"} id={id} />;
}
