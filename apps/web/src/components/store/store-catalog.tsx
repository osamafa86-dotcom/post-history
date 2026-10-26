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
const licenseTypes = ["editorial_single", "editorial_term", "exclusive_temporary", "commercial"] as const;
type Page = { items: CatalogItem[]; next_cursor: string | null };

// الكتالوج ثنائي اللغة (#203 بند 28): بحث ومرشحات العقد، والبطاقة بالحقول العامة وحدها.
export function StoreCatalog({ locale }: { locale: Locale }) {
  const m = messages[locale], s = m.store, me = useUser(), allowed = hasRole(me, ...catalogRoles);
  const [query, setQuery] = useState(""), [cursors, setCursors] = useState<(string | null)[]>([null]), [page, setPage] = useState<Page | null>(null), [error, setError] = useState(false);
  const cursor = cursors.at(-1) ?? null;
  useEffect(() => {
    if (!allowed) return;
    const controller = new AbortController(), params = new URLSearchParams(query);
    params.set("limit", "24"); if (cursor) params.set("cursor", cursor);
    void fetch(`/api/bff/catalog?${params}`, { credentials: "same-origin", cache: "no-store", signal: controller.signal })
      .then(async response => { if (response.status === 401) window.dispatchEvent(new Event("session-revoked")); if (!response.ok) throw new Error(); return await response.json() as Page; })
      .then(data => { setPage(data); setError(false); }).catch(() => { if (!controller.signal.aborted) setError(true); });
    return () => controller.abort();
  }, [allowed, query, cursor]);
  if (!allowed) return <section className="center-state"><h1>{s.title}</h1><p role="alert">{s.denied}</p></section>;
  function search(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); const params = new URLSearchParams();
    for (const [key, value] of new FormData(event.currentTarget)) if (typeof value === "string" && value.trim()) params.append(key, value.trim());
    setPage(null); setCursors([null]); setQuery(params.toString());
  }
  return <><div className="page-heading"><div><p className="eyebrow">{s.eyebrow}</p><h1>{s.title}</h1><p className="muted">{s.lead}</p></div></div>
    <form className="filter-panel store-filters" role="search" onSubmit={search}>
      <label>{s.search}<input name="q" maxLength={200} /></label>
      <label>{m.materialType}<select name="material_type" defaultValue=""><option value="">{m.all}</option>{materialTypes.map(t => <option key={t} value={t}>{m.types[t]}</option>)}</select></label>
      <label>{m.governorate}<input name="governorate" maxLength={64} /></label>
      <label>{s.licenseType}<select name="license_type" defaultValue=""><option value="">{m.all}</option>{licenseTypes.map(t => <option key={t} value={t}>{s.licenseTypes[t]}</option>)}</select></label>
      <label className="check"><input type="checkbox" name="exclusive_available" value="true" />{s.exclusiveOnly}</label>
      <div className="actions"><button>{m.apply}</button></div>
    </form>
    {error ? <p className="notice error" role="alert">{m.error}</p> : !page ? <p role="status">{m.loading}</p> : !page.items.length ? <p className="empty">{s.empty}</p> :
      <div className="catalog-grid">{page.items.map(item => <CatalogCard key={item.listing_id} locale={locale} item={{ href: `/${locale}/store/${item.listing_id}`, title: item.title, governorate: item.governorate, shotOn: item.shot_on, durationMs: item.duration_ms, width: item.width, height: item.height, displayName: item.credit, from: lowest(item.offers.map(o => o.price)) }} />)}</div>}
    <div className="pagination"><button className="secondary" disabled={cursors.length < 2} onClick={() => { setPage(null); setCursors(c => c.slice(0, -1)); }}>{m.previous}</button><button className="secondary" disabled={!page?.next_cursor} onClick={() => { setPage(null); setCursors(c => [...c, page!.next_cursor]); }}>{m.next}</button></div>
  </>;
}
