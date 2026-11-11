"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { browserApi, dataOrThrow, RequestError } from "@/lib/browser-api";
import { beep } from "@/lib/alert-sound";
import { humanDuration, longDate, messages, plural, shortTime, type Locale } from "@/lib/i18n";
import type { Material, MaterialPage, MaterialQuery, NewsroomDashboard } from "@/lib/types";
import { materialQuery, materialTypes, states } from "@/lib/query";
import { isSensitive } from "@/lib/render-policy";
import { photographer, StateBadge, type StateTrack } from "./states";
import { Icon } from "./icon";
import { EmptyState, NoAccess } from "./empty-state";
import { useInboxBadge, useShellSearch } from "./app-shell";
import { activeTab, inboxTabs, isOpenUrgent, matchesSearch, matchesType, rowThumb, tabCounts, tabQuery, type InboxTab } from "@/lib/inbox-tabs";
import { urgentUnacknowledged } from "@/lib/editor";
import { hasRole, materialReaders, transitionOptions } from "@/lib/review";
import { useMutation } from "@/lib/use-mutation";
import { useUser } from "./session-boundary";
import { ActionStatus } from "./action-status";
import { InboxNow } from "./newsroom-board";
import { AssignButton } from "./task-parts";

const dashboardRoles = ["supervisor", "producer", "editor_in_chief", "rights_officer", "system_admin"] as const;
const filterKeys = ["priority", "technical_state", "editorial_state", "rights_state", "governorate", "reporter_id", "shot_after", "shot_before"] as const;
type FilterKey = (typeof filterKeys)[number];
type Messages = (typeof messages)[Locale];

type Sort = "shot_at" | "governorate" | "reporter_id" | StateTrack;
/**
 * الوارد (W1، والجوال M1، واللوح T1): رأس بحالة الاتصال، ومؤشّرات اللقطة، وتصفية سريعة برقاقات، وصفوف بمصغّرة وشارات الحالات الثلاث منفصلة،
 * والعاجل أولًا (شريط التنبيه فوق كل شيء، وتبويب «عاجلة»). الحالات: E1 فارغ، E2 هياكل، E3 انقطاع (آخر بيانات كما هي وأفعالها معطّلة)، E4 بلا نتائج.
 * البحث في الشريط العلوي، داخل الصفحة المحمّلة كما كان (العقد بلا معامل بحث).
 */
