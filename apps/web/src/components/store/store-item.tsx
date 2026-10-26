"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { messages, type Locale } from "@/lib/i18n";
import { hasRole } from "@/lib/review";
import { formatDuration, localized, type CatalogItem } from "@/lib/store-format";
import { useUser } from "../session-boundary";
import { shotDay } from "./catalog-card";
import { LicensePicker } from "./license-picker";
import { WatermarkedPreview } from "./watermarked-preview";
import { catalogRoles } from "./store-catalog";
import { useCart } from "./cart";
import { isBuyer } from "@/lib/buyer-policy";

// صفحة المادة في الكتالوج (#203 بنود 28–30): المعاينة بعلامة مائية وهوية المشاهد، والتراخيص بأسعارها، والإضافة إلى السلة للمشتري.
export function StoreItem({ locale, id }: { locale: Locale; id: string }) {
  const m = messages[locale], s = m.store, me = useUser(), allowed = hasRole(me, ...catalogRoles), cart = useCart(), buyer = isBuyer(me);
  const [item, setItem] = useState<CatalogItem | null>(null), [status, setStatus] = useState(0), [offer, setOffer] = useState<string | null>(null);
  useEffect(() => {
    if (!allowed) return;
    const controller = new AbortController();
    void fetch(`/api/bff/catalog/${id}`, { credentials: "same-origin", cache: "no-store", signal: controller.signal })
      .then(async response => { if (response.status === 401) window.dispatchEvent(new Event("session-revoked")); if (!response.ok) { setStatus(response.status); return; } setItem(await response.json() as CatalogItem); })
      .catch(() => { if (!controller.signal.aborted) setStatus(503); });
    return () => controller.abort();
  }, [allowed, id]);
  if (!allowed) return <section className="center-state"><h1>{s.title}</h1><p role="alert">{s.denied}</p></section>;
  const back = <Link prefetch={false} className="back-link" href={`/${locale}/store`}>{s.back}</Link>;
  if (status) return <>{back}<p className="center-state" role="alert">{status === 404 ? s.notFound : m.error}</p></>;
  if (!item) return <>{back}<p className="center-state" role="status">{m.loading}</p></>;
  const day = shotDay(item.shot_on), duration = formatDuration(item.duration_ms);
  return <>{back}<div className="page-heading"><div><p className="eyebrow">{item.material_types.map(t => m.types[t]).join(" · ")}</p><h1>{localized(item.title, locale)}</h1><p className="muted">{localized(item.description, locale)}</p></div></div>
    <div className="detail-grid">
      <WatermarkedPreview locale={locale} src={`/api/bff/catalog/${item.listing_id}/preview`} viewer={me.email} />
      <section className="card"><h2>{s.details}</h2><dl className="metadata">{[[m.governorate, item.governorate], [s.shotOn, day ? new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: "UTC" }).format(new Date(`${day}T00:00:00Z`)) : m.notAvailable], [s.duration, duration ?? m.notAvailable], [s.resolution, item.width && item.height ? `${item.width}×${item.height}` : m.notAvailable], [s.credit, item.credit]].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl></section>
    </div>
    {item.shot_list.length > 0 && <section className="card"><h2>{s.shotList}</h2><ol className="shot-list">{item.shot_list.map(shot => <li key={shot.start_ms}><span dir="ltr">{formatDuration(shot.start_ms)}</span> {localized(shot.label, locale)}</li>)}</ol></section>}
    <section className="card"><LicensePicker locale={locale} offers={item.offers.map(o => ({ id: `${o.license_template_id}:${o.license_version}`, type: o.type, name: o.name, price: o.price }))} exclusiveAvailable={item.exclusive_available} value={offer} onChange={setOffer} />{buyer ? <div className="actions"><button disabled={!offer} onClick={() => { const chosen = item.offers.find(o => `${o.license_template_id}:${o.license_version}` === offer); if (chosen) cart.add({ listing_id: item.listing_id, license_template_id: chosen.license_template_id, title: item.title, license: chosen.name, price: chosen.price }); }}>{s.addToCart}</button>{cart.items.some(i => i.listing_id === item.listing_id) && <Link prefetch={false} href={`/${locale}/store/cart`}>{s.inCart}</Link>}</div> : <p className="notice">{s.buyersOnly}</p>}</section>
  </>;
}
