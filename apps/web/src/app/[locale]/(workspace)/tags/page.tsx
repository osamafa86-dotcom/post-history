import { TagsAdmin } from "@/components/tags-admin";
import { isLocale } from "@/lib/i18n";
import { pageMetadata } from "@/lib/page-titles";
export const generateMetadata = pageMetadata("tags");
export default async function TagsPage({ params }: { params: Promise<{ locale: string }> }) { const { locale } = await params; return <TagsAdmin locale={isLocale(locale) ? locale : "ar"} />; }
