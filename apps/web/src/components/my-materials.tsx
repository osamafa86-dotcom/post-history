"use client";
import { useEffect, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { browserApi, dataOrThrow } from "@/lib/browser-api";
import { formatDate, longDate, messages, plural, type Locale } from "@/lib/i18n";
import type { Material, TransitionRecord } from "@/lib/types";
import { timecode } from "@/lib/editor";
import { cardMedia, dayKind, durationLabel, groupMaterials, materialDuration, matchesFilter, mineCounts, mineFilters, needsAction, type MineFilter, type MineGroup, type MineGrouping, monthName, timeSections, type MineSection } from "@/lib/my-materials";
import { useUser } from "./session-boundary";
import { StateBadge } from "./states";
import { EmptyState } from "./empty-state";
import { Icon } from "./icon";

export { needsAction };
// حد طلبات الملاحظات في الدورة الواحدة؛ ما زاد يفتحه المراسل من صفحة المادة.
const noteLimit = 10, groupingKey = "mine-grouping";
/** آخر ملاحظة مكتوبة على طلب تعديل أو رفض؛ الخادم لا يرسل السبب إلا لصاحب المادة. */
export function latestNote(items: TransitionRecord[]) {
  return items.filter(item => item.track === "editorial" && (item.to === "needs_changes" || item.to === "rejected") && item.reason).sort((a, b) => Date.parse(b.occurred_at) - Date.parse(a.occurred_at))[0] ?? null;
}
// اختيار التجميع تفضيل لهذا المتصفح وحده؛ التخزين قد يغيب أو يرمي (نافذة خاصة)، فالافتراضي التغطية.
// الصفحة تُرسم في المتصفح وحده بعد قراءة الجلسة (session-boundary)، فقراءة التخزين عند أول عرض لا تخالف ما رسمه الخادم.
function savedGrouping(): MineGrouping { try { return typeof window !== "undefined" && window.localStorage.getItem(groupingKey) === "type" ? "type" : "coverage"; } catch { return "coverage"; } }

/**
 * «موادي» (ADR 0089 على الويب، ADR 0103): معرض بطاقات الأحدث أولًا، بالحالات الثلاث شاراتٍ منفصلة، مجمّع بعنوان التغطية أو بالنوع، ورقاقات
 * «الكل · فيديو · صور · عاجل». ما يحتاج إجراءً فوق المعرض بملاحظة المشرف. المراسل يرى مواده وحدها (`reporter_id` = نفسه، والخادم يحصر النطاق).
 */
export function MyMaterials({ locale }: { locale: Locale }) {
  const m = messages[locale], t = m.mine, me = useUser();
  const [items, setItems] = useState<Material[] | null>(null), [more, setMore] = useState(false), [notes, setNotes] = useState<Record<string, TransitionRecord | null>>({}), [error, setError] = useState(false), [refresh, setRefresh] = useState(0);
  const [filter, setFilter] = useState<MineFilter>("all"), [grouping, setGrouping] = useState<MineGrouping>(savedGrouping), [updated, setUpdated] = useState<string | null>(null), [open, setOpen] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    const controller = new AbortController(); let disposed = false, timer: ReturnType<typeof setTimeout>;
    async function load() {
      try {
        const page = dataOrThrow(await browserApi().GET("/materials", { params: { query: { reporter_id: me.user_id, limit: 100 } }, signal: controller.signal }));
        const pending = page.items.filter(item => item.editorial_state === "needs_changes" || item.editorial_state === "rejected").slice(0, noteLimit);
        const found = Object.fromEntries(await Promise.all(pending.map(async item => {
          try { return [item.id, latestNote(dataOrThrow(await browserApi().GET("/materials/{id}/transitions", { params: { path: { id: item.id } }, signal: controller.signal })).items)] as const; }
          catch { return [item.id, null] as const; }
        })));
        if (!disposed) { setItems(page.items); setMore(!!page.next_cursor); setNotes(found); setError(false); setUpdated(new Date().toISOString()); }
      } catch { if (!disposed && !controller.signal.aborted) setError(true); }
      finally { if (!disposed) timer = setTimeout(load, 30000); }
    }
    void load();
    return () => { disposed = true; controller.abort(); clearTimeout(timer); };
  }, [me.user_id, refresh]);
  function group(next: MineGrouping) { setGrouping(next); try { window.localStorage.setItem(groupingKey, next); } catch { /* تفضيل اختياري */ } }
  const action = items?.filter(needsAction) ?? [], visible = items?.filter(item => matchesFilter(item, filter)) ?? [], counts = items ? mineCounts(items) : null;
  return <>
    <div className="page-head"><div><h1>{t.title}</h1><p className="muted">{t.lead}</p></div><div className="page-actions"><button type="button" className="secondary" onClick={() => setRefresh(n => n + 1)}>{m.refresh}</button></div></div>
    {error && <section className="offline-banner" role="status" data-testid="mine-stale"><Icon name="offline" size={22} /><div><h2>{items ? t.staleTitle : m.error}</h2><p>{items && updated ? t.staleBody.replace("{time}", formatDate(updated, locale)) : t.errorBody}</p></div><button type="button" className="secondary" onClick={() => setRefresh(n => n + 1)}>{m.shell.inbox.retryNow}</button></section>}
    <div className="kpis" data-testid="mine-kpis" aria-label={t.counts}>{counts ? (["all", "action", "reviewing", "approved"] as const).map(key =>
      <article key={key} className={`kpi${key === "action" && counts.action ? " attention" : ""}`} data-kpi={key}><strong dir="ltr">{counts[key]}</strong><span>{t.kpi[key]}</span></article>)
      : [0, 1, 2, 3].map(i => <article key={i} className="kpi" aria-hidden="true"><span className="skeleton num" /><span className="skeleton line" /></article>)}</div>
    {!items ? !error && <><p className="visually-hidden" role="status">{m.loading}</p><ul className="mine-grid" aria-hidden="true">{[0, 1, 2, 3, 4, 5].map(i => <li key={i} className="mine-card"><span className="skeleton media" /><span className="skeleton line wide" /><span className="skeleton line" /></li>)}</ul></> : <>
      {action.length > 0 && <section className="card mine-action" aria-labelledby="mine-action"><h2 id="mine-action"><Icon name="alert" size={18} />{t.action}</h2><ul className="mine-list">{action.map(item => <li key={item.id} data-testid="mine-action">
        <Link className="material-link" prefetch={false} href={`/${locale}/materials/${item.id}`}>{item.title}</Link>
        <p>{item.technical_state === "failed" ? t.uploadFailed : t.changesRequested}</p>
        <Note note={notes[item.id]} locale={locale} />
      </li>)}</ul></section>}
      {!items.length ? <EmptyState icon="mine" testId="mine-empty" title={t.emptyTitle}><p>{t.emptyBody}</p></EmptyState> : <>
        <div className="mine-tools">
          <nav className="quick-tabs" aria-label={t.filtersLabel}>{mineFilters.map(which => <button key={which} type="button" className={filter === which ? "chip active" : "chip"} aria-pressed={filter === which} onClick={() => setFilter(which)}>{t.filters[which]}</button>)}</nav>
          <div className="segmented" role="group" aria-label={t.groupLabel}>{(["coverage", "type"] as MineGrouping[]).map(which => <button key={which} type="button" className={grouping === which ? "chip active" : "chip"} aria-pressed={grouping === which} onClick={() => group(which)}>{t.groupBy[which]}</button>)}</div>
        </div>
        {more && <p className="caption">{t.firstPage}</p>}
        {!visible.length ? <EmptyState icon="filter" testId="mine-no-match" title={t.noMatchTitle} actions={<button type="button" className="secondary" onClick={() => setFilter("all")}>{t.clearFilter}</button>}><p>{t.noMatchBody}</p></EmptyState>
          : grouping === "coverage" ? timeSections(groupMaterials(visible, "coverage"), new Date()).map(section => <TimeSection key={section.key} section={section} notes={notes} locale={locale} open={open} toggle={key => setOpen(old => { const next = new Set(old); if (!next.delete(key)) next.add(key); return next; })} />)
          : groupMaterials(visible, grouping).map(g => <Group key={g.key} group={g} grouping={grouping} notes={notes} locale={locale} />)}
      </>}
    </>}
  </>;
}

