"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { browserApi, dataOrThrow } from "@/lib/browser-api";
import { formatDate, messages, type Locale } from "@/lib/i18n";
import type { Notification, NotificationPage } from "@/lib/types";
import { uuid } from "@/lib/query";
import { groupNotifications, type NotificationGroup } from "@/lib/editor";
import { useMutation } from "@/lib/use-mutation";
import { ActionStatus } from "./action-status";

const state = (n: Notification) => n.acknowledged_at || n.state === "acknowledged" ? "acknowledged" : n.read_at || n.state === "read" ? "read" : "unread";

/** التنبيهات (B4): قائمة مضغوطة مجمّعة بالمادة خلال 24 ساعة بأقسام، ومعاينة بجانبها؛ j/k للتنقل وEnter للفتح وa للإقرار. */
export function Notifications({ locale }: { locale: Locale }) {
  const m = messages[locale], t = m.notice, mutation = useMutation(), list = useRef<HTMLUListElement>(null), router = useRouter();
  const [data, setData] = useState<NotificationPage | null>(null), [failed, setFailed] = useState(false), [unread, setUnread] = useState(false), [cursors, setCursors] = useState<(string | undefined)[]>([undefined]), [attempt, setAttempt] = useState(0);
  const [selected, setSelected] = useState<string | null>(null), [checkedAt, setCheckedAt] = useState(0);
  const cursor = cursors.at(-1), bulkBefore = useRef<string | null>(null);
  useEffect(() => {
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    async function load() { const startedAt = Date.now(); try { const result = dataOrThrow(await browserApi().GET("/notifications", { params: { query: { limit: 50, cursor, unread_only: unread } }, signal: controller.signal })); if (!controller.signal.aborted) { setData(result); setCheckedAt(startedAt); setFailed(false); } } catch { if (!controller.signal.aborted) setFailed(true); } finally { if (!controller.signal.aborted) timer = setTimeout(load, 15000); } }
    void load(); return () => { controller.abort(); clearTimeout(timer); };
  }, [cursor, unread, attempt]);
  async function change(group: NotificationGroup, action: "read" | "ack") {
    // إقرار المجموعة وقراءتها موضعيًا؛ القراءة العامة تستخدم read-all وحده.
    const targets = group.items.filter(n => action === "ack" ? state(n) !== "acknowledged" : state(n) === "unread");
    for (const n of targets) if (!await mutation.run(`${n.id}:${action}`, header => action === "read" ? browserApi().POST("/notifications/{id}/read", { params: { path: { id: n.id }, header } }) : browserApi().POST("/notifications/{id}/ack", { params: { path: { id: n.id }, header } }))) break;
    setAttempt(n => n + 1);
  }
  async function readAll() {
    if (!checkedAt) return;
    const before = bulkBefore.current ?? new Date(checkedAt).toISOString(); bulkBefore.current = before;
    if (await mutation.run(`read-all:${before}`, header => browserApi().POST("/notifications/read-all", { params: { header }, body: { before } }))) {
      bulkBefore.current = null; setAttempt(n => n + 1);
    }
  }
  const sections = data ? groupNotifications(data.items, checkedAt) : [], groups = sections.flatMap(s => s.groups), current = groups.find(g => g.key === selected) ?? null;
  function keys(event: React.KeyboardEvent) {
    const index = groups.findIndex(g => g.key === selected);
    if (event.key === "j" || event.key === "k") { const next = groups[Math.min(groups.length - 1, Math.max(0, index + (event.key === "j" ? 1 : -1)))]; if (next) { setSelected(next.key); list.current?.querySelector<HTMLElement>(`[data-key="${next.key}"]`)?.focus(); } event.preventDefault(); }
    if (event.key === "a" && current?.needsAck) { void change(current, "ack"); event.preventDefault(); }
  }
  const label = (group: NotificationGroup) => group.head.priority === "urgent" ? t.urgentType : t.generic;
  return <><div className="page-heading"><div><h1>{t.title}</h1><p className="muted">{t.lead}</p></div><div className="actions"><button className="secondary" disabled={mutation.busy || !checkedAt || !groups.some(g => g.unread)} onClick={() => void readAll()}>{t.readAll}</button><button className="secondary" onClick={() => setAttempt(n => n + 1)}>{m.refresh}</button></div></div>
    <div className="table-tools"><label className="checkbox-label"><input type="checkbox" checked={unread} onChange={e => { setUnread(e.target.checked); setCursors([undefined]); setData(null); }} />{t.unread}</label><p>{t.unreadCount}: {data?.unread_count ?? m.notAvailable}</p><small className="muted">{t.shortcuts}</small></div>
    {failed && <p className="notice error" role="alert">{data ? m.stale : m.error}</p>}<ActionStatus status={mutation.status} locale={locale} />
    {!data ? <p role="status" className="center-state">{failed ? m.error : m.loading}</p> : !groups.length ? <p className="empty">{t.empty}</p> : <div className="notification-grid">
      <ul className="notification-list compact" ref={list} onKeyDown={keys}>{sections.map(section => <li key={section.name} className="notification-section"><h2 className="overline">{t.sections[section.name]}</h2><ul>
        {section.groups.map(group => { const head = group.head, status = state(head);
          return <li key={group.key} data-key={group.key} data-testid="notification" tabIndex={0} className={`notification-row ${selected === group.key ? "selected" : ""} ${group.unread ? "unread" : ""}`} onFocus={() => setSelected(group.key)} onClick={() => setSelected(group.key)} onKeyDown={e => { if (e.key === "Enter" && head.material_id && uuid.test(head.material_id)) router.push(`/${locale}/materials/${head.material_id}`); }}>
            <span className={`notification-icon tone-${head.priority === "urgent" ? "bad" : "neutral"}`} aria-hidden="true" />
            <span className="notification-text"><strong>{label(group)}{group.items.length > 1 && <span className="muted"> +{group.items.length - 1}</span>}</strong><small className="muted">{formatDate(head.created_at, locale)}{head.escalation_level ? ` · ${t.escalation}: ${head.escalation_level}` : ""}</small></span>
            <span className="badge">{status === "acknowledged" ? t.acknowledged : status === "read" ? t.readState : t.unreadState}</span>
            <span className="actions">{group.unread && <button className="secondary" disabled={mutation.busy} onClick={e => { e.stopPropagation(); void change(group, "read"); }}>{t.read}</button>}
              {status !== "acknowledged" && <button disabled={mutation.busy} onClick={e => { e.stopPropagation(); void change(group, "ack"); }}>{t.ack}</button>}</span>
          </li>; })}</ul></li>)}</ul>
      <aside className="card notification-preview-panel" aria-live="polite">{current ? <>
        {current.needsAck ? <p className="alert urgent">{t.needsAck}</p> : <p className="muted">{label(current)}</p>}
        <p>{formatDate(current.head.created_at, locale)}{current.items.length > 1 && <> · {t.grouped.replace("{n}", String(current.items.length))}</>}</p>
        <div className="actions">{current.head.material_id && uuid.test(current.head.material_id) && <Link prefetch={false} className="back-link" href={`/${locale}/materials/${current.head.material_id}`}>{t.open}</Link>}
          {state(current.head) !== "acknowledged" && <button disabled={mutation.busy} onClick={() => void change(current, "ack")}>{t.ack}</button>}</div>
      </> : <p className="muted">{t.choose}</p>}</aside>
    </div>}
    <div className="pagination"><button className="secondary" disabled={cursors.length === 1 || mutation.busy} onClick={() => { setData(null); setCursors(old => old.slice(0, -1)); }}>{m.previous}</button><span>{m.page} {cursors.length}</span><button className="secondary" disabled={!data?.next_cursor || mutation.busy} onClick={() => { setCursors(old => [...old, data!.next_cursor!]); setData(null); }}>{m.next}</button></div>
  </>;
}
