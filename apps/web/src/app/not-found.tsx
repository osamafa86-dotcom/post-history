import type { Metadata } from "next";
import { headers } from "next/headers";
import { EmptyState } from "@/components/empty-state";
import { HomeLink } from "@/components/home-link";
import { isLocale, messages } from "@/lib/i18n";

const pageLocale = async () => { const value = (await headers()).get("x-web-locale") ?? "ar"; return isLocale(value) ? value : "ar"; };

/** عنوان التبويب بالنمط الموحّد («اسم الصفحة · المكتبة المرئية»، `page-titles.ts`)، لا عنوان الموقع العام ولا عنوان الصفحة التي لم توجد. */
export async function generateMetadata(): Promise<Metadata> {
  const m = messages[await pageLocale()];
  return { title: `${m.pageNotFound.title} · ${m.product}` };
}

/** صفحة غير موجودة، بلغة العنوان المطلوب: تقول ما حدث وتقود إلى صفحة بداية الدور. لا تسمّي مادة ولا نطاقًا: لا تعرف ما طُلب. */
export default async function NotFound() {
  const locale = await pageLocale(), t = messages[locale].pageNotFound;
  return <main className="center-state" data-testid="page-not-found"><EmptyState icon="search" level={1} title={t.title} actions={<HomeLink locale={locale}>{t.action}</HomeLink>}><p>{t.body}</p></EmptyState></main>;
}
