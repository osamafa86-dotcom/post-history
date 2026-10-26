import { NewsroomBoard } from "@/components/newsroom-board";
import { BoardDisplay } from "@/components/board-display";
import { isLocale } from "@/lib/i18n";
// ‎?display=1 وضع الشاشة الكبيرة (التدفق ج)، و‎&theme=light للوضع الفاتح؛ بدونه وضع المكتب.
export default async function BoardPage({ params, searchParams }: { params: Promise<{ locale: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { locale } = await params, query = await searchParams, safe = isLocale(locale) ? locale : "ar";
  return query.display === "1" ? <BoardDisplay locale={safe} light={query.theme === "light"} /> : <NewsroomBoard locale={safe} />;
}
