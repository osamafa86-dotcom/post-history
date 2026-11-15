import { Login } from "@/components/login";
import { isLocale } from "@/lib/i18n";
import { pageMetadata } from "@/lib/page-titles";
import { returnPath } from "@/lib/return-path";
export const generateMetadata = pageMetadata("login");
// `next`: صفحة العودة بعد الدخول، مسار داخلي من صفحات التطبيق وحدها (`returnPath`)؛ غيره يُهمل هنا قبل أن يصل الصفحة.
export default async function LoginPage({ params, searchParams }: { params: Promise<{ locale: string }>; searchParams: Promise<{ reason?: string | string[]; next?: string | string[] }> }) {
  const { locale } = await params, query = await searchParams;
  return <Login locale={isLocale(locale) ? locale : "ar"} reason={typeof query.reason === "string" ? query.reason : undefined} next={returnPath(query.next, "http://localhost")} />;
}
