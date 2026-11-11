import { InviteConflicts } from "@/components/invite-conflicts";
import { isLocale } from "@/lib/i18n";
import { pageMetadata } from "@/lib/page-titles";
export const generateMetadata = pageMetadata("invite-conflicts");
export default async function InviteConflictsPage({ params }: { params: Promise<{ locale: string }> }) { const { locale } = await params; return <InviteConflicts locale={isLocale(locale) ? locale : "ar"} />; }
