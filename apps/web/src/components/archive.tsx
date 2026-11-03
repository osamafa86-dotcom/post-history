"use client";
import { useEffect, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { browserApi, dataOrThrow } from "@/lib/browser-api";
import { formatDate, longDate, messages, plural, type Locale } from "@/lib/i18n";
import type { Material } from "@/lib/types";
import { hasRole } from "@/lib/review";
import { activeFilters, archiveGovernorates, archiveRoles, filterArchive, noFilters, type ArchiveFilters, type ArchivePeriod } from "@/lib/archive";
import { cardMedia, durationLabel, materialDuration } from "@/lib/my-materials";
import { useUser } from "./session-boundary";
import { EmptyState, NoAccess } from "./empty-state";
import { Icon } from "./icon";

/**
 * الأرشيف الجاهز (W9) وبحثه بلا نتائج (E4): المواد المنشورة بطاقاتٍ، والبحث ورقاقات الفترة والمحافظة على الصفحات المحمّلة، والمرشّحات النشطة
 * رقاقات قابلة للإزالة و«امسح الكل»، واقتراح بعدد المواد بلا مرشّحات. لا رقاقات منصّات ولا مشاهدات: ليست في العقد (ADR 0103).
 */
export function Archive({ locale }: { locale: Locale }) {
  const m = messages[locale], t = m.archive, me = useUser(), allowed = hasRole(me, ...archiveRoles);
  const [items, setItems] = useState<Material[] | null>(null), [cursor, setCursor] = useState<string | null>(null), [failed, setFailed] = useState(false), [more, setMore] = useState(false), [attempt, setAttempt] = useState(0);
  const [filters, setFilters] = useState<ArchiveFilters>(noFilters), [draft, setDraft] = useState(""), [now, setNow] = useState(() => Date.now()), [updated, setUpdated] = useState<string | null>(null);
  useEffect(() => {
    if (!allowed) return;
    const controller = new AbortController();
    void browserApi().GET("/materials", { params: { query: { editorial_state: "published", sort: "updated_desc", limit: 60 } }, signal: controller.signal }).then(dataOrThrow)
      .then(page => { if (!controller.signal.aborted) { setItems(page.items); setCursor(page.next_cursor); setFailed(false); setNow(Date.now()); setUpdated(new Date().toISOString()); } })
      .catch(() => { if (!controller.signal.aborted) setFailed(true); });
    return () => controller.abort();
  }, [allowed, attempt]);
  if (!allowed) return <NoAccess locale={locale} me={me} title={t.title} denied={t.denied} />;
  async function loadMore() {
    if (!cursor) return; setMore(true);
    try { const page = dataOrThrow(await browserApi().GET("/materials", { params: { query: { editorial_state: "published", sort: "updated_desc", limit: 60, cursor } } })); setItems(list => [...(list ?? []), ...page.items.filter(item => !list?.some(old => old.id === item.id))]); setCursor(page.next_cursor); }
    catch { setFailed(true); } finally { setMore(false); }
  }
  const set = (next: Partial<ArchiveFilters>) => setFilters(current => ({ ...current, ...next }));
  const visible = items ? filterArchive(items, filters, now) : [], active = activeFilters(filters), chips = items ? archiveGovernorates(items, filters.governorate) : [];
  const label = (key: keyof ArchiveFilters, value: string) => key === "period" ? t.periods[value as Exclude<ArchivePeriod, "">] : key === "q" ? `«${value}»` : value;
  return <>
    <div className="page-head"><div><h1>{t.title}</h1><p className="muted">{t.lead}</p></div></div>
    <form className="archive-search" role="search" onSubmit={e => { e.preventDefault(); set({ q: draft.trim() }); }}>
      <label htmlFor="archive-q" className="visually-hidden">{t.search}</label>
      <span className="search-icon" aria-hidden="true"><Icon name="search" /></span>
      <input id="archive-q" type="search" value={draft} maxLength={200} placeholder={t.searchPlaceholder} autoComplete="off" onChange={e => { setDraft(e.target.value); if (!e.target.value) set({ q: "" }); }} />
      <button className="secondary">{t.searchButton}</button>
    </form>
    <nav className="quick-tabs archive-chips" aria-label={t.chipsLabel}>
      <button type="button" className={!filters.period && !filters.governorate ? "chip active" : "chip"} aria-pressed={!filters.period && !filters.governorate} onClick={() => set({ period: "", governorate: "" })}>{t.all}</button>
      {(["week", "month"] as const).map(p => <button key={p} type="button" className={filters.period === p ? "chip active" : "chip"} aria-pressed={filters.period === p} onClick={() => set({ period: filters.period === p ? "" : p })}>{t.periods[p]}</button>)}
      {chips.map(name => <button key={name} type="button" className={filters.governorate === name ? "chip active" : "chip"} aria-pressed={filters.governorate === name} onClick={() => set({ governorate: filters.governorate === name ? "" : name })}><bdi>{name}</bdi></button>)}
    </nav>
    {active.length > 0 && <ul className="filter-chips" aria-label={m.shell.inbox.activeFilters}>{active.map(([key, value]) => <li key={key}><button type="button" className="chip removable" aria-label={m.shell.inbox.removeFilter.replace("{filter}", label(key, value))} onClick={() => { set({ [key]: "" }); if (key === "q") setDraft(""); }}><bdi>{label(key, value)}</bdi><Icon name="x" size={14} /></button></li>)}
      <li><button type="button" className="link-button" onClick={() => { setFilters(noFilters); setDraft(""); }}>{m.shell.inbox.clearAll}</button></li></ul>}
    {failed && items && <section className="offline-banner" role="status"><Icon name="offline" size={22} /><div><h2>{m.shell.inbox.offlineTitle}</h2><p>{t.staleBody.replace("{time}", formatDate(updated, locale))}</p></div><button className="secondary" onClick={() => setAttempt(n => n + 1)}>{m.shell.inbox.retryNow}</button></section>}
    <section aria-label={t.title} aria-busy={!items}>
      {!items ? failed ? <EmptyState icon="offline" role="alert" title={m.shell.inbox.offlineTitle} actions={<button onClick={() => setAttempt(n => n + 1)}>{m.shell.inbox.retryNow}</button>}><p>{t.errorBody}</p></EmptyState>
        : <><p className="visually-hidden" role="status">{m.loading}</p><ul className="archive-grid" aria-hidden="true">{[0, 1, 2, 3, 4, 5, 6, 7].map(i => <li key={i} className="archive-card"><span className="skeleton media" /><span className="skeleton line wide" /><span className="skeleton line" /></li>)}</ul></>
        : !items.length ? <EmptyState icon="film" testId="archive-empty" title={t.emptyTitle}><p>{t.emptyBody}</p></EmptyState>
        : !visible.length ? <EmptyState icon="search" testId="archive-no-results" title={filters.q ? t.noResultsFor.replace("{q}", filters.q) : t.noResults}
          actions={<button type="button" onClick={() => { setFilters(noFilters); setDraft(""); }}>{t.showAll.replace("{n}", String(items.length))}</button>}>
          <p>{active.length > 1 ? t.noResultsHintMany.replace("{n}", String(active.length)) : t.noResultsHint} {t.noResultsCount.replace("{count}", plural(items.length, m.counts.materials, locale))}</p>
        </EmptyState>
        : <ul className="archive-grid">{visible.map(item => <ArchiveCard key={item.id} item={item} now={now} locale={locale} />)}</ul>}
      {items && cursor && <div className="pagination"><button type="button" className="secondary" disabled={more} onClick={() => void loadMore()}>{t.loadMore}</button></div>}
    </section>
  </>;
}

function ArchiveCard({ item, now, locale }: { item: Material; now: number; locale: Locale }) {
  const m = messages[locale], t = m.archive, media = cardMedia(item), ms = item.material_types.includes("photos") ? null : materialDuration(item), [broken, setBroken] = useState(false), href = `/${locale}/materials/${item.id}`;
  const day = Date.parse(item.updated_at), when = Number.isFinite(day) && now - day < 86400000 ? t.today : longDate(item.updated_at, locale), type = item.material_types[0];
  return <li className="archive-card" data-testid="archive-card">
    <Link prefetch={false} href={href} className="archive-media" aria-hidden="true" tabIndex={-1}>
      {media.kind === "thumbnail" && !broken ? <Image unoptimized src={`/api/bff/materials/${item.id}/files/${media.file.id}/content`} alt="" width={320} height={400} loading="lazy" onError={() => setBroken(true)} />
        : media.kind === "sensitive" ? <span className="mine-shield"><Icon name="shield" size={22} /><small>{m.mine.noCloudPreview}</small></span> : null}
      <span className="archive-play"><Icon name={item.material_types.includes("photos") ? "preview" : "play"} size={20} /></span>
      {ms && <span className="mine-duration" dir="ltr">{durationLabel(ms)}</span>}
    </Link>
    <p className="archive-title"><Link className="material-link" prefetch={false} href={href}>{item.title}</Link></p>
    <p className="archive-meta muted">{[when, type ? m.types[type] : null, item.governorate].filter(Boolean).map((part, i) => <span key={i}><bdi>{part}</bdi></span>)}</p>
    {media.kind === "sensitive" && <p className="mine-flags"><span className="badge sensitive"><Icon name="shield" size={12} />{m.mine.sensitive}</span></p>}
  </li>;
}
