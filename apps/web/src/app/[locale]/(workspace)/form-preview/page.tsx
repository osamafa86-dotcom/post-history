import { FormPreview } from "@/components/form-preview";
import { isLocale } from "@/lib/i18n";
export default async function FormPage({ params }: { params: Promise<{ locale: string }> }) { const { locale } = await params; return <FormPreview locale={isLocale(locale) ? locale : "ar"} />; }
