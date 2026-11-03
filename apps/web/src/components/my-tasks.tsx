"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { browserApi, dataOrThrow } from "@/lib/browser-api";
import { messages, plural, type Locale } from "@/lib/i18n";
import type { Material } from "@/lib/types";
import { hasRole } from "@/lib/review";
import { byteSize, myTaskRoles, rushes, taskOrder, taskPageLimit, type MaterialAssignment, type MyAssignmentPage } from "@/lib/assignment-policy";
import { isSensitive } from "@/lib/render-policy";
import { useUser } from "./session-boundary";
import { EmptyState, NoAccess } from "./empty-state";
import { DueText, TaskState } from "./task-parts";
import { Icon } from "./icon";

type Status = "active" | "closed";
/** المادة لكل مهمة تُجلب مرة واحدة: العقد يعيد المهمة بمعرّف المادة وحده (العنوان والملفات والحساسية من `GET /materials/{id}` بقاعدة الحجب). */
export type MaterialCache = Record<string, Material | "missing">;

/**
 * «مهامي» (W5، والجوال M3): ثلاثة مؤشّرات من `summary` (على كل المهام لا الصفحة)، وتبويبا الجارية والمغلقة، وبطاقة لكل مهمة: العنوان
 * وشارتا العاجل والحسّاسة بكلمة، و«من المحرّر · الرشزات · الحجم»، والموعد والحالة، و«تنزيل الرشزات» إلى حزمة المهمة (W6).
 * «رفع المُنتَج» لا يُبنى: يحتاج تغيير عقد (web-v2.md «رفع المادة المُنتَجة»، ADR 0097).
 */
export function MyTasks({ locale }: { locale: Locale }) {
  const m = messages[locale], t = m.tasks, me = useUser(), allowed = hasRole(me, ...myTaskRoles);
  const [status, setStatus] = useState<Status>("active"), [page, setPage] = useState<MyAssignmentPage | null>(null), [extra, setExtra] = useState<MaterialAssignment[]>([]), [moreCursor, setMoreCursor] = useState<string | null>(null);
  const [failed, setFailed] = useState(false), [more, setMore] = useState(false), [attempt, setAttempt] = useState(0), [now, setNow] = useState(() => Date.now()), [materials, setMaterials] = useState<MaterialCache>({});
  const requested = useRef(new Set<string>());
  useEffect(() => {
    if (!allowed) return;
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    // الصفحة الأولى كل 30 ثانية (الموعد والتأخر من الخادم)؛ والصفحات التالية تُحمَّل بطلب المستخدم ولا تُستطلع.
    async function load() {
      try { const data = dataOrThrow(await browserApi().GET("/me/assignments", { params: { query: { status, limit: taskPageLimit } }, signal: controller.signal })); if (!controller.signal.aborted) { setPage(data); setFailed(false); setNow(Date.now()); } }
      catch { if (!controller.signal.aborted) setFailed(true); }
      finally { if (!controller.signal.aborted) timer = setTimeout(load, 30000); }
    }
    void load(); return () => { controller.abort(); clearTimeout(timer); };
  }, [allowed, status, attempt]);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 30000); return () => clearInterval(timer); }, []);
  const cursor = extra.length ? moreCursor : page?.next_cursor ?? null;
  const items = page ? taskOrder([...page.items, ...extra.filter(item => !page.items.some(p => p.id === item.id))]) : null;
  useEffect(() => {
    const missing = [...new Set((items ?? []).map(item => item.material_id))].filter(id => !requested.current.has(id));
    for (const id of missing) {
      requested.current.add(id);
      void browserApi().GET("/materials/{id}", { params: { path: { id } } }).then(result => { const data = dataOrThrow(result); setMaterials(cache => ({ ...cache, [id]: data })); })
        .catch(() => setMaterials(cache => ({ ...cache, [id]: "missing" })));
    }
  }, [items]);
  if (!allowed) return <NoAccess locale={locale} me={me} title={t.title} denied={t.denied} />;
  async function loadMore() {
    if (!cursor) return; setMore(true);
    try { const data = dataOrThrow(await browserApi().GET("/me/assignments", { params: { query: { status, limit: taskPageLimit, cursor } } })); setExtra(old => [...old, ...data.items]); setMoreCursor(data.next_cursor); }
    catch { setFailed(true); } finally { setMore(false); }
  }
  function choose(next: Status) { if (next === status) return; setStatus(next); setPage(null); setExtra([]); setMoreCursor(null); }
  const summary = page?.summary;
  return <>
    <div className="page-head"><div><h1>{t.title}</h1><p className="muted">{t.lead}</p></div></div>
    <div className="kpis three" data-testid="task-kpis">{summary ? <>
      <article className="kpi"><strong dir="ltr">{summary.active}</strong><span>{t.kpiActive}</span></article>
      <article className={`kpi${summary.overdue ? " urgent" : ""}`} data-testid="kpi-overdue"><strong dir="ltr">{summary.overdue}</strong><span>{t.kpiOverdue}</span></article>
      <article className="kpi"><strong dir="ltr">{summary.done_last_7_days}</strong><span>{t.kpiDone}</span></article>
    </> : [0, 1, 2].map(i => <article key={i} className="kpi" aria-hidden="true"><span className="skeleton num" /><span className="skeleton line" /></article>)}</div>
    <nav className="quick-tabs" aria-label={t.tabsLabel}>{(["active", "closed"] as Status[]).map(which => <button key={which} type="button" className={status === which ? "chip active" : "chip"} aria-pressed={status === which} onClick={() => choose(which)}>{t.tabs[which]}</button>)}</nav>
    {failed && <p className="notice error" role="alert">{page ? m.stale : m.error} <button type="button" className="link-button" onClick={() => setAttempt(n => n + 1)}>{m.retry}</button></p>}
    <section aria-label={t.title} aria-busy={!items}>
      {!items ? (failed ? null : <><p className="visually-hidden" role="status">{m.loading}</p><ul className="task-list" aria-hidden="true">{[0, 1, 2].map(i => <li key={i} className="task-card skeleton-row"><span className="skeleton thumb" /><span className="row-main"><span className="skeleton line wide" /><span className="skeleton line" /></span></li>)}</ul></>)
        : !items.length ? <EmptyState icon="tasks" testId="tasks-empty" title={status === "active" ? t.emptyActive : t.emptyClosed}><p>{status === "active" ? t.emptyActiveBody : t.emptyClosedBody}</p></EmptyState>
        : <ul className="task-list">{items.map(task => <TaskCard key={task.id} task={task} material={materials[task.material_id]} now={now} locale={locale} />)}</ul>}
      {items && cursor && <div className="pagination"><button type="button" className="secondary" disabled={more} onClick={() => void loadMore()}>{t.loadMore}</button></div>}
    </section>
    <p className="caption narrow-only task-phone-note">{t.phoneNote}</p>
  </>;
}

