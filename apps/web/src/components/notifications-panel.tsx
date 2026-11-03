"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { browserApi, dataOrThrow } from "@/lib/browser-api";
import { humanDuration, messages, type Locale } from "@/lib/i18n";
import type { Notification } from "@/lib/types";
import { notificationTarget } from "@/lib/assignment-policy";
import { useMutation } from "@/lib/use-mutation";
import { Icon, type IconName } from "./icon";

export type PanelTab = "all" | "mine" | "urgent";

/**
 * تبويب التنبيه: «مهامي» لما أُسند إلى المستخدم (`assignment_state`)، و«العاجل» بالأولوية. الـBFF يحذف نوع الحدث وعنوانه من كل إشعار
 * (`safeNotification`)، فلا يُعرف منه ما يخص المتجر: تبويب «المتجر» في W10 مؤجّل (ADR 0090).
 */
export function inTab(n: Notification, tab: PanelTab): boolean {
  return tab === "all" || (tab === "mine" ? !!n.assignment_state : n.priority === "urgent");
}
/** الترتيب (W10): العاجل أولًا ثم غير المقروء ثم الأحدث. الإشعار لا يحمل علم الحساسية في العقد، فلا يُدّعى ترتيب به. */
export function panelOrder(items: Notification[]): Notification[] {
  const unread = (n: Notification) => !n.read_at && n.state !== "read" && n.state !== "acknowledged";
  return [...items].sort((a, b) => Number(b.priority === "urgent") - Number(a.priority === "urgent") || Number(unread(b)) - Number(unread(a)) || Date.parse(b.created_at) - Date.parse(a.created_at));
}
function kind(n: Notification): { icon: IconName; word: "urgent" | "task" | "update" } {
  return n.priority === "urgent" ? { icon: "bolt", word: "urgent" } : n.assignment_state ? { icon: "clock", word: "task" } : { icon: "inbox", word: "update" };
}

/**
 * لوحة التنبيهات المنسدلة من الجرس (W10): تبويبات الكل/مهامي/المتجر، والعاجل أولًا بأيقونة وكلمة، و«تعليم الكل كمقروء» بالطلب نفسه
 * الذي تستعمله صفحة الإشعارات (`read-all` بحدّ زمني ومفتاح ثابت)، ورابط إلى الصفحة الكاملة. نص كل بند كلمة نوعه ودرجة تصعيده، لا نص من الخادم.
 */
export function NotificationsPanel({ locale, onClose }: { locale: Locale; onClose: () => void }) {
  const m = messages[locale], t = m.shell.bell, mutation = useMutation(), bulkBefore = useRef<string | null>(null);
  const [items, setItems] = useState<Notification[] | null>(null), [failed, setFailed] = useState(false), [tab, setTab] = useState<PanelTab>("all"), [checkedAt, setCheckedAt] = useState(0), [attempt, setAttempt] = useState(0), [now, setNow] = useState(0);
  useEffect(() => {
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    async function load() {
      const startedAt = Date.now();
      try { const data = dataOrThrow(await browserApi().GET("/notifications", { params: { query: { limit: 20 } }, signal: controller.signal })); if (!controller.signal.aborted) { setItems(data.items); setCheckedAt(startedAt); setNow(Date.now()); setFailed(false); } }
      catch { if (!controller.signal.aborted) setFailed(true); }
      finally { if (!controller.signal.aborted) timer = setTimeout(load, 15000); }
    }
    void load(); return () => { controller.abort(); clearTimeout(timer); };
  }, [attempt]);
  async function readAll() {
    if (!checkedAt) return;
    const before = bulkBefore.current ?? new Date(checkedAt).toISOString(); bulkBefore.current = before;
    if (await mutation.run(`read-all:${before}`, header => browserApi().POST("/notifications/read-all", { params: { header }, body: { before } }))) { bulkBefore.current = null; setAttempt(n => n + 1); }
  }
  const visible = items ? panelOrder(items.filter(n => inTab(n, tab))) : [];
  const count = (which: PanelTab) => items?.filter(n => inTab(n, which)).length ?? 0;
  const unread = (n: Notification) => !n.read_at && n.state !== "read" && n.state !== "acknowledged";
  return <section className="bell-panel" role="dialog" aria-modal="false" aria-labelledby="bell-title" data-testid="notifications-panel">
    <header className="bell-head"><h2 id="bell-title">{m.notice.title}</h2><button type="button" className="link-button" disabled={mutation.busy || !items?.some(unread)} onClick={() => void readAll()}>{t.readAll}</button></header>
    <div className="bell-tabs" role="tablist" aria-label={t.tabsLabel}>{(["all", "mine", "urgent"] as PanelTab[]).map(which => <button key={which} type="button" role="tab" aria-selected={tab === which} className={tab === which ? "active" : undefined} onClick={() => setTab(which)}>{t.tabs[which]}{which === "all" && items ? <> · <span dir="ltr">{count(which)}</span></> : null}</button>)}</div>
    {mutation.status && mutation.status !== 200 ? <p className="notice error" role="alert">{m.error}</p> : null}
    {failed && !items ? <p className="bell-empty" role="alert">{m.error}</p> : !items ? <ul className="bell-list" aria-busy="true">{[0, 1, 2].map(i => <li key={i} className="skeleton-row"><span className="skeleton circle" /><span className="skeleton line" /></li>)}</ul>
      : !visible.length ? <p className="bell-empty">{t.empty}</p>
      : <ul className="bell-list">{visible.map(n => { const k = kind(n), href = notificationTarget(n, locale) ?? `/${locale}/notifications`;
        return <li key={n.id} className={`bell-item ${k.word} ${unread(n) ? "unread" : ""}`} data-testid="bell-item">
          <span className={`bell-icon ${k.word}`}><Icon name={k.icon} /></span>
          <Link prefetch={false} href={href} onClick={onClose}><strong>{t.kinds[k.word]}</strong><span className="bell-text">{n.escalation_level ? `${m.notice.escalation}: ${n.escalation_level}` : unread(n) ? m.notice.unreadState : n.acknowledged_at || n.state === "acknowledged" ? m.notice.acknowledged : m.notice.readState}</span></Link>
          <small className="bell-time">{now ? t.ago.replace("{time}", humanDuration(now - Date.parse(n.created_at), locale)) : ""}</small></li>; })}</ul>}
    <footer className="bell-foot"><Link prefetch={false} href={`/${locale}/notifications`} onClick={onClose}>{t.all}</Link></footer>
  </section>;
}