export function Inbox({ locale }: { locale: Locale }) {
  const m = messages[locale], w = m.shell.inbox, [query, setQuery] = useState<MaterialQuery>({ limit: 50 }), [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const [page, setPage] = useState<MaterialPage | null>(null), [error, setError] = useState(false), [invalid, setInvalid] = useState(false), [offline, setOffline] = useState(false), [unread, setUnread] = useState(0), [updated, setUpdated] = useState("");
  const [refresh, setRefresh] = useState(0), [sort, setSort] = useState<Sort>("shot_at"), [descending, setDescending] = useState(true), [formKey, setFormKey] = useState(0);
  const [type, setType] = useState("");
  const { query: needle, setQuery: setNeedle } = useShellSearch(), setBadge = useInboxBadge();
  const me = useUser(), staff = hasRole(me, ...dashboardRoles), [snapshot, setSnapshot] = useState<NewsroomDashboard | null>(null), [now, setNow] = useState(0);
  // E5: الوارد لمن يقرأ المواد وحده، و403 من الخادم (نطاق تغيّر) يقول السبب بدل «تعذّر التحميل».
  const reader = hasRole(me, ...materialReaders), [forbidden, setForbidden] = useState(false);
  // لقطة غرفة الأخبار كل 5 ثوانٍ (حداثتها في العقد) لأدوار اللوحة وحدها؛ والعدّاد الحي كل ثانية.
  useEffect(() => {
    if (!staff) return;
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    async function poll() { try { const data = dataOrThrow(await browserApi().GET("/dashboard/newsroom", { signal: controller.signal })); if (!controller.signal.aborted) { setSnapshot(data); setBadge(data.urgent_open); } } catch { /* الإحصاءات تبقى بآخر قيمة */ } finally { if (!controller.signal.aborted) timer = setTimeout(poll, 5000); } }
    void poll(); return () => { controller.abort(); clearTimeout(timer); };
  }, [staff, refresh, setBadge]);
  useEffect(() => { const tick = () => setNow(Date.now()); tick(); const timer = setInterval(tick, 1000); return () => clearInterval(timer); }, []);
  useEffect(() => {
    if (!reader) return;
    const controller = new AbortController(); let disposed = false, stopped = false, timer: ReturnType<typeof setTimeout>;
    async function poll() {
      if (!navigator.onLine) { setOffline(true); timer = setTimeout(poll, 15000); return; }
      try {
        // الاستطلاع تسلسلي؛ لا تتراكم طلبات عند البطء ولا تُحفظ حمولة الإشعار في الواجهة.
        const notification = dataOrThrow(await browserApi().GET("/notifications", { signal: controller.signal }));
        const data = dataOrThrow(await browserApi().GET("/materials", { params: { query }, signal: controller.signal }));
        if (!disposed) { setPage(data); setUnread(notification.unread_count); setError(false); setOffline(false); setUpdated(new Date().toISOString()); }
      } catch (e) {
        if (disposed || controller.signal.aborted) return;
        if (e instanceof RequestError && e.status === 403) { stopped = true; setForbidden(true); } else setError(true);
      }
      finally { if (!disposed && !stopped) timer = setTimeout(poll, 15000); }
    }
    const online = () => { clearTimeout(timer); setRefresh(n => n + 1); };
    const lost = () => setOffline(true);
    window.addEventListener("online", online); window.addEventListener("offline", lost); void poll();
    return () => { disposed = true; controller.abort(); clearTimeout(timer); window.removeEventListener("online", online); window.removeEventListener("offline", lost); };
  }, [query, refresh, reader]);
  const rows = useMemo(() => [...(page?.items ?? [])].sort((a, b) => {
    const av = a[sort] ?? "", bv = b[sort] ?? "";
    const result = sort === "shot_at" ? (Date.parse(av) || 0) - (Date.parse(bv) || 0) : av.localeCompare(bv, locale);
    return (descending ? -1 : 1) * result;
  }), [page, sort, descending, locale]);
  const tab = activeTab(query), counts = snapshot ? tabCounts(snapshot) : null;
  const tabbed = useMemo(() => rows.filter(item => (tab !== "urgent" || isOpenUrgent(item)) && matchesType(item, type)), [rows, tab, type]);
  const visible = useMemo(() => tabbed.filter(item => matchesSearch(needle, searchFields(item))), [tabbed, needle]);
  function choose(next: InboxTab) { setQuery({ limit: 50, ...tabQuery[next] }); setPage(null); setCursors([undefined]); setInvalid(false); setFormKey(n => n + 1); }
  function filter(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); const data = new FormData(event.currentTarget), params = new URLSearchParams();
    for (const [key, value] of data) if (typeof value === "string" && value) params.set(key, key.startsWith("shot_") ? new Date(value).toISOString() : value);
    try { setQuery({ ...materialQuery(params), limit: 50 }); setPage(null); setCursors([undefined]); setInvalid(false); } catch { setInvalid(true); }
  }
  function drop(key: FilterKey) { const next: MaterialQuery = { ...query, cursor: undefined }; delete next[key]; setQuery(next); setPage(null); setCursors([undefined]); setFormKey(n => n + 1); }
  function clearAll() { setNeedle(""); setType(""); choose("all"); }
  function move(next: boolean) {
    const stack = next ? [...cursors, page?.next_cursor ?? undefined] : cursors.slice(0, -1);
    setCursors(stack); setQuery({ ...query, cursor: stack.at(-1) }); setPage(null);
  }
  const summary = counts && m.inboxSummary.replace("{total}", String(counts.all)).replace("{urgent}", String(counts.urgent)).replace("{inbox}", String(counts.inbox)).replace("{reviewing}", String(counts.reviewing)).replace("{accepted}", String(counts.accepted)).replace("{stopped}", String(counts.stopped));
  // E3: آخر بيانات معروضة كما هي، ووقت آخر تحديث، والأفعال معطّلة حتى يعود الاتصال.
  const disconnected = offline || (error && !!page);
  const active = filterKeys.filter(key => query[key] !== undefined && !(tab && key in tabQuery[tab]));
  const search = needle.trim();
  const chips = [
    ...(search ? [{ key: "search", label: `«${search}»`, remove: () => setNeedle("") }] : []),
    ...(tab && tab !== "all" ? [{ key: "tab", label: m.inboxTabs[tab], remove: () => choose("all") }] : []),
    ...(type ? [{ key: "type", label: `${w.typeFilter.label}: ${(m.types as Record<string, string>)[type] ?? type}`, remove: () => setType("") }] : []),
    ...active.map(key => ({ key, label: `${filterLabel(key, m)}: ${filterValue(key, String(query[key]), m, locale)}`, remove: () => drop(key) })),
  ];
  const lastArrival = snapshot?.recent_receipts[0]?.verified_at;
  let list: React.ReactNode;
  if (!page) list = error ? null : <><p className="visually-hidden" role="status">{m.loading}</p><ul className="inbox-rows" aria-hidden="true" data-testid="inbox-skeleton">{[0, 1, 2, 3, 4].map(i => <li key={i} className="inbox-row skeleton-row"><span className="skeleton thumb" /><span className="row-main"><span className="skeleton line wide" /><span className="skeleton line" /></span><span className="skeleton pill" /></li>)}</ul></>;
  else if (visible.length) list = <ul className="inbox-rows">{visible.map(material => <MaterialRow key={material.id} material={material} locale={locale} now={now} disabled={disconnected} done={() => setRefresh(n => n + 1)} />)}</ul>;
  else if (chips.length || cursors.length > 1) list = <EmptyState icon="search" testId="inbox-no-results" title={search ? w.noResultsFor.replace("{q}", search) : m.empty}
    actions={search && tabbed.length ? <button type="button" onClick={() => setNeedle("")}>{w.showWithoutSearch.replace("{n}", String(tabbed.length))}</button> : chips.length ? <button type="button" className="secondary" onClick={clearAll}>{w.clearAll}</button> : null}>
    <p>{search ? (tabbed.length ? w.noResultsHint.replace("{count}", plural(tabbed.length, m.counts.materials, locale)) : w.noResultsNone) : w.noFilterResults}</p></EmptyState>;
  else list = <EmptyState icon="inbox" testId="inbox-empty" title={w.emptyTitle} actions={staff ? <Link prefetch={false} className="button" href={`/${locale}/board`}>{m.board.title}</Link> : null}>
    <p>{w.emptyBody}{lastArrival && now ? <> {w.lastArrival.replace("{time}", humanDuration(now - Date.parse(lastArrival), locale))}</> : null}</p></EmptyState>;
  if (!reader || forbidden) return <NoAccess locale={locale} me={me} title={m.inbox} denied={w.denied} />;
  return <>
    {page && staff && <UrgentAlert locale={locale} items={urgentUnacknowledged(page.items)} now={now} disabled={disconnected} done={() => setRefresh(n => n + 1)} showAll={() => { setQuery({ limit: 50, priority: "urgent", editorial_state: "inbox" }); setPage(null); setCursors([undefined]); }} />}
    <div className="page-head inbox-head">
      <div><h1>{m.inbox}</h1>
        <p className={`live-line${disconnected ? " stale" : ""}`} aria-live="polite"><span className="live-dot" aria-hidden="true" />{disconnected ? <>{m.updated} <bdi dir="ltr">{updated ? shortTime(updated) : m.notAvailable}</bdi></> : <>{w.live} · {m.live}</>}{!disconnected && unread > 0 && <> · {m.notifications}: <b dir="ltr">{unread}</b></>}</p>
        {summary && <p className="inbox-summary">{summary}</p>}</div>
      <div className="page-actions">{staff && <Link prefetch={false} className="button secondary" href={`/${locale}/board?display=1`}>{w.openWall}</Link>}<button className="secondary" onClick={() => setRefresh(n => n + 1)}>{m.refresh}</button></div>
    </div>
    {disconnected && <section className="offline-banner" role="status" data-testid="offline-banner"><Icon name="offline" size={22} /><div><h2>{w.offlineTitle}</h2><p>{offline ? m.offline : w.offlineBody}</p></div><button className="secondary" onClick={() => setRefresh(n => n + 1)}>{w.retryNow}</button></section>}
    {error && !page && <p className="notice error" role="alert">{m.error}</p>}
    {staff ? <div className="kpis" data-testid="kpis">{!snapshot || !counts ? [0, 1, 2, 3].map(i => <article key={i} className="kpi" aria-hidden="true"><span className="skeleton num" /><span className="skeleton line" /></article>) : <>
      <article className="kpi"><strong dir="ltr">{counts.inbox}</strong><span>{w.kpiInbox}</span></article>
      <article className={`kpi${snapshot.urgent_open ? " urgent" : ""}`} data-testid="stat-urgent"><strong dir="ltr">{snapshot.urgent_open}</strong><span>{w.kpiUrgent}</span></article>
      <article className="kpi"><strong dir="ltr">{counts.accepted}</strong><span>{w.kpiProducer}</span></article>
      <article className={`kpi${snapshot.overdue_acknowledgements ? " attention" : ""}`}><strong dir="ltr">{snapshot.overdue_acknowledgements}</strong><span>{m.editor.overdue}</span></article></>}</div>
    : <div className="kpis three"><article className="kpi"><strong dir="ltr">{page?.items.length ?? "—"}</strong><span>{m.visibleCount}</span></article><article className="kpi"><strong dir="ltr">{page?.items.filter(x => x.technical_state === "pending").length ?? "—"}</strong><span>{m.pendingCount}</span></article><article className="kpi"><strong dir="ltr">{page?.items.filter(x => x.priority === "urgent").length ?? "—"}</strong><span>{m.urgentCount}</span></article></div>}
    <div className="inbox-tools">
      <nav className="quick-tabs" aria-label={m.inboxTabs.label}>{inboxTabs.map(item => <button key={item} type="button" className={tab === item ? "chip active" : "chip"} aria-pressed={tab === item} onClick={() => choose(item)}>{item === "urgent" && <Icon name="bolt" size={14} />}{m.inboxTabs[item]}{counts && <> <span className="tab-count" dir="ltr">{counts[item]}</span></>}</button>)}</nav>
      <div className="sort-tools"><label>{m.sort}<select value={sort} onChange={e => setSort(e.target.value as Sort)}>{([["shot_at", m.shotAt], ["governorate", m.governorate], ["reporter_id", m.reporterId], ["technical_state", m.technical], ["editorial_state", m.editorial], ["rights_state", m.rights]] as [Sort, string][]).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label><button className="secondary small" onClick={() => setDescending(!descending)}>{descending ? m.descending : m.ascending}</button></div>
    </div>
    <nav className="quick-tabs type-chips" aria-label={w.typeFilter.label} aria-describedby="type-filter-hint" data-testid="type-chips">{(["", ...materialTypes] as string[]).map(value => <button key={value || "all"} type="button" className={type === value ? "chip active" : "chip"} aria-pressed={type === value} onClick={() => setType(value)}>{value ? (m.types as Record<string, string>)[value] : w.typeFilter.all}</button>)}</nav>
    <p id="type-filter-hint" className="caption visually-hidden">{w.typeFilter.hint}</p>
    <details className="filter-panel"><summary>{m.filters}</summary><form key={formKey} onSubmit={filter} className="filters">
      {(Object.keys(states) as (keyof typeof states)[]).map(key => <label key={key}>{filterLabel(key, m)}<select name={key} defaultValue={query[key] ?? ""}><option value="">{m.all}</option>{states[key].map(state => <option key={state} value={state}>{(m.states[key] as Record<string, string>)[state]}</option>)}</select></label>)}
      <label>{m.governorate}<input name="governorate" maxLength={64} defaultValue={query.governorate ?? ""} /></label><label>{m.reporterId}<input name="reporter_id" dir="ltr" defaultValue={query.reporter_id ?? ""} /></label><label>{m.shotAfter}<input type="datetime-local" name="shot_after" /></label><label>{m.shotBefore}<input type="datetime-local" name="shot_before" /></label><div className="actions"><button>{m.apply}</button><button type="reset" className="quiet" onClick={() => { setPage(null); setQuery({ limit: 50 }); setCursors([undefined]); setInvalid(false); }}>{m.reset}</button></div>
    </form>{invalid && <p className="notice error" role="alert">{m.invalidFilters}</p>}</details>
    {chips.length > 0 && <ul className="filter-chips" aria-label={w.activeFilters}>{chips.map(chip => <li key={chip.key}><button type="button" className="chip removable" onClick={chip.remove} aria-label={w.removeFilter.replace("{filter}", chip.label)}>{chip.label}<Icon name="x" size={14} /></button></li>)}<li><button type="button" className="link-button" onClick={clearAll}>{w.clearAll}</button></li></ul>}
    <section className="inbox-list" aria-label={m.inbox} aria-busy={!page}>
      {list}
      {page && (cursors.length > 1 || page.next_cursor) ? <footer className="pagination"><span>{m.page} <span dir="ltr">{cursors.length}</span></span><div className="actions"><button className="secondary" disabled={cursors.length === 1 || !page} onClick={() => move(false)}>{m.previous}</button><button className="secondary" disabled={!page?.next_cursor} onClick={() => move(true)}>{m.next}</button></div></footer> : null}
    </section>
    {snapshot && <InboxNow locale={locale} snapshot={snapshot} now={now} />}
  </>;
}

/** ما يطابقه بحث الشريط العلوي في الصفحة المحمّلة: العنوان والمكان والإيصال واسم الظهور المستعار والوسوم المعروضة كلها في الصف. */
function searchFields(item: Material) {
  return [item.title, item.governorate, item.city, item.files.find(f => f.receipt_number)?.receipt_number, item.display_name.mode === "pseudonym" ? item.display_name.pseudonym : null, ...(item.tags ?? [])];
}
function filterLabel(key: FilterKey, m: Messages) {
  return key === "priority" ? m.priority : key === "technical_state" ? m.technical : key === "editorial_state" ? m.editorial : key === "rights_state" ? m.rights : key === "governorate" ? m.governorate : key === "reporter_id" ? m.reporterId : key === "shot_after" ? m.shotAfter : m.shotBefore;
}
function filterValue(key: FilterKey, value: string, m: Messages, locale: Locale) {
  if (key === "priority" || key === "technical_state" || key === "editorial_state" || key === "rights_state") return (m.states[key] as Record<string, string>)[value] ?? value;
  return key.startsWith("shot_") ? longDate(value, locale) : value;
}

/**
 * صف الوارد (`Web/Inbox row`): مصغّرة متحقَّقة من `thumbnail_file_id` عبر الـBFF (لا للحسّاسة؛ ADR 0105)، والعنوان وشارة الأولوية بكلمة، وسطر المراسل والمحافظة والنوع وعدد الملفات والإيصال،
 * والوسوم، والزمن منذ الوصول، والحالات الثلاث شارات منفصلة بأيقونة وكلمة، والخطوة التالية «استلام» لمن يملكها و«حوّل» للمقبولة للإنتاج (W3). العاجل حدّ وشارة وكلمة، لا لون وحده.
 */
function MaterialRow({ material, locale, now, disabled, done }: { material: Material; locale: Locale; now: number; disabled: boolean; done: () => void }) {
  const m = messages[locale], w = m.shell.inbox, receipt = material.files.find(f => f.receipt_number)?.receipt_number, urgent = material.priority === "urgent";
  const files = material.files.filter(f => f.kind === "original").length;
  const type = material.material_types[0] ? (m.types as Record<string, string>)[material.material_types[0]] : null;
  const tracks: [StateTrack, string][] = [["technical_state", m.technical], ["editorial_state", m.editorial], ["rights_state", m.rights]];
  const thumb = rowThumb(material, isSensitive(material)), [broken, setBroken] = useState(false);
  return <li data-testid="material-row" className={`inbox-row${urgent ? " urgent" : ""}`}>
    {thumb.kind === "sensitive" ? <span className="row-thumb sensitive" data-testid="row-thumb-sensitive"><Icon name="shield" size={18} /><small>{w.typeFilter.sensitive}</small></span>
      : thumb.kind === "thumbnail" && !broken ? <span className="row-thumb image" aria-hidden="true"><Image unoptimized src={`/api/bff/materials/${material.id}/files/${thumb.id}/content`} alt="" width={96} height={64} loading="lazy" data-testid="row-thumb-image" onError={() => setBroken(true)} /></span>
      : <span className="row-thumb" aria-hidden="true"><Icon name={material.material_types.includes("photos") ? "preview" : "play"} /></span>}
    <div className="row-main">
      <p className="row-title"><Link className="material-link" prefetch={false} href={`/${locale}/materials/${material.id}`}>{material.title}</Link>{material.priority !== "normal" && <span className={`priority-pill ${material.priority}`}>{urgent && <Icon name="bolt" size={12} />}{m.states.priority[material.priority]}</span>}</p>
      <p className="row-meta"><span>{photographer(material, locale)}</span><span>{material.governorate}</span>{type && <span>{type}</span>}{files > 0 && <span>{plural(files, w.files, locale)}</span>}<span className="receipt"><bdi dir="ltr">{receipt ?? m.noReceipt}</bdi></span></p>
      {material.tags?.length ? <ul className="tag-list" aria-label={w.tags}>{material.tags.map(tag => <li key={tag}><bdi>{tag}</bdi></li>)}</ul> : null}
    </div>
    <p className={`row-time${urgent ? " urgent" : ""}`}>{now ? w.since.replace("{time}", humanDuration(now - Date.parse(material.created_at), locale)) : longDate(material.created_at, locale)}</p>
    <ul className="row-states" aria-label={w.states}>{tracks.map(([track, name]) => <li key={track}><span className="visually-hidden">{name}: </span><StateBadge track={track} value={material[track]} locale={locale} /></li>)}</ul>
    <div className="row-actions"><RowReceive material={material} locale={locale} disabled={disabled} done={done} /><AssignButton locale={locale} material={material} compact disabled={disabled} onAssigned={done} /></div>
  </li>;
}

/** «استلام» من الصف: انتقال `inbox → acknowledged` نفسه الذي في شريط العاجل («الاستلام يبلّغ المراسل أن المحرر رأى مادته»)، بـ If-Match ومفتاح منع التكرار. */
function RowReceive({ material, locale, disabled, done }: { material: Material; locale: Locale; disabled: boolean; done: () => void }) {
  const m = messages[locale], me = useUser(), mutation = useMutation(), tag = Number.isSafeInteger(material.row_version) ? `"${material.row_version}"` : null;
  if (!tag || !transitionOptions(material, me, "editorial").includes("acknowledged")) return null;
  async function receive() {
    if (!tag) return;
    const body = { track: "editorial" as const, to: "acknowledged", reason: m.editor.ackReason };
    if (await mutation.run(`${material.id}:ack:${tag}`, header => browserApi().POST("/materials/{id}/transitions", { params: { path: { id: material.id }, header: { ...header, "If-Match": tag } }, body }))) done();
  }
  return <><button className="secondary small" disabled={disabled || mutation.busy} onClick={() => void receive()} aria-label={`${m.shell.inbox.receive}: ${material.title}`}><Icon name="check" size={16} />{m.shell.inbox.receive}</button>{mutation.status && mutation.status !== 200 ? <ActionStatus status={mutation.status} locale={locale} /> : null}</>;
}

/** التنبيه العاجل (B1): ما دامت مادة عاجلة بلا اطّلاع، بعدّاد منذ وصولها وزر «اطّلعت»؛ وصوت مرة لكل مادة جديدة ما لم يُكتم على هذا الجهاز. */
function UrgentAlert({ locale, items, now, disabled, done, showAll }: { locale: Locale; items: Material[]; now: number; disabled: boolean; done: () => void; showAll: () => void }) {
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
    <span className="alert-icon" aria-hidden="true"><Icon name="bolt" size={20} /></span>
    <div><h2 id="urgent-title">{single ? t.urgentOne : plural(items.length, t.urgentMany, locale)} {t.since} <span data-testid="urgent-since">{humanDuration(now - Date.parse(first.created_at), locale)}</span></h2>
      {escalation && <p data-testid="urgent-escalation">{escalation}</p>}
      {single ? <p><Link prefetch={false} href={`/${locale}/materials/${first.id}`}>{first.title}</Link></p> : <p>{t.urgentManyHelp}</p>}</div>
    <div className="actions">{canAck && <button onClick={() => void acknowledge()} disabled={disabled || mutation.busy}>{t.ack}</button>}{!single && <button className="secondary" onClick={showAll}>{t.showUrgent}</button>}
      <label className="check"><input type="checkbox" checked={muted} onChange={e => { setMuted(e.target.checked); try { localStorage.setItem("ph-urgent-muted", e.target.checked ? "1" : "0"); } catch { /* تفضيل محلي اختياري */ } }} />{t.mute}</label></div>
    <ActionStatus status={mutation.status} locale={locale} />
  </section>;
}
