import { HomeRedirect } from "@/components/home-redirect";
import { isLocale } from "@/lib/i18n";
export default async function Home({ params }: { params: Promise<{ locale: string }> }) { const { locale } = await params; return <HomeRedirect locale={isLocale(locale) ? locale : "ar"} />; }