/**
 * قسم زمني في الشبكة المتصلة (بالتغطية): التغطية ذات المادة الواحدة بطاقة عادية، وذات المواد المتعددة بطاقة غلاف بعدّها تُفتح في مكانها
 * فتتبعها بطاقات موادها في الشبكة نفسها.
 */
function TimeSection({ section, notes, locale, open, toggle }: { section: MineSection; notes: Record<string, TransitionRecord | null>; locale: Locale; open: Set<string>; toggle: (key: string) => void }) {
  const m = messages[locale], t = m.mine, label = section.kind === "today" ? t.days.today : section.kind === "week" ? t.sections.week : section.month ? monthName(section.month, locale) : t.sections.undated;
  const count = section.groups.reduce((sum, group) => sum + group.items.length, 0);
  const card = (item: Material, nested: boolean) => <Card key={item.id} item={item} nested={nested} note={item.editorial_state === "rejected" ? notes[item.id] : undefined} locale={locale} />;
  return <section className="mine-group mine-section" aria-label={label} data-testid="mine-section">
    <header><h2>{label}</h2><p className="muted">{plural(count, t.count, locale)}</p></header>
    <ul className="mine-grid">{section.groups.flatMap(group => group.items.length === 1 ? [card(group.items[0], false)]
      : [<Cover key={group.key} group={group} locale={locale} open={open.has(group.key)} toggle={() => toggle(group.key)} />, ...(open.has(group.key) ? group.items.map(item => card(item, true)) : [])])}</ul>
  </section>;
}

