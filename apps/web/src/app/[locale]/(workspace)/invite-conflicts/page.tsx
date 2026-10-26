import { InviteConflicts } from "@/components/invite-conflicts";
import { isLocale } from "@/lib/i18n";
export default async function InviteConflictsPage({ params }: { params: Promise<{ locale: string }> }) { const { locale } = await params; return <InviteConflicts locale={isLocale(locale) ? locale : "ar"} />; }
