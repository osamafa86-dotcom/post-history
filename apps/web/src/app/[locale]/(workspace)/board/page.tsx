import { NewsroomBoard } from "@/components/newsroom-board";
import { isLocale } from "@/lib/i18n";
export default async function BoardPage({ params }: { params: Promise<{ locale: string }> }) { const { locale } = await params; return <NewsroomBoard locale={isLocale(locale) ? locale : "ar"} />; }
