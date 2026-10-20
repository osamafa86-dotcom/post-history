import { Login } from "@/components/login";
import { isLocale } from "@/lib/i18n";
export default async function LoginPage({ params, searchParams }: { params: Promise<{ locale: string }>; searchParams: Promise<{ reason?: string }> }) {
  const { locale } = await params;
  return <Login locale={isLocale(locale) ? locale : "ar"} reason={(await searchParams).reason} />;
}
