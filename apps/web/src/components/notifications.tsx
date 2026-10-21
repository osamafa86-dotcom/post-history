"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { browserApi, dataOrThrow } from "@/lib/browser-api";
import { formatDate, messages, type Locale } from "@/lib/i18n";
import type { NotificationPage } from "@/lib/types";
import { uuid } from "@/lib/query";
import { useMutation } from "@/lib/use-mutation";
import { ActionStatus } from "./action-status";

export function Notifications({ locale }: { locale: Locale }) {
  const m = messages[locale], t = m.notice, mutation = useMutation();
  const [data, setData] = useState<NotificationPage | null>(null), [failed, setFailed] = useState(false), [unread, setUnread] = useState(false), [cursors, setCursors] = useState<(string | undefined)[]>([undefined]), [attempt, setAttempt] = useState(0);
  const cursor = cursors.at(-1);
  useEffect(() => {
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    async function load() { try { const result = dataOrThrow(await browserApi().GET("/notifications", { params: { query: { limit: 50, cursor, unread_only: unread } }, signal: controller.signal })); if (!controller.signal.aborted) { setData(result); setFailed(false); } } catch { if (!controller.signal.aborted) setFailed(true); } finally { if (!controller.signal.aborted) timer = setTimeout(load, 15000); } }
    void load(); return () => { controller.abort(); clearTimeout(timer); };
  }, [cursor, unread, attempt]);
  async function change(id: string, action: "read" | "ack") {
    const ok = await mutation.run(`${id}:${action}`, header => action === "read" ? browserApi().POST("/notifications/{id}/read", { params: { path: { id }, header } }) : browserApi().POST("/notifications/{id}/ack", { params: { path: { id }, header } }));
    if (ok) setAttempt(n => n + 1);
  }
  return <><div className="page-heading"><div><h1>{t.title}</h1><p className="muted">{t.lead}</p></div><button className="secondary" onClick={() => setAttempt(n => n + 1)}>{m.refresh}</button></div>
    <div className="table-tools"><label className="checkbox-label"><input type="checkbox" checked={unread} onChange={e => { setUnread(e.target.checked); setCursors([undefined]); setData(null); }} />{t.unread}</label><p>{t.unreadCount}: {data?.unread_count ?? m.notAvailable}</p></div>
    {failed && <p className="notice error" role="alert">{data ? m.stale : m.error}</p>}<ActionStatus status={mutation.status} locale={locale} />
    {!data ? <p role="status" className="center-state">{failed ? m.error : m.loading}</p> : !data.items.length ? <p className="empty">{t.empty}</p> : <ul className="notification-list">{data.items.map(item => <li className="card" key={item.id} data-testid="notification"><div className="page-heading"><h2>{t.generic}</h2><span className="badge">{item.acknowledged_at || item.state === "acknowledged" ? t.acknowledged : item.read_at || item.state === "read" ? t.readState : t.unreadState}</span></div><p>{formatDate(item.created_at, locale)}</p><p className="muted">{t.escalation}: {item.escalation_level ?? 0}</p><div className="actions">
      {item.material_id && uuid.test(item.material_id) && <Link prefetch={false} className="back-link" href={`/${locale}/materials/${item.material_id}`}>{t.open}</Link>}
      {!item.read_at && (item.state === "sent" || item.state === "delivered") && <button className="secondary" disabled={mutation.busy} onClick={() => void change(item.id, "read")}>{t.read}</button>}
      {!item.acknowledged_at && item.state !== "acknowledged" && <button disabled={mutation.busy} onClick={() => void change(item.id, "ack")}>{t.ack}</button>}
    </div></li>)}</ul>}
    <div className="pagination"><button className="secondary" disabled={cursors.length === 1 || mutation.busy} onClick={() => { setData(null); setCursors(old => old.slice(0, -1)); }}>{m.previous}</button><span>{m.page} {cursors.length}</span><button className="secondary" disabled={!data?.next_cursor || mutation.busy} onClick={() => { setCursors(old => [...old, data!.next_cursor!]); setData(null); }}>{m.next}</button></div>
  </>;
}
