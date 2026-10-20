import { SessionBoundary } from "@/components/session-boundary";
import { isLocale } from "@/lib/i18n";
export default async function WorkspaceLayout({ children, params }: { children: React.ReactNode; params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  return <SessionBoundary locale={isLocale(locale) ? locale : "ar"}>{children}</SessionBoundary>;
}
