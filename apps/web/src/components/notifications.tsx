"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { browserApi, dataOrThrow } from "@/lib/browser-api";
import { formatDate, humanDuration, messages, plural, type Locale } from "@/lib/i18n";
import type { Notification, NotificationPage } from "@/lib/types";
import { notificationTarget } from "@/lib/assignment-policy";
import { groupNotifications, type NotificationGroup } from "@/lib/editor";
import { asksAck, inTab, notificationKind, panelTabs, type PanelTab } from "@/lib/notification-kind";
import { useMaterialTitles } from "@/lib/use-material-titles";
import { hasRole, materialReaders } from "@/lib/review";
import { useUser } from "./session-boundary";
import { useMutation } from "@/lib/use-mutation";
import { ActionStatus } from "./action-status";
import { EmptyState, ErrorState } from "./empty-state";
import { Icon } from "./icon";
import { untilVisible } from "@/lib/visibility";

const state = (n: Notification) => n.acknowledged_at || n.state === "acknowledged" ? "acknowledged" : n.read_at || n.state === "read" ? "read" : "unread";

/**
 * صفحة الإشعارات الكاملة (B4، وv2 في ADR 0103) بنمط W10 على مساحة الصفحة: تبويبات الكل/مهامي/المتجر، وأقسام «يحتاج إقرارًا» ثم اليوم وأمس
 * وأقدم، والبنود مجمّعة بالمادة خلال 24 ساعة، لكلٍّ أيقونة وكلمة نوعه وحالته؛ والمعاينة بجانبها على المكتب. j/k للتنقل وEnter للفتح وa للإقرار.
 */
