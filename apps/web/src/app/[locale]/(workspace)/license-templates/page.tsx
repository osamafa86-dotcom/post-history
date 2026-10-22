import { LicenseTemplates } from "@/components/license-templates";
import { isLocale } from "@/lib/i18n";
export default async function LicenseTemplatesPage({ params }: { params: Promise<{ locale: string }> }) { const { locale } = await params; return <LicenseTemplates locale={isLocale(locale) ? locale : "ar"} />; }
