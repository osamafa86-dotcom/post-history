"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { browserApi, dataOrThrow } from "@/lib/browser-api";
import { humanDuration, messages, type Locale } from "@/lib/i18n";
import type { Notification } from "@/lib/types";
import { notificationTarget } from "@/lib/assignment-policy";
import { useMutation } from "@/lib/use-mutation";
import { Icon } from "./icon";
import { inTab, notificationKind, panelOrder, panelTabs, unread, type PanelTab } from "@/lib/notification-kind";
import { untilVisible } from "@/lib/visibility";
import { useMaterialTitles } from "@/lib/use-material-titles";
import { hasRole, materialReaders } from "@/lib/review";
import { useUser } from "./session-boundary";

export { inTab, panelOrder, type PanelTab };

type BuyerWords = (typeof messages)[Locale]["shell"]["bell"]["buyer"];
/**
 * بند المشتري في الجرس (قرار المنسّق 2026-11-15): إبطال ترخيص أو تغيّر حالة طلب، برقمه إن وصل (مرجع المتجر في `title`)، ووجهته صفحة الشهادة أو
 * الطلب حين يُعرف معرّفها من قائمته، وإلا قائمتها. لا نص من الخادم.
 */
export function buyerNotice(n: Pick<Notification, "type" | "title">, words: BuyerWords, locale: Locale, targets: Record<string, string> = {}): { title: string; text: string; href: string } | null {
  const number = n.title ?? "";
  if (n.type === "license.revoked") return { title: number ? words.licenseRevoked.replace("{number}", number) : words.licenseRevokedPlain, text: words.licenseRevokedText, href: targets[number] ?? `/${locale}/store/licenses` };
  if (n.type === "order.status_changed") return { title: number ? words.orderChanged.replace("{number}", number) : words.orderChangedPlain, text: words.orderChangedText, href: targets[number] ?? `/${locale}/store/orders` };
  return null;
}
/** وجهات بنود المشتري: رقم الترخيص المُبطل إلى شهادته، ورقم الطلب إلى صفحته، من قائمتيه (نطاق الخادم). تعذّر القراءة يُبقي الوجهة قائمتها. */
function useBuyerTargets(items: Notification[] | null, enabled: boolean, locale: Locale): Record<string, string> {
  const [targets, setTargets] = useState<Record<string, string>>({});
  const licenses = enabled && !!items?.some(n => n.type === "license.revoked" && n.title), orders = enabled && !!items?.some(n => n.type === "order.status_changed" && n.title);
  useEffect(() => {
    if (!licenses) return;
    const controller = new AbortController();
    void browserApi().GET("/licenses", { params: { query: { status: "revoked", limit: 100 } }, signal: controller.signal }).then(dataOrThrow)
      .then(data => { if (!controller.signal.aborted) setTargets(found => ({ ...found, ...Object.fromEntries(data.items.map(l => [l.license_number, `/${locale}/store/licenses/${l.id}`])) })); }).catch(() => { /* تبقى القائمة وجهةً */ });
    return () => controller.abort();
  }, [licenses, locale]);
  useEffect(() => {
    if (!orders) return;
    const controller = new AbortController();
    void browserApi().GET("/orders", { params: { query: { limit: 100 } }, signal: controller.signal }).then(dataOrThrow)
      .then(data => { if (!controller.signal.aborted) setTargets(found => ({ ...found, ...Object.fromEntries(data.items.filter(o => o.order_number).map(o => [o.order_number!, `/${locale}/store/orders/${o.id}`])) })); }).catch(() => { /* تبقى القائمة وجهةً */ });
    return () => controller.abort();
  }, [orders, locale]);
  return targets;
}
/**
 * لوحة التنبيهات المنسدلة من الجرس (W10): تبويبات الكل/مهامي/المتجر (المتجر بنوع الحدث من القائمة المغلقة، ADR 0103)، والعاجل أولًا بأيقونة
 * وكلمة، و«تعليم الكل كمقروء» بالطلب نفسه الذي تستعمله صفحة الإشعارات (`read-all` بحدّ زمني ومفتاح ثابت)، ورابط إلى الصفحة الكاملة. نص كل بند
 * كلمة نوعه ودرجة تصعيده، لا نص من الخادم.
 */
