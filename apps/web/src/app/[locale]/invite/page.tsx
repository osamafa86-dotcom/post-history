import { notFound } from "next/navigation";
import { isLocale } from "@/lib/i18n";
import { InviteAccept } from "@/components/store/invite-accept";

// قبول دعوة المتجر (S5، S5b): بلا جلسة؛ الرمز في جزء الرابط بعد # فلا يصل إلى الخادم إلا في جسم الطلب.
export default async function InvitePage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  return <InviteAccept locale={locale} />;
}
