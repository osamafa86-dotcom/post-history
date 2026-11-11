import { headers } from "next/headers";
import { EmptyState } from "@/components/empty-state";
import { HomeLink } from "@/components/home-link";
import { isLocale, messages } from "@/lib/i18n";

/** صفحة غير موجودة، بلغة العنوان المطلوب: تقول ما حدث وتقود إلى صفحة بداية الدور. لا تسمّي مادة ولا نطاقًا: لا تعرف ما طُلب. */
export default async function NotFound() {
  const value = (await headers()).get("x-web-locale") ?? "ar", locale = isLocale(value) ? value : "ar", t = messages[locale].pageNotFound;
  return <main className="center-state" data-testid="page-not-found"><EmptyState icon="search" title={<h1>{t.title}</h1>} actions={<HomeLink locale={locale}>{t.action}</HomeLink>}><p>{t.body}</p></EmptyState></main>;
}
