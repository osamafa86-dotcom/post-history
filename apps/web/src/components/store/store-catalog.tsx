"use client";
import { EmptyState, NoAccess } from "../empty-state";
import { useEffect, useState } from "react";
import { messages, type Locale } from "@/lib/i18n";
import { hasRole } from "@/lib/review";
import { materialTypes } from "@/lib/query";
import type { CatalogItem } from "@/lib/store-format";
import { useUser } from "../session-boundary";
import { Icon } from "../icon";
import { CatalogCard } from "./catalog-card";
import { OrgPending } from "./org-pending";
import { browserApi, dataOrThrow } from "@/lib/browser-api";
import type { components } from "@/generated/schema";
type Organization = components["schemas"]["BuyerOrganization"];

// أدوار المشترين (#192) تتصفح الكتالوج كما في x-roles.
export const catalogRoles = ["system_admin", "rights_officer", "editor_in_chief", "finance", "buyer_admin", "buyer_member"] as const;
export const licenseTypes = ["editorial_single", "editorial_term", "exclusive_temporary", "commercial"] as const;
type Page = { items: CatalogItem[]; next_cursor: string | null };
// المدة والدقة إلى معاملات العقد (min/max_duration_ms، min_height).
const durations = { short: { max_duration_ms: "60000" }, medium: { min_duration_ms: "60000", max_duration_ms: "300000" }, long: { min_duration_ms: "300000" } } as const;
const heights = ["720", "1080", "2160"] as const;
export const periods = ["recent", "week", "month"] as const;
export type Filters = Partial<Record<"q" | "material_type" | "governorate" | "shot_from" | "shot_to" | "period" | "duration" | "min_height" | "license_type" | "exclusive_available", string>>;
// يوم التصوير في العقد تاريخ بلا ساعة (`shot_on`)، فالفترات بالأيام: «آخر 7 أيام» لا «هذا الأسبوع» (بداية الأسبوع تختلف بين الإعدادات، كما في ADR 0096).
const periodDays = { recent: 1, week: 6, month: 29 } as const;
export function periodStart(period: string, now = new Date()) {
  const days = periodDays[period as keyof typeof periodDays];
  return days === undefined ? null : new Date(now.getTime() - days * 86400000).toISOString().slice(0, 10);
}

export function catalogParams(filters: Filters, now = new Date()) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (!value) continue;
    if (key === "period") { const from = periodStart(value, now); if (from && !filters.shot_from) params.set("shot_from", from); continue; }
    if (key === "duration") for (const [k, v] of Object.entries(durations[value as keyof typeof durations] ?? {})) params.set(k, v);
    else params.set(key, value);
  }
  return params;
}

/**
 * شرائح المحافظة (S1): من المواد المعروضة نفسها، لا من قائمة مكتوبة، فلا شريحة بلا مواد ولا صيغة اسم تخالف ما كتبه المراسل. تُجمع من صفحات
 * بلا مرشّح محافظة (`seen`: الإدراج ومحافظته)، الأكثر موادَّ أولًا، حتى ثماني.
 */
export function governorateChips(seen: Map<string, string>, active?: string) {
  const counts = new Map<string, number>();
  for (const name of seen.values()) counts.set(name, (counts.get(name) ?? 0) + 1);
  const ranked = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([name]) => name).slice(0, 8);
  return active && !ranked.includes(active) ? [...ranked, active] : ranked;
}