export function Notifications({ locale }: { locale: Locale }) {
  const m = messages[locale], t = m.notice, b = m.shell.bell, mutation = useMutation(), list = useRef<HTMLUListElement>(null), router = useRouter(), me = useUser();
  const [data, setData] = useState<NotificationPage | null>(null), [failed, setFailed] = useState(false), [unread, setUnread] = useState(false), [cursors, setCursors] = useState<(string | undefined)[]>([undefined]), [attempt, setAttempt] = useState(0);
  const [selected, setSelected] = useState<string | null>(null), [checkedAt, setCheckedAt] = useState(0), [tab, setTab] = useState<PanelTab>("all");
  const cursor = cursors.at(-1), bulkBefore = useRef<string | null>(null);
  useEffect(() => {
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    async function load() { await untilVisible(controller.signal); if (controller.signal.aborted) return; const startedAt = Date.now(); try { const result = dataOrThrow(await browserApi().GET("/notifications", { params: { query: { limit: 50, cursor, unread_only: unread } }, signal: controller.signal })); if (!controller.signal.aborted) { setData(result); setCheckedAt(startedAt); setFailed(false); } } catch { if (!controller.signal.aborted) setFailed(true); } finally { if (!controller.signal.aborted) timer = setTimeout(load, 15000); } }
    void load(); return () => { controller.abort(); clearTimeout(timer); };
  }, [cursor, unread, attempt]);
  async function change(group: NotificationGroup, action: "read" | "ack") {
    // إقرار المجموعة وقراءتها موضعيًا؛ القراءة العامة تستخدم read-all وحده.
    const targets = group.items.filter(n => action === "ack" ? asksAck(n) : state(n) === "unread");
    for (const n of targets) if (!await mutation.run(`${n.id}:${action}`, header => action === "read" ? browserApi().POST("/notifications/{id}/read", { params: { path: { id: n.id }, header } }) : browserApi().POST("/notifications/{id}/ack", { params: { path: { id: n.id }, header } }))) break;
    setAttempt(n => n + 1); window.dispatchEvent(new Event("notifications-read"));
  }
  async function readAll() {
    if (!checkedAt) return;
    const before = bulkBefore.current ?? new Date(checkedAt).toISOString(); bulkBefore.current = before;
    if (await mutation.run(`read-all:${before}`, header => browserApi().POST("/notifications/read-all", { params: { header }, body: { before } }))) {
      bulkBefore.current = null; setAttempt(n => n + 1); window.dispatchEvent(new Event("notifications-read"));
    }
  }
  const visibleItems = data ? data.items.filter(n => inTab(n, tab)) : [], sections = data ? groupNotifications(visibleItems, checkedAt) : [], groups = sections.flatMap(s => s.groups), current = groups.find(g => g.key === selected) ?? null;
  // عنوان المادة من المادة نفسها بصلاحية المتصل (ADR 0090): من لا يقرأ المادة يرى كلمة النوع وحدها
  const titles = useMaterialTitles(groups.map(g => g.head.material_id), hasRole(me, ...materialReaders));
  const titleOf = (n: Notification) => n.material_id ? titles[n.material_id] : undefined;
  function keys(event: React.KeyboardEvent) {
    const index = groups.findIndex(g => g.key === selected);
    if (event.key === "j" || event.key === "k") { const next = groups[Math.min(groups.length - 1, Math.max(0, index + (event.key === "j" ? 1 : -1)))]; if (next) { setSelected(next.key); list.current?.querySelector<HTMLElement>(`[data-key="${next.key}"]`)?.focus(); } event.preventDefault(); }
    if (event.key === "a" && current?.items.some(asksAck)) { void change(current, "ack"); event.preventDefault(); }
  }
  const count = (which: PanelTab) => data?.items.filter(n => inTab(n, which)).length ?? 0;
  const ago = (n: Notification) => checkedAt ? t.ago.replace("{time}", humanDuration(Math.max(0, checkedAt - Date.parse(n.created_at)), locale)) : formatDate(n.created_at, locale);
  return <>
    <div className="page-head"><div><h1>{t.title}</h1><p className="muted">{t.lead}</p></div>
      <div className="page-actions"><button className="secondary" disabled={mutation.busy || !checkedAt || !groups.some(g => g.unread)} onClick={() => void readAll()}>{t.readAll}</button><button className="secondary" onClick={() => setAttempt(n => n + 1)}>{m.refresh}</button></div></div>
    <div className="notice-tools">
      <nav className="quick-tabs" aria-label={t.tabsLabel}>{panelTabs.map(which => <button key={which} type="button" className={tab === which ? "chip active" : "chip"} aria-pressed={tab === which} onClick={() => { setTab(which); setSelected(null); }}>{t.pageTabs[which]}{data ? <span className="tab-count" dir="ltr">{count(which)}</span> : null}</button>)}</nav>
      <label className="checkbox-label"><input type="checkbox" checked={unread} onChange={e => { setUnread(e.target.checked); setCursors([undefined]); setData(null); }} />{t.unread}</label>
      <p className="caption">{t.unreadCount}: <bdi dir="ltr">{data?.unread_count ?? m.notAvailable}</bdi><span className="keyboard-hint"> · {t.shortcuts}</span></p>
    </div>
    {failed && data && <section className="offline-banner" role="status"><Icon name="offline" size={22} /><div><h2>{t.staleTitle}</h2><p>{t.staleBody}</p></div><button className="secondary" onClick={() => setAttempt(n => n + 1)}>{m.retry}</button></section>}
    <ActionStatus status={mutation.status} locale={locale} />
    {!data ? failed ? <ErrorState locale={locale} title={t.staleTitle} retry={() => setAttempt(n => n + 1)}><p>{t.staleBody}</p></ErrorState>
      : <><p className="visually-hidden" role="status">{m.loading}</p><ul className="notice-list" aria-hidden="true">{[0, 1, 2].map(i => <li key={i} className="notice-item skeleton-row"><span className="skeleton circle" /><span className="row-main"><span className="skeleton line wide" /><span className="skeleton line" /></span></li>)}</ul></>
      : !data.items.length ? <EmptyState icon="bell" testId="notifications-empty" title={t.emptyTitle}><p>{t.emptyBody}</p></EmptyState>
      : !groups.length ? <EmptyState icon="filter" title={t.emptyTab} actions={<button type="button" className="secondary" onClick={() => setTab("all")}>{t.pageTabs.all}</button>} />
      : <div className="notification-grid">
        <ul className="notice-sections" ref={list} onKeyDown={keys}>{sections.map(section => <li key={section.name} className="notification-section"><h2 className="overline">{t.sections[section.name]}</h2><ul className="notice-list">
          {section.groups.map(group => { const head = group.head, status = state(head), kind = notificationKind(head);
            return <li key={group.key} data-testid="notification" className={`notice-item notification-row ${kind.urgent ? "urgent" : kind.word}${selected === group.key ? " selected" : ""}${group.unread ? " unread" : ""}`} onClick={() => setSelected(group.key)}>
              {/* البند زرّ حقيقي يقرؤه قارئ الشاشة عنصرًا تفاعليًا: يختار التنبيه للمعاينة، وEnter يفتح وجهته */}
              <button type="button" className="notice-open" data-key={group.key} aria-pressed={selected === group.key} onFocus={() => setSelected(group.key)} onKeyDown={e => { const target = notificationTarget(head, locale); if (e.key === "Enter" && target) { e.preventDefault(); router.push(target); } }}>
              <span className={`bell-icon ${kind.urgent ? "urgent" : kind.word}`}><Icon name={kind.icon} /></span>
              <span className="notice-text"><strong>{b.kinds[kind.word]}{kind.urgent && <> <span className="badge urgent" data-testid="notice-urgent">{m.states.priority.urgent}</span></>}{group.items.length > 1 && <span className="muted"> <bdi dir="ltr">+{group.items.length - 1}</bdi></span>}</strong>
                {titleOf(head) && <span className="notice-title" data-testid="notice-title"><bdi>{titleOf(head)}</bdi></span>}
                <small className="muted">{ago(head)}{head.escalation_level ? ` · ${t.escalation}: ${head.escalation_level}` : ""}</small></span></button>
              <span className={`badge state ${status === "acknowledged" ? "ok" : status === "read" ? "muted" : "brand"}`}><Icon name={status === "acknowledged" ? "check" : status === "read" ? "preview" : "bell"} size={14} />{status === "acknowledged" ? t.acknowledged : status === "read" ? t.readState : t.unreadState}</span>
              <span className="actions">{group.unread && <button className="secondary small" disabled={mutation.busy} onClick={e => { e.stopPropagation(); void change(group, "read"); }}>{t.read}</button>}
                {group.items.some(asksAck) && <button className="small" disabled={mutation.busy} onClick={e => { e.stopPropagation(); void change(group, "ack"); }}>{t.ack}</button>}</span>
            </li>; })}</ul></li>)}</ul>
        <aside className="card notification-preview-panel" aria-live="polite" aria-label={t.previewTitle}>{current ? <>
          {current.needsAck && <p className="alert urgent">{t.needsAck}</p>}<p><strong>{b.kinds[notificationKind(current.head).word]}</strong></p>{titleOf(current.head) && <p><bdi>{titleOf(current.head)}</bdi></p>}
          {notificationKind(current.head).word === "escalated" && !hasRole(me, "supervisor") && <p className="notice" data-testid="escalated-help">{t.escalatedHelp}</p>}
          <p>{formatDate(current.head.created_at, locale)}{current.items.length > 1 && <> · {plural(current.items.length, t.grouped, locale)}</>}</p>
          <div className="actions">{notificationTarget(current.head, locale) && <Link prefetch={false} className="button secondary" href={notificationTarget(current.head, locale)!}>{current.head.assignment_id ? t.openTask : !current.head.material_id && current.head.recovery_request_id ? t.openRequest : t.open}</Link>}
            {current.items.some(asksAck) && <button disabled={mutation.busy} onClick={() => void change(current, "ack")}>{t.ack}</button>}</div>
        </> : <p className="muted">{t.choose}</p>}</aside>
      </div>}
    {(cursors.length > 1 || data?.next_cursor) && <div className="pagination"><button className="secondary" disabled={cursors.length === 1 || mutation.busy} onClick={() => { setData(null); setCursors(old => old.slice(0, -1)); }}>{m.previous}</button><span>{m.page} <bdi dir="ltr">{cursors.length}</bdi></span><button className="secondary" disabled={!data?.next_cursor || mutation.busy} onClick={() => { setCursors(old => [...old, data!.next_cursor!]); setData(null); }}>{m.next}</button></div>}
  </>;
}