export function NotificationsPanel({ locale, onClose, buyer = false }: { locale: Locale; onClose: () => void; buyer?: boolean }) {
  const m = messages[locale], t = m.shell.bell, mutation = useMutation(), bulkBefore = useRef<string | null>(null), me = useUser();
  const [items, setItems] = useState<Notification[] | null>(null), [failed, setFailed] = useState(false), [tab, setTab] = useState<PanelTab>("all"), [checkedAt, setCheckedAt] = useState(0), [attempt, setAttempt] = useState(0), [now, setNow] = useState(0);
  useEffect(() => {
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    async function load() {
      await untilVisible(controller.signal); if (controller.signal.aborted) return;
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
    if (await mutation.run(`read-all:${before}`, header => browserApi().POST("/notifications/read-all", { params: { header }, body: { before } }))) { bulkBefore.current = null; setAttempt(n => n + 1); window.dispatchEvent(new Event("notifications-read")); }
  }
  const visible = items ? panelOrder(items.filter(n => buyer || inTab(n, tab))) : [];
  const targets = useBuyerTargets(items, buyer, locale);
  // المشتري يفتح البند فيصير مقروءًا: لا صفحة تنبيهات له يعلّمه منها.
  const opened = (n: Notification) => { onClose(); if (buyer && unread(n)) void browserApi().POST("/notifications/{id}/read", { params: { path: { id: n.id }, header: { "Idempotency-Key": crypto.randomUUID() } } }).then(() => window.dispatchEvent(new Event("notifications-read"))).catch(() => { /* يبقى غير مقروء */ }); };
  const count = (which: PanelTab) => items?.filter(n => inTab(n, which)).length ?? 0;
  const titles = useMaterialTitles(visible.map(n => n.material_id), hasRole(me, ...materialReaders));
  return <section className="bell-panel" role="dialog" aria-modal="false" aria-labelledby="bell-title" data-testid="notifications-panel" data-buyer={buyer || undefined}>
    <header className="bell-head"><h2 id="bell-title">{m.notice.title}</h2><button type="button" className="link-button" disabled={mutation.busy || !items?.some(unread)} onClick={() => void readAll()}>{t.readAll}</button></header>
    {!buyer && <div className="bell-tabs" role="tablist" aria-label={t.tabsLabel}>{panelTabs.map(which => <button key={which} type="button" role="tab" aria-selected={tab === which} className={tab === which ? "active" : undefined} onClick={() => setTab(which)}>{t.tabs[which]}{which === "all" && items ? <> · <span dir="ltr">{count(which)}</span></> : null}</button>)}</div>}
    {mutation.status && mutation.status !== 200 ? <p className="notice error" role="alert">{m.error}</p> : null}
    {failed && !items ? <p className="bell-empty" role="alert">{m.error}</p> : !items ? <ul className="bell-list" aria-busy="true">{[0, 1, 2].map(i => <li key={i} className="skeleton-row"><span className="skeleton circle" /><span className="skeleton line" /></li>)}</ul>
      : !visible.length ? <p className="bell-empty">{t.empty}</p>
      : <ul className="bell-list">{visible.map(n => { const k = notificationKind(n), store = buyer ? buyerNotice(n, t.buyer, locale, targets) : null, href = store?.href ?? notificationTarget(n, locale) ?? `/${locale}/${buyer ? "store" : "notifications"}`;
        const title = n.material_id ? titles[n.material_id] : undefined;
        return <li key={n.id} className={`bell-item ${k.urgent ? "urgent" : k.word} ${unread(n) ? "unread" : ""}`} data-testid="bell-item">
          <span className={`bell-icon ${k.urgent ? "urgent" : k.word}`}><Icon name={k.icon} /></span>
          <Link prefetch={false} href={href} onClick={() => opened(n)}><strong>{store ? store.title : t.kinds[k.word]}{k.urgent && <> <span className="badge urgent">{m.states.priority.urgent}</span></>}</strong>{title && <span className="bell-title"><bdi>{title}</bdi></span>}{store && <span className="bell-title">{store.text}</span>}<span className="bell-text">{n.escalation_level ? `${m.notice.escalation}: ${n.escalation_level}` : unread(n) ? m.notice.unreadState : n.acknowledged_at || n.state === "acknowledged" ? m.notice.acknowledged : m.notice.readState}</span></Link>
          <small className="bell-time">{now ? t.ago.replace("{time}", humanDuration(now - Date.parse(n.created_at), locale)) : ""}</small></li>; })}</ul>}
    {!buyer && <footer className="bell-foot"><Link prefetch={false} href={`/${locale}/notifications`} onClick={onClose}>{t.all}</Link></footer>}
  </section>;
}
