import { MyTasks } from "@/components/my-tasks";
import { isLocale } from "@/lib/i18n";
export default async function TasksPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  return <MyTasks locale={isLocale(locale) ? locale : "ar"} />;
}
