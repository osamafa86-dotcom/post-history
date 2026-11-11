import { Archive } from "@/components/archive";
import { isLocale } from "@/lib/i18n";
import { pageMetadata } from "@/lib/page-titles";
export const generateMetadata = pageMetadata("archive");
export default async function ArchivePage({ params }: { params: Promise<{ locale: string }> }) { const { locale } = await params; return <Archive locale={isLocale(locale) ? locale : "ar"} />; }