/** بطاقة المهمة (W5، M3). العاجل حدّ وشارة وكلمة، والحسّاسة شارة بكلمة؛ والمادة المجهولة الحساسية تُعامَل حسّاسة (فشل مغلق). */
function TaskCard({ task, material, now, locale }: { task: MaterialAssignment; material: Material | "missing" | undefined; now: number; locale: Locale }) {
  const m = messages[locale], t = m.tasks, loaded = material && material !== "missing" ? material : null, urgent = task.priority === "urgent", open = task.state !== "done" && task.state !== "returned";
  const files = loaded ? rushes(loaded) : null, size = files ? byteSize(files.size) : null, href = `/${locale}/tasks/${task.id}`;
  const from = task.assigned_by_name ? t.from.replace("{name}", task.assigned_by_name) : t.fromEditor;
  return <li className={`task-card${urgent ? " urgent" : ""}${task.overdue ? " overdue" : ""}`} data-testid="task-card">
    <span className="row-thumb" aria-hidden="true"><Icon name={loaded?.material_types.includes("photos") ? "preview" : "play"} /></span>
    <div className="row-main">
      <p className="row-title"><Link className="material-link" prefetch={false} href={href}>{loaded ? loaded.title : material === "missing" ? t.materialUnavailable : m.loading}</Link>
        {task.priority !== "normal" && <span className={`priority-pill ${task.priority}`}>{urgent && <Icon name="bolt" size={12} />}{m.states.priority[task.priority]}</span>}
        {loaded && isSensitive(loaded) && <span className="badge sensitive" data-testid="task-sensitive"><Icon name="shield" size={12} />{t.sensitive}</span>}</p>
      <p className="row-meta"><span><bdi>{from}</bdi></span>{files && <span>{plural(files.count, t.rushes, locale)}</span>}{size && <span><bdi dir="ltr">{size}</bdi></span>}</p>
    </div>
    <div className="task-when"><DueText task={task} now={now} locale={locale} />{task.overdue && open ? <span className="badge state danger">{t.overdueBadge}</span> : <TaskState state={task.state} locale={locale} />}</div>
    <div className="row-actions">{open && <Link prefetch={false} className="button" href={`${href}#rushes`}><Icon name="download" size={16} />{t.download}</Link>}<Link prefetch={false} className="button secondary" href={href}>{t.open}</Link></div>
  </li>;
}
