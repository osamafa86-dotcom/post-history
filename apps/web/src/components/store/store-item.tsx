"use client";
import { EmptyState, NoAccess } from "../empty-state";
import { useEffect, useState } from "react";
import Link from "next/link";
import { messages, type Locale } from "@/lib/i18n";
import { hasRole } from "@/lib/review";
import { formatDay, formatDuration, formatMoney, localized, longDay, type CatalogItem } from "@/lib/store-format";
import { isBuyer } from "@/lib/buyer-policy";
import { browserApi, dataOrThrow } from "@/lib/browser-api";
import { currencyConflict } from "@/lib/cart-policy";
import { heldOn, type IssuedLicense } from "@/lib/issued-licenses";
import { useUser } from "../session-boundary";
import { Icon } from "../icon";
import { resolution, shotDay } from "./catalog-card";
import { LicensePicker } from "./license-picker";
import { WatermarkedPreview } from "./watermarked-preview";
import { catalogRoles } from "./store-catalog";
import { useCart } from "./cart";
import { governorateName } from "@/lib/format";

// صفحة المادة (S2): المعاينة بعلامة مائية وجودة أقل وهوية المشاهد، و«صُوّر» بيوم التصوير، والمحافظة وحدها، والتراخيص بسعر كلٍّ منها،
// وفعل أساسي واحد. لا اسم مراسل ولا نسب ولا مصدر، ولا بصمة ولا معرّف تقني، ولا قائمة لقطات (قرار الأمن: shot_list للمحرر وحده، والـBFF يفرغها).
// للمشتري تُقرأ تراخيص مؤسسته السارية: ما تملكه على هذه المادة يُسمّى برقمه على عرضه، وحصريتها هي تُقال لها. والسلة بعملة واحدة وبند لكل مادة:
// ترخيص آخر للمادة نفسها يبدّل ما في السلة، وعملة ثانية تُمنع مع ما العمل.
export function StoreItem({ locale, id }: { locale: Locale; id: string }) {
  const m = messages[locale], s = m.store, b = s.browse, it = s.item, me = useUser(), allowed = hasRole(me, ...catalogRoles), cart = useCart(), buyer = isBuyer(me);
  const [item, setItem] = useState<CatalogItem | null>(null), [status, setStatus] = useState(0), [offer, setOffer] = useState<string | null>(null), [toast, setToast] = useState<"added" | "replaced" | null>(null), [attempt, setAttempt] = useState(0);
  const [held, setHeld] = useState<ReturnType<typeof heldOn> | null>(null);
  useEffect(() => {
    if (!allowed || !buyer) return;
    const controller = new AbortController();
    void (async () => {
      const all: IssuedLicense[] = []; let cursor: string | undefined;
      for (let page = 0; page < 5; page++) {
        const data = dataOrThrow(await browserApi().GET("/licenses", { params: { query: { status: "active", limit: 100, ...(cursor ? { cursor } : {}) } }, signal: controller.signal }));
        all.push(...data.items); cursor = data.next_cursor ?? undefined; if (!cursor) break;
      }
      if (!controller.signal.aborted) setHeld(heldOn(all, id, Date.now()));
    })().catch(() => { /* بلا قائمة التراخيص لا شارات؛ الشراء كما هو */ });
    return () => controller.abort();
  }, [allowed, buyer, id, attempt]);
  useEffect(() => {
    if (!allowed) return;
    const controller = new AbortController();
    void fetch(`/api/bff/catalog/${id}`, { credentials: "same-origin", cache: "no-store", signal: controller.signal })
      .then(async response => { if (response.status === 401) window.dispatchEvent(new Event("session-revoked")); if (!response.ok) { setStatus(response.status); return; } setStatus(0); setItem(await response.json() as CatalogItem); })
      .catch(() => { if (!controller.signal.aborted) setStatus(503); });
    return () => controller.abort();
  }, [allowed, id, attempt]);
  useEffect(() => { if (!toast) return; const timer = setTimeout(() => setToast(null), 4000); return () => clearTimeout(timer); }, [toast]);
  if (!allowed) return <NoAccess locale={locale} me={me} title={s.title} denied={s.denied} />;
  const crumbs = (current?: string) => <nav className="breadcrumb" aria-label={it.breadcrumb}><ol><li><Link prefetch={false} href={`/${locale}/store`}>{s.nav.materials}</Link></li>{current && <li aria-current="page">{current}</li>}</ol></nav>;
  if (status) return <>{crumbs()}{status === 404 ? <EmptyState icon="store" role="alert" title={s.notFound} actions={<Link prefetch={false} className="button store" href={`/${locale}/store`}>{s.catalog.showAll}</Link>} />
    : <EmptyState icon="offline" role="alert" title={m.error} actions={<button className="secondary" onClick={() => setAttempt(n => n + 1)}>{m.retry}</button>} />}</>;
  if (!item) return <>{crumbs()}<div className="store-detail" aria-hidden="true"><div className="store-preview skeleton-block" /></div><p className="visually-hidden" role="status">{m.loading}</p></>;
  const title = localized(item.title, locale), day = longDay(shotDay(item.shot_on), locale), duration = formatDuration(item.duration_ms), size = resolution(item.width, item.height);
  const offerId = (o: CatalogItem["offers"][number]) => `${o.license_template_id}:${o.license_version}`;
  // ما في السلة لهذه المادة هو المختار حتى يُختار غيره (بعد إعادة التحميل أيضًا)
  const carted = cart.items.find(i => i.listing_id === item.listing_id), inCart = !!carted, cartedOffer = item.offers.find(o => o.license_template_id === carted?.license_template_id);
  const picked = offer ?? (cartedOffer ? offerId(cartedOffer) : null), chosen = item.offers.find(o => offerId(o) === picked), same = !!chosen && chosen.license_template_id === carted?.license_template_id;
  const conflict = chosen ? currencyConflict(cart.items, { listing_id: item.listing_id, price: chosen.price }) : null, blocked = !!item.exclusive_unavailable_until;
  const verified = formatDay(item.verified_on, locale), approved = formatDay(item.editorial_approved_on, locale);
  const owned = Object.fromEntries(item.offers.flatMap(o => held?.numbers[o.license_template_id] ? [[offerId(o), held.numbers[o.license_template_id]]] : []));
  function add() {
    if (!chosen || !item || conflict || same || blocked) return;
    cart.add({ listing_id: item.listing_id, license_template_id: chosen.license_template_id, title: item.title, license: chosen.name, license_type: chosen.type, price: chosen.price });
    setToast(inCart ? "replaced" : "added");
  }
  const action = buyer ? <div className="store-buy">
    {/* بعد الإضافة: الخطوة التالية هي الفعل الأساسي («اذهب إلى السلة» بعدّها)، وتبديل ترخيص المادة في السلة ثانوي (بند واحد لكل مادة). */}
    {inCart && <Link prefetch={false} className="button store" data-testid="go-to-cart" href={`/${locale}/store/cart`}>{s.goToCart.replace("{n}", String(cart.items.length))}</Link>}
    <button className={inCart ? "secondary" : "store"} data-testid="add-to-cart" disabled={!chosen || !!conflict || same || blocked} onClick={add} aria-describedby="buy-note">{inCart ? (same || !chosen ? b.inCart : b.replaceInCart) : chosen ? <>{b.addFor.split("{price}")[0]}<bdi dir="ltr">{formatMoney(chosen.price, locale)}</bdi>{b.addFor.split("{price}")[1]}</> : s.addToCart}</button>
    {conflict && chosen && <p className="notice error" role="alert" data-testid="currency-conflict">{b.otherCurrency.replace("{have}", conflict).replace("{want}", chosen.price.currency)} {!inCart && <Link prefetch={false} href={`/${locale}/store/cart`}>{s.nav.cart}</Link>}</p>}
    {!chosen && !blocked && <small className="muted">{it.choose}</small>}
    {toast && <p className="toast" role="status">{toast === "replaced" ? b.replaced : b.added}</p>}
  </div> : <p className="notice">{s.buyersOnly}</p>;
  return <>
    {crumbs(title)}
    <div className="store-detail">
      <div className="store-detail-main">
        <WatermarkedPreview locale={locale} src={`/api/bff/catalog/${item.listing_id}/preview`} viewer={me.email} />
        <p className="caption">{it.previewNote}</p>
        <div className="store-title-row"><h1>{title}</h1>{!buyer && <span className="badge" data-testid="buyer-preview">{b.previewAsBuyer}</span>}</div>
        <ul className="store-facts" data-testid="item-facts">
          <li><Icon name="clock" />{day ? it.shot.replace("{date}", day) : it.noDate}</li>
          {item.governorate && <li><Icon name="pin" />{governorateName(item.governorate, m.governorates)}</li>}
          <li><Icon name="film" /><span>{[item.material_types.map(t => m.types[t]).join(m.shell.listSeparator), duration, size].filter((part): part is string => !!part).map((part, i) => <span key={i}>{i > 0 && s.catalog.listSeparator}{i ? <bdi dir="ltr">{part}</bdi> : part}</span>)}</span></li>
          {item.exclusive_available && <li><span className="badge rights">{b.exclusive}</span></li>}
        </ul>
        <p className="store-description">{localized(item.description, locale)}</p>
        <section className="store-trust" aria-labelledby="authenticity-title"><h2 id="authenticity-title"><Icon name="shield" /> {b.authenticity}</h2>
          <ul>{[[b.verifiedOriginal, [b.version.replace("{n}", String(item.material_version)), verified && b.verifiedOn.replace("{date}", verified)].filter(Boolean).join(s.catalog.listSeparator)],
            [b.editorial, approved ? b.approvedOn.replace("{date}", approved) : b.editorialHelp], [b.rights, it.rightsHelp]].map(([name, help]) => <li key={name}><span className="store-trust-icon"><Icon name="check" size={14} /></span><span><strong>{name}</strong><small>{help}</small></span></li>)}</ul>
          <p className="caption">{b.verifyNote}</p></section>
      </div>
      <aside className="store-detail-side">
        <section className="store-offers">
          <LicensePicker locale={locale} offers={item.offers.map(o => ({ id: `${o.license_template_id}:${o.license_version}`, type: o.type, name: o.name, price: o.price, terms: o.terms }))} exclusiveAvailable={item.exclusive_available} exclusiveUntil={item.exclusive_unavailable_until} ownExclusive={!!held?.exclusiveUntil} owned={owned} value={picked} onChange={value => { setOffer(value); setToast(null); }} />
          {action}
          <p className="caption" id="buy-note">{it.deliveryNote}</p>
          <details className="delivery-specs"><summary>{b.deliveryTitle}</summary><p className="caption">{b.deliveryText}</p></details>
        </section>
      </aside>
    </div>
  </>;
}
