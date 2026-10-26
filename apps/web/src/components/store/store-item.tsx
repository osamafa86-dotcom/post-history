"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { messages, type Locale } from "@/lib/i18n";
import { hasRole } from "@/lib/review";
import { formatDuration, formatMoney, localized, type CatalogItem } from "@/lib/store-format";
import { useUser } from "../session-boundary";
import { resolution, shotDay } from "./catalog-card";
import { LicensePicker } from "./license-picker";
import { WatermarkedPreview } from "./watermarked-preview";
import { catalogRoles } from "./store-catalog";
import { useCart } from "./cart";
import { isBuyer } from "@/lib/buyer-policy";

// صفحة المادة (D2): المعاينة بعلامة مائية وهوية المشاهد، وبطاقة الأصالة بلا بصمة ولا معرّف تقني، والتراخيص بأسعارها.
// لا قائمة لقطات للمشتري (قرار الأمن: shot_list للمحرر وحده، والـBFF يفرغها).
export function StoreItem({ locale, id }: { locale: Locale; id: string }) {
  const m = messages[locale], s = m.store, me = useUser(), allowed = hasRole(me, ...catalogRoles), cart = useCart(), buyer = isBuyer(me);
  const [item, setItem] = useState<CatalogItem | null>(null), [status, setStatus] = useState(0), [offer, setOffer] = useState<string | null>(null), [toast, setToast] = useState(false);
  useEffect(() => {
    if (!allowed) return;
    const controller = new AbortController();
    void fetch(`/api/bff/catalog/${id}`, { credentials: "same-origin", cache: "no-store", signal: controller.signal })
      .then(async response => { if (response.status === 401) window.dispatchEvent(new Event("session-revoked")); if (!response.ok) { setStatus(response.status); return; } setItem(await response.json() as CatalogItem); })
      .catch(() => { if (!controller.signal.aborted) setStatus(503); });
    return () => controller.abort();
  }, [allowed, id]);
  useEffect(() => { if (!toast) return; const timer = setTimeout(() => setToast(false), 4000); return () => clearTimeout(timer); }, [toast]);
  if (!allowed) return <section className="center-state"><h1>{s.title}</h1><p role="alert">{s.denied}</p></section>;
  const back = <Link prefetch={false} className="back-link" href={`/${locale}/store`}>{s.back}</Link>;
  if (status) return <>{back}<p className="center-state" role="alert">{status === 404 ? s.notFound : m.error}</p></>;
  if (!item) return <>{back}<p className="center-state" role="status">{m.loading}</p></>;
  const day = shotDay(item.shot_on), duration = formatDuration(item.duration_ms), b = s.browse, chosen = item.offers.find(o => `${o.license_template_id}:${o.license_version}` === offer);
  function add() {
    if (!chosen) return;
    cart.add({ listing_id: item!.listing_id, license_template_id: chosen.license_template_id, title: item!.title, license: chosen.name, price: chosen.price });
    setToast(true);
  }
  const facts = [item.material_types.map(t => m.types[t]).join(" · "), item.governorate, day && new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: "UTC" }).format(new Date(`${day}T00:00:00Z`)), duration && `\u2066${duration}\u2069`, resolution(item.width, item.height)].filter(Boolean).join(" · ");
  return <>{back}{toast && <p className="toast" role="status">{b.added}</p>}
    <div className="page-heading"><div><p className="muted" data-testid="item-facts">{facts} {item.exclusive_available && <span className="badge rights">{b.exclusive}</span>}</p><h1>{localized(item.title, locale)}</h1></div>{!buyer && <span className="badge" data-testid="buyer-preview">{b.previewAsBuyer}</span>}</div>
    <div className="store-detail">
      <div className="store-detail-main"><WatermarkedPreview locale={locale} src={`/api/bff/catalog/${item.listing_id}/preview`} viewer={me.email} />
        <section className="card"><h2>{b.about}</h2><p>{localized(item.description, locale)}</p><p className="caption">{s.credit}: {item.credit}</p></section></div>
      <aside className="store-detail-side">
        <section className="card authenticity" aria-labelledby="authenticity-title"><h2 id="authenticity-title"><span aria-hidden="true">🛡</span> {b.authenticity}</h2>
          <ul>{[[b.verifiedOriginal, b.version.replace("{n}", String(item.material_version))], [b.editorial, b.editorialHelp], [b.rights, b.rightsHolder.replace("{credit}", item.credit)]].map(([title, help]) => <li key={title}><span className="authenticity-icon" aria-hidden="true">✓</span><span><strong>{title}</strong><small className="muted">{help}</small></span></li>)}</ul>
          <p className="caption">{b.verifyNote}</p></section>
        <section className="card"><LicensePicker locale={locale} offers={item.offers.map(o => ({ id: `${o.license_template_id}:${o.license_version}`, type: o.type, name: o.name, price: o.price }))} exclusiveAvailable={item.exclusive_available} value={offer} onChange={id => { setOffer(id); setToast(false); }} />
          {buyer ? <div className="actions"><button disabled={!chosen} onClick={add}>{chosen ? b.addFor.replace("{price}", formatMoney(chosen.price, locale)) : s.addToCart}</button>{cart.items.some(i => i.listing_id === item.listing_id) && <Link prefetch={false} href={`/${locale}/store/cart`}>{s.inCart}</Link>}</div> : <p className="notice">{s.buyersOnly}</p>}
          <details className="delivery-specs"><summary>{b.deliveryTitle}</summary><p className="caption">{b.deliveryText}</p></details></section>
      </aside>
    </div>
  </>;
}
