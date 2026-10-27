"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { browserApi, dataOrThrow } from "@/lib/browser-api";
import { beep } from "@/lib/alert-sound";
import { formatDate, humanDuration, longDate, messages, shortTime, type Locale } from "@/lib/i18n";
import type { Material, MaterialPage, MaterialQuery, NewsroomDashboard } from "@/lib/types";
import { materialQuery, states } from "@/lib/query";
import { photographer, type StateTrack } from "./states";
import { TrackLine } from "./track-line";
import { activeTab, inboxTabs, isOpenUrgent, matchesSearch, tabCounts, tabQuery, type InboxTab } from "@/lib/inbox-tabs";
import { clock, urgentUnacknowledged } from "@/lib/editor";
import { hasRole, transitionOptions } from "@/lib/review";
import { useMutation } from "@/lib/use-mutation";
import { useUser } from "./session-boundary";
import { ActionStatus } from "./action-status";
import { InboxNow } from "./newsroom-board";

const dashboardRoles = ["supervisor", "producer", "editor_in_chief", "rights_officer", "system_admin"] as const;

type Sort = "shot_at" | "governorate" | "reporter_id" | StateTrack;
export function Inbox({ locale }: { locale: Locale }) {
  const m = messages[locale], [query, setQuery] = useState<MaterialQuery>({ limit: 50 }), [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const [page, setPage] = useState<MaterialPage | null>(null), [error, setError] = useState(false), [invalid, setInvalid] = useState(false), [offline, setOffline] = useState(false), [unread, setUnread] = useState(0), [updated, setUpdated] = useState("");
  const [refresh, setRefresh] = useState(0), [sort, setSort] = useState<Sort>("shot_at"), [descending, setDescending] = useState(true), [needle, setNeedle] = useState(""), [formKey, setFormKey] = useState(0);
  const me = useUser(), staff = hasRole(me, ...dashboardRoles), [snapshot, setSnapshot] = useState<NewsroomDashboard | null>(null), [now, setNow] = useState(0);
  // لقطة غرفة الأخبار كل 5 ثوانٍ (حداثتها في العقد) لأدوار اللوحة وحدها؛ والعدّاد الحي كل ثانية.
  useEffect(() => {
    if (!staff) return;
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    async function poll() { try { const data = dataOrThrow(await browserApi().GET("/dashboard/newsroom", { signal: controller.signal })); if (!controller.signal.aborted) setSnapshot(data); } catch { /* الإحصاءات تبقى بآخر قيمة */ } finally { if (!controller.signal.aborted) timer = setTimeout(poll, 5000); } }
    void poll(); return () => { controller.abort(); clearTimeout(timer); };
  }, [staff, refresh]);
  useEffect(() => { const tick = () => setNow(Date.now()); tick(); const timer = setInterval(tick, 1000); return () => clearInterval(timer); }, []);
  useEffect(() => {
    const controller = new AbortController(); let disposed = false, timer: ReturnType<typeof setTimeout>;
    async function poll() {
      if (!navigator.onLine) { setOffline(true); timer = setTimeout(poll, 15000); return; }
      try {
        // الاستطلاع تسلسلي؛ لا تتراكم طلبات عند البطء ولا تُحفظ حمولة الإشعار في الواجهة.
        const notification = dataOrThrow(await browserApi().GET("/notifications", { signal: controller.signal }));
        const data = dataOrThrow(await browserApi().GET("/materials", { params: { query }, signal: controller.signal }));
        if (!disposed) { setPage(data); setUnread(notification.unread_count); setError(false); setOffline(false); setUpdated(new Date().toISOString()); }
      } catch { if (!disposed && !controller.signal.aborted) setError(true); }
      finally { if (!disposed) timer = setTimeout(poll, 15000); }
    }
    const online = () => { clearTimeout(timer); setRefresh(n => n + 1); };
    window.addEventListener("online", online); void poll();
    return () => { disposed = true; controller.abort(); clearTimeout(timer); window.removeEventListener("online", online); };
  }, [query, refresh]);
  const rows = useMemo(() => [...(page?.items ?? [])].sort((a, b) => {
    const av = a[sort] ?? "", bv = b[sort] ?? "";
    const result = sort === "shot_at" ? (Date.parse(av) || 0) - (Date.parse(bv) || 0) : av.localeCompare(bv, locale);
    return (descending ? -1 : 1) * result;
  }), [page, sort, descending, locale]);
  const tab = activeTab(query), counts = snapshot ? tabCounts(snapshot) : null;
  const visible = useMemo(() => rows.filter(item => (tab !== "urgent" || isOpenUrgent(item)) && matchesSearch(needle, [item.title, item.governorate, item.files.find(f => f.receipt_number)?.receipt_number])), [rows, tab, needle]);
  function choose(next: InboxTab) { setQuery({ limit: 50, ...tabQuery[next] }); setPage(null); setCursors([undefined]); setInvalid(false); setFormKey(n => n + 1); }
  function filter(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); const data = new FormData(event.currentTarget), params = new URLSearchParams();
    for (const [key, value] of data) if (typeof value === "string" && value) params.set(key, key.startsWith("shot_") ? new Date(value).toISOString() : value);
    try { setQuery({ ...materialQuery(params), limit: 50 }); setPage(null); setCursors([undefined]); setInvalid(false); } catch { setInvalid(true); }
  }
  function move(next: boolean) {
    const stack = next ? [...cursors, page?.next_cursor ?? undefined] : cursors.slice(0, -1);
    setCursors(stack); setQuery({ ...query, cursor: stack.at(-1) }); setPage(null);
  }
  const summary = counts && m.inboxSummary.replace("{total}", String(counts.all)).replace("{urgent}", String(counts.urgent)).replace("{inbox}", String(counts.inbox)).replace("{reviewing}", String(counts.reviewing)).replace("{accepted}", String(counts.accepted)).replace("{stopped}", String(counts.stopped));
  return <>
    {page && <UrgentAlert locale={locale} items={urgentUnacknowledged(page.items)} now={now} done={() => setRefresh(n => n + 1)} showAll={() => { setQuery({ limit: 50, priority: "urgent", editorial_state: "inbox" }); setPage(null); setCursors([undefined]); }} />}
    <div className="inbox-head"><h1>{m.inbox}</h1><p className="inbox-summary">{summary ?? m.inboxLead}</p></div>
    <div className="live-strip" aria-live="polite"><span className="live-dot" aria-hidden="true" />{m.live}<span>{m.notifications}: <b>{unread}</b></span>{updated && <small>{m.updated}: {formatDate(updated, locale)}</small>}<button className="secondary" onClick={() => setRefresh(n => n + 1)}>{m.refresh}</button></div>
    <div className="inbox-tools">
      <div className="inbox-search"><label htmlFor="inbox-search" className="visually-hidden">{m.inboxSearch.label}</label><input id="inbox-search" type="search" value={needle} onChange={e => setNeedle(e.target.value)} placeholder={m.inboxSearch.placeholder} aria-describedby="inbox-search-help" maxLength={200} /><small id="inbox-search-help" className="visually-hidden">{m.inboxSearch.help}</small></div>
      <nav className="quick-tabs" aria-label={m.inboxTabs.label}>{inboxTabs.map(item => <button key={item} type="button" className={tab === item ? "tab active" : "tab"} aria-pressed={tab === item} onClick={() => choose(item)}>{m.inboxTabs[item]}{counts && <> <span className="tab-count" dir="ltr">{counts[item]}</span></>}</button>)}</nav>
    </div>
    <details className="filter-panel"><summary>{m.filters}</summary><form key={formKey} onSubmit={filter} className="filters">
      {(Object.keys(states) as (keyof typeof states)[]).map(key => <label key={key}>{key === "priority" ? m.priority : key === "technical_state" ? m.technical : key === "editorial_state" ? m.editorial : m.rights}<select name={key}><option value="">{m.all}</option>{states[key].map(state => <option key={state} value={state}>{(m.states[key] as Record<string, string>)[state]}</option>)}</select></label>)}
      <label>{m.governorate}<input name="governorate" maxLength={64} /></label><label>{m.reporterId}<input name="reporter_id" dir="ltr" /></label><label>{m.shotAfter}<input type="datetime-local" name="shot_after" /></label><label>{m.shotBefore}<input type="datetime-local" name="shot_before" /></label><div className="actions"><button>{m.apply}</button><button type="reset" className="quiet" onClick={() => { setPage(null); setQuery({ limit: 50 }); setCursors([undefined]); setInvalid(false); }}>{m.reset}</button></div>
    </form>{invalid && <p className="notice error" role="alert">{m.invalidFilters}</p>}</details>
    {(error || offline) && <p className="notice attention" role="status">{offline ? m.offline : page ? `${m.stale} ${updated ? clock(updated, now) : ""}` : m.error}</p>}
    <section className="table-panel" aria-label={m.inbox}>
      <div className="table-tools"><label>{m.sort}<select value={sort} onChange={e => setSort(e.target.value as Sort)}>{([ ["shot_at", m.shotAt], ["governorate", m.governorate], ["reporter_id", m.reporterId], ["technical_state", m.technical], ["editorial_state", m.editorial], ["rights_state", m.rights] ] as [Sort, string][]).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label><button className="quiet" onClick={() => setDescending(!descending)}>{descending ? m.descending : m.ascending}</button><small className="muted">{m.pageSortNote}</small></div>
      {!page ? <p className="empty" role="status">{error ? m.error : m.loading}</p> : visible.length === 0 ? <p className="empty">{m.empty}</p> : <div className="table-scroll"><table className="inbox-table"><thead><tr><th scope="col">{m.title}</th><th scope="col">{m.trackLine.column}</th><th scope="col">{m.receipt}</th></tr></thead><tbody>{visible.map(material => <MaterialRow key={material.id} material={material} locale={locale} />)}</tbody></table></div>}
      <footer className="pagination"><span>{m.page} {cursors.length}</span><div className="actions"><button className="secondary" disabled={cursors.length === 1 || !page} onClick={() => move(false)}>{m.previous}</button><button className="secondary" disabled={!page?.next_cursor} onClick={() => move(true)}>{m.next}</button></div></footer>
    </section>
    {snapshot ? <div className="stats editor-stats">
      <article className={snapshot.urgent_open ? "tone-urgent" : ""} data-testid="stat-urgent"><span>{m.editor.urgentOpen}</span><strong>{snapshot.urgent_open}</strong></article>
      <article className="tone-neutral"><span>{m.pendingCount}</span><strong>{snapshot.technical.find(x => x.state === "pending")?.count ?? 0}</strong></article>
      <article className={snapshot.overdue_acknowledgements ? "tone-attention" : ""}><span>{m.editor.overdue}</span><strong>{snapshot.overdue_acknowledgements}</strong></article>
      <article className="tone-progress"><span>{m.editor.reserved}</span><strong>{snapshot.reserved.length}</strong></article></div>
    : <div className="stats"><article><span>{m.visibleCount}</span><strong>{page?.items.length ?? "—"}</strong></article><article><span>{m.pendingCount}</span><strong>{page?.items.filter(x => x.technical_state === "pending").length ?? "—"}</strong></article><article><span>{m.urgentCount}</span><strong>{page?.items.filter(x => x.priority === "urgent").length ?? "—"}</strong></article></div>}
    {snapshot && <InboxNow locale={locale} snapshot={snapshot} now={now} />}
  </>;
}
/** صف الوارد (Figma 169:97): المادة بسطر وصف (الأولوية والمحافظة والتاريخ والساعة) وشريط عاجل على حافة البداية، ثم خط المسارات، ثم رقم الإيصال. */
function MaterialRow({ material, locale }: { material: Material; locale: Locale }) {
  const m = messages[locale], receipt = material.files.find(f => f.receipt_number)?.receipt_number, urgent = material.priority === "urgent", time = shortTime(material.shot_at);
  return <tr data-testid="material-row" className={urgent ? "urgent" : undefined}>
    <td className="material-cell"><Link className="material-link" prefetch={false} href={`/${locale}/materials/${material.id}`}>{material.title}</Link>
      <p className="material-meta">{material.priority !== "normal" && <span className={`priority ${material.priority}`}>{m.states.priority[material.priority]}</span>}<span>{material.governorate}</span><span>{longDate(material.shot_at, locale)}</span>{time && <span dir="ltr">{time}</span>}<span className="muted">{photographer(material, locale)}</span></p></td>
    <td className="tracks-cell"><TrackLine material={material} locale={locale} note /></td>
    <td className="receipt" dir="ltr">{receipt ?? m.noReceipt}</td></tr>;
}

/** التنبيه العاجل (B1): ما دامت مادة عاجلة بلا اطّلاع، بعدّاد منذ وصولها وزر «اطّلعت»؛ وصوت مرة لكل مادة جديدة ما لم يُكتم على هذا الجهاز. */
function UrgentAlert({ locale, items, now, done, showAll }: { locale: Locale; items: Material[]; now: number; done: () => void; showAll: () => void }) {
  const m = messages[locale], t = m.editor, me = useUser(), mutation = useMutation(), heard = useRef(new Set<string>());
  const [muted, setMuted] = useState(() => { try { return localStorage.getItem("ph-urgent-muted") === "1"; } catch { return false; } });
  useEffect(() => {
    const fresh = items.filter(item => !heard.current.has(item.id));
    fresh.forEach(item => heard.current.add(item.id));
    if (!fresh.length || muted || !navigator.userActivation?.hasBeenActive) return;
    beep();
  }, [items, muted]);
  if (!items.length) return null;
  const first = items[0], single = items.length === 1, tag = Number.isSafeInteger(first.row_version) ? `"${first.row_version}"` : null;
  const canAck = single && !!tag && transitionOptions(first, me, "editorial").includes("acknowledged");
  async function acknowledge() {
    if (!tag) return;
    const body = { track: "editorial" as const, to: "acknowledged", reason: t.ackReason };
    if (await mutation.run(`${first.id}:ack:${tag}`, header => browserApi().POST("/materials/{id}/transitions", { params: { path: { id: first.id }, header: { ...header, "If-Match": tag } }, body }))) done();
  }
  const due = first.acknowledgement_due_at ? Date.parse(first.acknowledgement_due_at) : NaN, escalation = !single || !Number.isFinite(due) ? null : due > now ? t.escalatesIn.replace("{time}", humanDuration(due - now, locale)) : t.escalationDue;
  return <section className="alert urgent" role="alert" aria-labelledby="urgent-title" data-testid="urgent-alert">
    <div><h2 id="urgent-title">{single ? t.urgentOne : t.urgentMany.replace("{n}", String(items.length))} {t.since} <span data-testid="urgent-since">{humanDuration(now - Date.parse(first.created_at), locale)}</span></h2>
      {escalation && <p data-testid="urgent-escalation">{escalation}</p>}
      {single ? <p><Link prefetch={false} href={`/${locale}/materials/${first.id}`}>{first.title}</Link></p> : <p>{t.urgentManyHelp}</p>}</div>
    <div className="actions">{canAck && <button onClick={() => void acknowledge()} disabled={mutation.busy}>{t.ack}</button>}{!single && <button className="secondary" onClick={showAll}>{t.showUrgent}</button>}
      <label className="check"><input type="checkbox" checked={muted} onChange={e => { setMuted(e.target.checked); try { localStorage.setItem("ph-urgent-muted", e.target.checked ? "1" : "0"); } catch { /* تفضيل محلي اختياري */ } }} />{t.mute}</label></div>
    <ActionStatus status={mutation.status} locale={locale} />
  </section>;
}
