"use client";
import { useEffect, useState } from "react";
import { messages, type Locale } from "@/lib/i18n";
import { hasRole } from "@/lib/review";
import { materialTypes } from "@/lib/query";
import { lowest, type CatalogItem } from "@/lib/store-format";
import { useUser } from "../session-boundary";
import { CatalogCard } from "./catalog-card";

// أدوار المشترين (#192) تتصفح الكتالوج كما في x-roles.
export const catalogRoles = ["system_admin", "rights_officer", "editor_in_chief", "finance", "buyer_admin", "buyer_member"] as const;
export const licenseTypes = ["editorial_single", "editorial_term", "exclusive_temporary", "commercial"] as const;
type Page = { items: CatalogItem[]; next_cursor: string | null };
// المدة والدقة إلى معاملات العقد (min/max_duration_ms، min_height).
const durations = { short: { max_duration_ms: "60000" }, medium: { min_duration_ms: "60000", max_duration_ms: "300000" }, long: { min_duration_ms: "300000" } } as const;
const heights = ["720", "1080", "2160"] as const;
export const periods = ["recent", "week", "month"] as const;
type Filters = Partial<Record<"q" | "material_type" | "governorate" | "shot_from" | "shot_to" | "period" | "duration" | "min_height" | "license_type" | "exclusive_available", string>>;
// يوم التصوير في العقد تاريخ بلا ساعة (`shot_on`)، فالفترات بالأيام: «اليوم وأمس» لا «آخر 24 ساعة» كما في Figma (193:1222) كي لا يُدّعى دقة غير موجودة.
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

