import Link from "next/link";
import { messages, type Locale } from "@/lib/i18n";
import type { Me } from "@/lib/types";
import { homePage } from "@/lib/home-page";
import { Icon, type IconName } from "./icon";

/**
 * نمط الحالات (E1–E6، `Empty state`): أيقونة في دائرة، وعنوان يقول ما يحدث، وجملة تقول السبب والخطوة التالية، وفعل أو اثنان.
 * لا شاشة بيضاء ولا «حدث خطأ» بلا سبب.
 */
export function EmptyState({ icon, title, children, actions, role, testId }: { icon: IconName; title: React.ReactNode; children?: React.ReactNode; actions?: React.ReactNode; role?: "status" | "alert"; testId?: string }) {
  return <section className="empty-state" role={role} data-testid={testId}>
    <span className="empty-icon"><Icon name={icon} size={24} /></span>
    <h2>{title}</h2>
    {children && <div className="empty-body">{children}</div>}
    {actions && <div className="actions">{actions}</div>}
  </section>;
}

/**
 * لا صلاحية (E5): يقول الدور وما يملكه، ويعيد إلى صفحة بدايته (`homePage`). «اطلب الوصول» خارج الخطة والعقد فلا يُبنى (web-v2.md E5).
 * نص الرفض الخاص بالصفحة يبقى بدور `alert` كما كان.
 */
export function NoAccess({ locale, me, title, denied }: { locale: Locale; me: Me | null; title: string; denied: string }) {
  const m = messages[locale], t = m.shell.noAccess, roles = m.topbar.roles as Record<string, string>;
  const names = me?.roles.map(role => roles[role.name]).filter(Boolean) ?? [], home = me ? homePage(me) : "inbox";
  const back = { store: t.backStore, inbox: t.backInbox, payouts: t.backPayouts, notifications: t.backNotifications }[home];
  return <section className="no-access" data-testid="no-access"><h1>{title}</h1>
    <EmptyState icon="key" title={t.title} actions={<Link prefetch={false} className="button secondary" href={`/${locale}/${home}`}>{back}</Link>}>
      <p role="alert">{denied}</p>
      <p>{names.length ? t.role.replace("{role}", names.join(m.shell.listSeparator)) : t.noRole} {t.direct}</p>
    </EmptyState>
  </section>;
}
