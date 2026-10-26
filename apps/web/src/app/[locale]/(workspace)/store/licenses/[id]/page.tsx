import { notFound } from "next/navigation";
import { LicenseCertificate } from "@/components/store/licenses";
import { isLocale } from "@/lib/i18n";
import { uuid } from "@/lib/query";
export default async function LicenseRoute({ params }: { params: Promise<{ locale: string; id: string }> }) { const { locale, id } = await params; if (!uuid.test(id)) notFound(); return <LicenseCertificate locale={isLocale(locale) ? locale : "ar"} id={id} />; }
