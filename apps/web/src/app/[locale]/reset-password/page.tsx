import { notFound } from "next/navigation";
import { isLocale } from "@/lib/i18n";
import { InviteAccept } from "@/components/store/invite-accept";

// إعادة تعيين كلمة المرور برابط مدير النظام أو المشرف (ADR 0108): بلا جلسة؛ الرمز في جزء الرابط بعد # فلا يصل إلى الخادم إلا في جسم الطلب.
export default async function ResetPasswordPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  return <InviteAccept locale={locale} kind="reset" />;
}
