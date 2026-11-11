import { FormAdmin } from "@/components/form-admin";
import { isLocale } from "@/lib/i18n";
import { pageMetadata } from "@/lib/page-titles";
export const generateMetadata = pageMetadata("forms");
export default async function FormsPage({ params }: { params: Promise<{ locale: string }> }) { const { locale } = await params; return <FormAdmin locale={isLocale(locale) ? locale : "ar"} />; }