/** الكتالوج (D1): شريط الثقة، والبحث بارزًا، والمرشحات جانبية تُطبَّق فورًا، والبطاقة بالحقول العامة وحدها. */
export function StoreCatalog({ locale }: { locale: Locale }) {
  const m = messages[locale], s = m.store, b = s.browse, me = useUser(), allowed = hasRole(me, ...catalogRoles);
  const [filters, setFilters] = useState<Filters>({}), [cursors, setCursors] = useState<(string | null)[]>([null]), [page, setPage] = useState<Page | null>(null), [error, setError] = useState(false), [attempt, setAttempt] = useState(0);
  const cursor = cursors.at(-1) ?? null, query = catalogParams(filters).toString();
  useEffect(() => {
    if (!allowed) return;
    const controller = new AbortController(), params = new URLSearchParams(query);
    params.set("limit", "24"); if (cursor) params.set("cursor", cursor);
    void fetch(`/api/bff/catalog?${params}`, { credentials: "same-origin", cache: "no-store", signal: controller.signal })
      .then(async response => { if (response.status === 401) window.dispatchEvent(new Event("session-revoked")); if (!response.ok) throw new Error(); return await response.json() as Page; })
      .then(data => { setPage(data); setError(false); }).catch(() => { if (!controller.signal.aborted) setError(true); });
    return () => controller.abort();
  }, [allowed, query, cursor, attempt]);
  if (!allowed) return <section className="center-state"><h1>{s.title}</h1><p role="alert">{s.denied}</p></section>;
  const set = (key: keyof Filters, value: string) => { setPage(null); setCursors([null]); setFilters(current => ({ ...current, [key]: value })); };
  const active = (Object.entries(filters) as [keyof Filters, string][]).filter(([, value]) => value);
  const label = (key: keyof Filters, value: string) => key === "q" ? `«${value}»` : key === "material_type" ? m.types[value as keyof typeof m.types] : key === "license_type" ? s.licenseTypes[value as keyof typeof s.licenseTypes]
    : key === "period" ? b.period[value as keyof typeof b.period] : key === "duration" ? b.durations[value as keyof typeof b.durations] : key === "min_height" ? `${value}p+` : key === "exclusive_available" ? s.exclusiveOnly : key === "shot_from" ? `${b.from} ${value}` : key === "shot_to" ? `${b.to} ${value}` : value;
  const filterCount = active.filter(([key]) => !["q", "exclusive_available", "period"].includes(key)).length; // ما في لوحة المرشحات وحدها؛ البحث والحصرية والفترة في الشريط
  const exclusiveOnly = filters.exclusive_available === "true";
  return <>
    <ul className="trust-strip" aria-label={b.trustLabel}>{b.trust.map(item => <li key={item}><span aria-hidden="true">✓</span>{item}</li>)}</ul>
    <div className="catalog-head"><p className="eyebrow">{s.eyebrow}</p><h1>{s.heading}</h1><p className="catalog-lead">{s.lead}</p></div>
    <div className="catalog-toolbar">
      <nav className="quick-tabs" aria-label={b.quick.label}>
        <button type="button" className={exclusiveOnly ? "tab" : "tab active"} aria-pressed={!exclusiveOnly} onClick={() => set("exclusive_available", "")}>{b.quick.all}</button>
        <button type="button" className={exclusiveOnly ? "tab active" : "tab"} aria-pressed={exclusiveOnly} onClick={() => set("exclusive_available", "true")}>{b.quick.exclusive}</button>
      </nav>
      <div className="catalog-tools">
        <form className="catalog-search" role="search" onSubmit={e => { e.preventDefault(); set("q", String(new FormData(e.currentTarget).get("q") ?? "").trim()); }}>
          <label htmlFor="catalog-q" className="visually-hidden">{s.search}</label><input id="catalog-q" name="q" type="search" maxLength={200} placeholder={b.searchPlaceholder} aria-describedby="search-help" /><button className="secondary">{b.searchButton}</button><small id="search-help" className="visually-hidden">{b.searchHelp}</small>
        </form>
        <label className="period-select"><span className="visually-hidden">{b.period.label}</span><select value={filters.period ?? ""} onChange={e => set("period", e.target.value)}><option value="">{b.period.all}</option>{periods.map(p => <option key={p} value={p}>{b.period[p]}</option>)}</select></label>
      </div>
    </div>
    <p className="muted catalog-count" role="status">{page ? b.count.replace("{n}", String(page.items.length)) : m.loading}</p>
    <details className="card catalog-filters">
      <summary>{b.filters}{filterCount ? ` (${filterCount})` : ""}</summary>
      <div className="catalog-filter-grid">
        <label>{m.materialType}<select value={filters.material_type ?? ""} onChange={e => set("material_type", e.target.value)}><option value="">{m.all}</option>{materialTypes.map(t => <option key={t} value={t}>{m.types[t]}</option>)}</select></label>
        <label>{m.governorate}<input key={filters.governorate ?? ""} defaultValue={filters.governorate ?? ""} maxLength={64} onBlur={e => { if (e.target.value.trim() !== (filters.governorate ?? "")) set("governorate", e.target.value.trim()); }} onKeyDown={e => { if (e.key === "Enter") e.currentTarget.blur(); }} /></label>
        <label>{b.from}<input type="date" value={filters.shot_from ?? ""} onChange={e => set("shot_from", e.target.value)} /></label>
        <label>{b.to}<input type="date" value={filters.shot_to ?? ""} onChange={e => set("shot_to", e.target.value)} /></label>
        <label>{s.duration}<select value={filters.duration ?? ""} onChange={e => set("duration", e.target.value)}><option value="">{m.all}</option>{(Object.keys(durations) as (keyof typeof durations)[]).map(d => <option key={d} value={d}>{b.durations[d]}</option>)}</select></label>
        <label>{s.resolution}<select value={filters.min_height ?? ""} onChange={e => set("min_height", e.target.value)}><option value="">{m.all}</option>{heights.map(h => <option key={h} value={h}>{h}p+</option>)}</select></label>
        <label>{s.licenseType}<select value={filters.license_type ?? ""} onChange={e => set("license_type", e.target.value)}><option value="">{m.all}</option>{licenseTypes.map(t => <option key={t} value={t}>{s.licenseTypes[t]}</option>)}</select></label>
      </div>
    </details>
    <div className="catalog-layout">
      <div className="catalog-results">
        {error ? <section className="notice error" role="alert"><p>{m.error}</p><button className="secondary" onClick={() => setAttempt(n => n + 1)}>{m.retry}</button></section>
          : !page ? <div className="catalog-grid" role="status" aria-label={m.loading}>{Array.from({ length: 6 }, (_, i) => <div key={i} className="catalog-skeleton" aria-hidden="true" />)}</div>
          : !page.items.length ? <section className="empty"><p>{s.empty}</p>{active.length > 0 && <ul className="filter-chips">{active.map(([key, value]) => <li key={key}><button className="quiet" aria-label={b.removeFilter.replace("{filter}", label(key, value))} onClick={() => set(key, "")}>{label(key, value)} ×</button></li>)}</ul>}</section>
          : <div className="catalog-grid">{page.items.map(item => <CatalogCard key={item.listing_id} locale={locale} item={{ href: `/${locale}/store/${item.listing_id}`, title: item.title, governorate: item.governorate, shotOn: item.shot_on, durationMs: item.duration_ms, width: item.width, height: item.height, displayName: item.credit, from: lowest(item.offers.map(o => o.price)), types: item.material_types, licenses: [...new Set(item.offers.map(o => o.type))], exclusive: item.exclusive_available }} />)}</div>}
        <div className="pagination"><button className="secondary" disabled={cursors.length < 2} onClick={() => { setPage(null); setCursors(c => c.slice(0, -1)); }}>{m.previous}</button><button className="secondary" disabled={!page?.next_cursor} onClick={() => { setPage(null); setCursors(c => [...c, page!.next_cursor]); }}>{m.next}</button></div>
      </div>
    </div>
  </>;
}
