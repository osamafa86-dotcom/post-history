import { notFound } from "next/navigation";
import { TaskDetail } from "@/components/task-detail";
import { isLocale } from "@/lib/i18n";
import { uuid } from "@/lib/query";
export default async function TaskPage({ params }: { params: Promise<{ locale: string; id: string }> }) {
  const { locale, id } = await params; if (!uuid.test(id)) notFound();
  return <TaskDetail locale={isLocale(locale) ? locale : "ar"} id={id} />;
}