/** بطاقة غلاف التغطية: مصغّرة أحدث موادها إن جاز عرضها، وعنوان التغطية، وعدّ موادها؛ زر يفتحها ويطويها في مكانها. */
function Cover({ group, locale, open, toggle }: { group: MineGroup; locale: Locale; open: boolean; toggle: () => void }) {
  const m = messages[locale], t = m.mine, first = group.items[0], media = cardMedia(first), count = plural(group.items.length, t.count, locale), [broken, setBroken] = useState(false);
  return <li className={`mine-card mine-cover${open ? " open" : ""}`} data-testid="mine-cover">
    <button type="button" className="mine-media" aria-expanded={open} aria-label={`${group.title}${m.shell.listSeparator}${count}`} onClick={toggle}>
      {media.kind === "thumbnail" && !broken ? <Image unoptimized src={`/api/bff/materials/${first.id}/files/${media.file.id}/content`} alt="" width={180} height={320} loading="lazy" onError={() => setBroken(true)} />
        : <span className="mine-icon"><Icon name="list" size={24} /></span>}
      <span className="mine-count">{count}</span>
    </button>
    <div className="mine-body"><p className="mine-title"><bdi>{group.title}</bdi></p><p className="caption muted">{open ? t.sections.coverOpen : t.sections.coverClosed}</p></div>
  </li>;
}

function Group({ group, grouping, notes, locale }: { group: MineGroup; grouping: MineGrouping; notes: Record<string, TransitionRecord | null>; locale: Locale }) {
  const m = messages[locale], t = m.mine, day = dayKind(group.newest, new Date()), when = day === "date" ? longDate(group.newest, locale) : t.days[day];
  const head = grouping === "coverage" ? group.title : group.type ? m.types[group.type] : m.notAvailable;
  const meta = [grouping === "coverage" && group.type ? m.types[group.type] : null, when, plural(group.items.length, t.count, locale)].filter(Boolean).join(" · ");
  return <section className="mine-group" aria-label={head}>
    <header><h2><bdi>{head}</bdi></h2><p className="muted">{meta}</p></header>
    <ul className="mine-grid">{group.items.map(item => <Card key={item.id} item={item} note={item.editorial_state === "rejected" ? notes[item.id] : undefined} locale={locale} />)}</ul>
  </section>;
}

/** بطاقة المادة (`MediaCard`): الوسيط ومدته وأيقونة نوعه، ثم العنوان، ثم الحالات الثلاث منفصلة بأيقونة وكلمة. */
function Card({ item, note, locale, nested }: { item: Material; note: TransitionRecord | null | undefined; locale: Locale; nested?: boolean }) {
  const m = messages[locale], t = m.mine, media = cardMedia(item), ms = item.material_types.includes("photos") ? null : materialDuration(item), duration = ms ? durationLabel(ms) : null;
  const [broken, setBroken] = useState(false), href = `/${locale}/materials/${item.id}`, urgent = item.priority === "urgent";
  return <li className={`mine-card${urgent ? " urgent" : ""}${nested ? " in-cover" : ""}`} data-testid="mine-row" data-sensitive={media.kind === "sensitive" ? "true" : undefined}>
    <Link prefetch={false} href={href} className="mine-media" aria-hidden="true" tabIndex={-1}>
      {media.kind === "thumbnail" && !broken ? <Image unoptimized src={`/api/bff/materials/${item.id}/files/${media.file.id}/content`} alt="" width={180} height={320} loading="lazy" onError={() => setBroken(true)} />
        : media.kind === "sensitive" ? <span className="mine-shield"><Icon name="shield" size={22} /><small>{t.noCloudPreview}</small></span>
        : <span className="mine-icon"><Icon name={item.material_types.includes("photos") ? "preview" : "play"} size={24} /></span>}
      <span className="mine-type" aria-hidden="true"><Icon name={item.material_types.includes("photos") ? "preview" : "film"} size={14} /></span>
      {duration && <span className="mine-duration" dir="ltr">{duration}</span>}
    </Link>
    <div className="mine-body">
      <p className="mine-title"><Link className="material-link" prefetch={false} href={href}>{item.title}</Link></p>
      <p className="mine-flags">{urgent && <span className="priority-pill urgent"><Icon name="bolt" size={12} />{m.states.priority.urgent}</span>}{media.kind === "sensitive" && <span className="badge sensitive"><Icon name="shield" size={12} />{t.sensitive}</span>}</p>
      <ul className="mine-states" aria-label={m.shell.inbox.states}>{(["technical_state", "editorial_state", "rights_state"] as const).map(track => <li key={track}><StateBadge track={track} value={item[track]} locale={locale} /></li>)}</ul>
      {note !== undefined && <Note note={note} locale={locale} />}
    </div>
  </li>;
}

function Note({ note, locale }: { note: TransitionRecord | null | undefined; locale: Locale }) {
  const t = messages[locale].mine;
  if (!note) return <p className="muted">{t.openForNote}</p>;
  return <blockquote className="supervisor-note" data-testid="supervisor-note"><p>{note.reason}</p><footer>{note.note_timecode_ms != null && <span>{t.at} <bdi dir="ltr">{timecode(note.note_timecode_ms)}</bdi> · </span>}{formatDate(note.occurred_at, locale)}</footer></blockquote>;
}
