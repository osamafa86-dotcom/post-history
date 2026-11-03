import Link from "next/link";
import type { components } from "@/generated/schema";
import { messages, type Locale } from "@/lib/i18n";
import { Icon } from "../icon";

type Organization = components["schemas"]["BuyerOrganization"];

/**
 * مؤسسة قيد التحقّق أو معلّقة (S6): لا كتالوج باهت؛ بطاقة تقول ما تراجعه الإدارة (البنود الثلاثة في A5 بلا حالة لكل بند، لأنها ليست في العقد)،
 * وما يستطيعه المدير الآن: دعوة الأعضاء ضمن المقاعد (`seats` و`active_members`). لا وعد بإشعار عند التفعيل: لا حدث له في العقد.
 */
export function OrgPending({ locale, organization, canInvite }: { locale: Locale; organization: Pick<Organization, "status" | "seats" | "active_members">; canInvite: boolean }) {
  const t = messages[locale].store.org, suspended = organization.status === "suspended";
  return <section className="card org-pending" aria-labelledby="org-pending-title" data-testid="org-pending" data-status={organization.status}>
    <header className="org-pending-head"><span className="verify-seal warn"><Icon name={suspended ? "ban" : "clock"} size={22} /></span>
      <div><p className={`badge state ${suspended ? "danger" : "warn"}`}><Icon name={suspended ? "ban" : "clock"} size={14} />{suspended ? t.suspendedBadge : t.pendingBadge}</p>
        <h1 id="org-pending-title">{suspended ? t.suspendedTitle : t.pendingTitle}</h1></div></header>
    <p className="muted">{suspended ? t.suspendedBody : t.pendingBody}</p>
    {!suspended && <div className="org-checks"><h2>{t.checks}</h2><ul>{[t.checkRegistry, t.checkEmail, t.checkAgreement].map(item => <li key={item}>{item}</li>)}</ul></div>}
    <div className="org-now"><div><h2>{t.nowTitle}</h2><p className="caption">{canInvite ? t.nowSeats.replace("{used}", String(organization.active_members ?? 0)).replace("{seats}", String(organization.seats ?? 0)) : t.nowMember}</p></div>
      {canInvite && <Link prefetch={false} className="button secondary" href={`/${locale}/organization`}>{t.invite}</Link>}</div>
  </section>;
}
