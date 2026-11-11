import { notFound } from "next/navigation";
import { TaskDetail } from "@/components/task-detail";
import { isLocale } from "@/lib/i18n";
import { uuid } from "@/lib/query";
import { pageMetadata } from "@/lib/page-titles";
export const generateMetadata = pageMetadata("tasks/[id]");
export default async function TaskPage({ params }: { params: Promise<{ locale: string; id: string }> }) {
  const { locale, id } = await params; if (!uuid.test(id)) notFound();
  return <TaskDetail locale={isLocale(locale) ? locale : "ar"} id={id} />;
}