/** الكتالوج (S1، M4): البحث بالحدث والمكان والتاريخ، وشرائح المحافظة والفترة، والمرشحات الأخرى مطوية، وبطاقات `Web/Store card`، وE6 حين لا نتيجة. */
export function StoreCatalog({ locale }: { locale: Locale }) {
  const m = messages[locale], s = m.store, b = s.browse, c = s.catalog, me = useUser(), allowed = hasRole(me, ...catalogRoles);
  const [filters, setFilters] = useState<Filters>({}), [cursors, setCursors] = useState<(string | null)[]>([null]), [page, setPage] = useState<Page | null>(null), [error, setError] = useState(false), [attempt, setAttempt] = useState(0);
  const [seen, setSeen] = useState<Map<string, string>>(() => new Map()), [held, setHeld] = useState<Organization | null>(null);
  const cursor = cursors.at(-1) ?? null, query = catalogParams(filters).toString();
  useEffect(() => {
    if (!allowed) return;
    const controller = new AbortController(), params = new URLSearchParams(query), unfiltered = !params.has("governorate");
    params.set("limit", "24"); if (cursor) params.set("cursor", cursor);
    void fetch(`/api/bff/catalog?${params}`, { credentials: "same-origin", cache: "no-store", signal: controller.signal })
      .then(async response => {
        if (response.status === 401) window.dispatchEvent(new Event("session-revoked"));
        // S6: مؤسسة غير مفعّلة يردّ لها الكتالوج 403 forbidden_scope؛ تُقرأ حالتها فتظهر بطاقتها بدل كتالوج باهت أو خطأ بلا سبب.
        if (response.status === 403 && me.organization_id) {
          const organization = dataOrThrow(await browserApi().GET("/buyer-organizations/{org_id}", { params: { path: { org_id: me.organization_id } }, signal: controller.signal }));
          if (organization.status !== "active") { setHeld(organization); return null; }
        }
        if (!response.ok) throw new Error(); return await response.json() as Page;
      })
      .then(data => {
        if (!data) return;
        setPage(data); setError(false); setHeld(null);
        if (unfiltered) setSeen(current => data.items.some(item => item.governorate && current.get(item.listing_id) !== item.governorate) ? new Map([...current, ...data.items.filter(item => item.governorate).map(item => [item.listing_id, item.governorate] as [string, string])]) : current);
      }).catch(() => { if (!controller.signal.aborted) setError(true); });
    return () => controller.abort();
  }, [allowed, query, cursor, attempt, me.organization_id]);
  if (!allowed) return <NoAccess locale={locale} me={me} title={s.title} denied={s.denied} />;
  if (held) return <div className="store-page org-pending-page"><OrgPending locale={locale} organization={held} canInvite={hasRole(me, "buyer_admin")} /></div>;
  const update = (next: Filters) => { setPage(null); setCursors([null]); setFilters(next); };
  const set = (key: keyof Filters, value: string) => update({ ...filters, [key]: value });
  const active = (Object.entries(filters) as [keyof Filters, string][]).filter(([, value]) => value);
  const label = (key: keyof Filters, value: string) => key === "q" ? value : key === "material_type" ? m.types[value as keyof typeof m.types] : key === "license_type" ? s.licenseTypes[value as keyof typeof s.licenseTypes]
    : key === "period" ? (value === "week" ? c.week : b.period[value as keyof typeof b.period]) : key === "duration" ? b.durations[value as keyof typeof b.durations] : key === "min_height" ? `${value}p+` : key === "exclusive_available" ? s.exclusiveOnly : key === "shot_from" ? `${b.from} ${value}` : key === "shot_to" ? `${b.to} ${value}` : value;
  const more = active.filter(([key]) => !["q", "governorate", "period"].includes(key)).length;
  const chips = governorateChips(seen, filters.governorate), plain = !filters.governorate && !filters.period;
  return <div className="store-page">
    <header className="store-hero">
      <div className="store-hero-text"><h1>{c.heading} <span className="store-accent">{c.headingAccent}</span></h1><p className="store-lead">{c.lead}</p></div>
      <form className="store-search" role="search" onSubmit={e => { e.preventDefault(); set("q", String(new FormData(e.currentTarget).get("q") ?? "").trim()); }}>
        <label htmlFor="catalog-q" className="visually-hidden">{s.search}</label>
        <span className="store-search-icon"><Icon name="search" /></span>
        <input id="catalog-q" key={filters.q ?? ""} name="q" type="search" maxLength={200} defaultValue={filters.q ?? ""} placeholder={c.searchPlaceholder} aria-describedby="search-help" autoComplete="off" />
        <button className="secondary">{b.searchButton}</button>
        <small id="search-help" className="visually-hidden">{c.searchHelp}</small>
      </form>
    </header>
    <nav className="store-chips" aria-label={c.chipsLabel}>
      <button type="button" className="store-chip" aria-pressed={plain} onClick={() => update({ ...filters, governorate: "", period: "" })}>{c.all}</button>
      <button type="button" className="store-chip" aria-pressed={filters.period === "week"} onClick={() => set("period", filters.period === "week" ? "" : "week")}>{c.week}</button>
      {chips.map(name => <button key={name} type="button" className="store-chip" aria-pressed={filters.governorate === name} onClick={() => set("governorate", filters.governorate === name ? "" : name)}>{name}</button>)}
    </nav>
    <details className="store-more">
      <summary>{c.moreFilters}{more ? ` (${more})` : ""}</summary>
      <div className="store-more-grid">
        <label>{m.materialType}<select value={filters.material_type ?? ""} onChange={e => set("material_type", e.target.value)}><option value="">{m.all}</option>{materialTypes.map(t => <option key={t} value={t}>{m.types[t]}</option>)}</select></label>
        <label>{b.from}<input type="date" value={filters.shot_from ?? ""} onChange={e => set("shot_from", e.target.value)} /></label>
        <label>{b.to}<input type="date" value={filters.shot_to ?? ""} onChange={e => set("shot_to", e.target.value)} /></label>
        <label>{s.duration}<select value={filters.duration ?? ""} onChange={e => set("duration", e.target.value)}><option value="">{m.all}</option>{(Object.keys(durations) as (keyof typeof durations)[]).map(d => <option key={d} value={d}>{b.durations[d]}</option>)}</select></label>
        <label>{s.resolution}<select value={filters.min_height ?? ""} onChange={e => set("min_height", e.target.value)}><option value="">{m.all}</option>{heights.map(h => <option key={h} value={h}>{h}p+</option>)}</select></label>
        <label>{s.licenseType}<select value={filters.license_type ?? ""} onChange={e => set("license_type", e.target.value)}><option value="">{m.all}</option>{licenseTypes.map(t => <option key={t} value={t}>{s.licenseTypes[t]}</option>)}</select></label>
        <label className="store-check"><input type="checkbox" checked={filters.exclusive_available === "true"} onChange={e => set("exclusive_available", e.target.checked ? "true" : "")} />{s.exclusiveOnly}</label>
      </div>
    </details>
    <p className="visually-hidden" role="status">{page ? b.count.replace("{n}", String(page.items.length)) : c.loading}</p>
    {error ? <EmptyState icon="offline" role="alert" title={c.errorTitle} actions={<button className="secondary" onClick={() => setAttempt(n => n + 1)}>{m.retry}</button>}><p>{c.errorBody}</p></EmptyState>
      : !page ? <div className="store-grid" aria-hidden="true">{Array.from({ length: 8 }, (_, i) => <div key={i} className="store-card skeleton-card"><span className="store-card-cover" /><span className="skeleton-line" /><span className="skeleton-line short" /></div>)}</div>
      : !page.items.length ? <EmptyState icon="store" testId="store-empty" title={active.length ? c.emptyTitle.replace("{filters}", active.map(([key, value]) => label(key, value)).join(c.listSeparator)) : c.emptyNone}
        actions={active.length ? <button className="store" onClick={() => update({})}>{c.showAll}</button> : undefined}>
        <p>{c.emptyWhy} {c.emptyNext}</p>
        {active.length > 0 && <ul className="filter-chips">{active.map(([key, value]) => <li key={key}><button className="quiet" aria-label={b.removeFilter.replace("{filter}", label(key, value))} onClick={() => set(key, "")}>{label(key, value)} <span aria-hidden="true">×</span></button></li>)}</ul>}
      </EmptyState>
      : <div className="store-grid">{page.items.map(item => <CatalogCard key={item.listing_id} locale={locale} item={{ href: `/${locale}/store/${item.listing_id}`, title: item.title, governorate: item.governorate, shotOn: item.shot_on, durationMs: item.duration_ms, exclusive: item.exclusive_available }} />)}</div>}
    {(cursors.length > 1 || page?.next_cursor) && <div className="pagination"><button className="secondary" disabled={cursors.length < 2} onClick={() => { setPage(null); setCursors(list => list.slice(0, -1)); }}>{m.previous}</button><button className="secondary" disabled={!page?.next_cursor} onClick={() => { setPage(null); setCursors(list => [...list, page!.next_cursor]); }}>{m.next}</button></div>}
  </div>;
}
