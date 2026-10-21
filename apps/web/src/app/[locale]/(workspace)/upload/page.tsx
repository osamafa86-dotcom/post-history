import { DesktopUpload } from "@/components/desktop-upload";
import { isLocale } from "@/lib/i18n";
export default async function UploadPage({ params }: { params: Promise<{ locale: string }> }) { const { locale } = await params; return <DesktopUpload locale={isLocale(locale) ? locale : "ar"} />; }
