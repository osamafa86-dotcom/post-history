"use client";
import { EmptyState, NoAccess } from "../empty-state";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { browserApi, dataOrThrow, RequestError } from "@/lib/browser-api";
import { formatDate, longDate, messages, plural, type Locale } from "@/lib/i18n";
import { hasRole } from "@/lib/review";
import { useMutation } from "@/lib/use-mutation";
import { fileFormat, formatDuration, formatMoney, localized, orderLabel } from "@/lib/store-format";
import { licenseDownloaders, licenseReaders, type IssuedLicense } from "@/lib/issued-licenses";
import { useUser } from "../session-boundary";
import { ActionStatus } from "../action-status";
import { Icon } from "../icon";
import { licenseTone } from "./license-verify";
import { numberLocale } from "@/lib/format";


/** عرض الترخيص في الجدول: المنتهي بتاريخه (وإن لم يحدّث الخادم حالته بعد)، والمبطل، والساري بحزمته جاهزة أو قيد التجهيز. */
export function licenseView(l: IssuedLicense, now: number): "ended" | "revoked" | "ready" | "preparing" {
  if (l.status === "revoked") return "revoked";
  if (l.status === "expired" || (l.valid_until && Date.parse(l.valid_until) <= now)) return "ended";
  return l.delivery_ready ? "ready" : "preparing";
}

/**
 * تراخيصي (S4): الترخيص مرتبط بطلبه برقمه المقروء (ADR 0100)، والفعل «تنزيل حزمة التسليم» برابط موقّع قصير العمر يُطلب عند النقر ولا يُحفظ.
 * المنتهي كلمة بتاريخه كاملًا بلون التحذير، و«تجديد» يفتح صفحة المادة لشراء ترخيص جديد (لا عملية تجديد في العقد). لا عدّاد استعمال: `License`
 * لا يحمله، و`downloads_remaining` في ردّ رابط التنزيل وحده فيظهر بعده.
 */
export function LicensesPage({ locale }: { locale: Locale }) {
  const m = messages[locale], t = m.licenses, me = useUser(), allowed = hasRole(me, ...licenseReaders), downloader = hasRole(me, ...licenseDownloaders), mutation = useMutation();
  const [items, setItems] = useState<IssuedLicense[] | null>(null), [error, setError] = useState(false), [attempt, setAttempt] = useState(0), [working, setWorking] = useState<string | null>(null), [remaining, setRemaining] = useState<{ id: string; n: number } | null>(null);
  const [now] = useState(() => Date.now()), clicks = useRef(0);
  // عضو المؤسسة يرى تراخيص مؤسسته كلها، لكن طلباته وحدها (العقد): رابط الفاتورة لطلب يفتحه وحده، وغيره رقم بلا رابط.
  const member = hasRole(me, "buyer_member") && !hasRole(me, "buyer_admin"), [ownOrders, setOwnOrders] = useState<Set<string> | null>(null);
  useEffect(() => {
    if (!allowed) return;
    const controller = new AbortController();
    void browserApi().GET("/licenses", { signal: controller.signal }).then(dataOrThrow).then(data => { if (!controller.signal.aborted) { setItems(data.items); setError(false); } }).catch(() => { if (!controller.signal.aborted) setError(true); });
    return () => controller.abort();
  }, [allowed, attempt]);
  useEffect(() => {
    if (!allowed || !member) return;
    const controller = new AbortController();
    void (async () => {
      const ids = new Set<string>(); let cursor: string | undefined;
      for (let page = 0; page < 10; page++) {
        const data = dataOrThrow(await browserApi().GET("/orders", { params: { query: { limit: 100, ...(cursor ? { cursor } : {}) } }, signal: controller.signal }));
        data.items.forEach(order => ids.add(order.id)); cursor = data.next_cursor ?? undefined; if (!cursor) break;
      }
      if (!controller.signal.aborted) setOwnOrders(ids);
    })().catch(() => { /* بلا قائمة لا روابط فواتير، والأرقام ظاهرة */ });
    return () => controller.abort();
  }, [allowed, member, attempt]);
  const opens = (orderId: string) => !member || !!ownOrders?.has(orderId);
  async function download(id: string) {
    let url: string | undefined, left: number | undefined;
    setWorking(id);
    // كل نقرة منحة تنزيل جديدة تُحصى في الخادم: بصمة النية فريدة لكل نقرة
    const ok = await mutation.run(`download:${id}:${++clicks.current}`, async header => { const result = await browserApi().POST("/licenses/{license_id}/download-url", { params: { path: { license_id: id }, header } }); url = result.data?.url; left = result.data?.downloads_remaining; return result; });
    setWorking(null);
    if (ok && url) { setRemaining(left === undefined ? null : { id, n: left }); window.location.assign(url); }
  }
  if (!allowed) return <NoAccess locale={locale} me={me} title={t.mine} denied={t.denied} />;
  return <>
    <div className="page-heading"><h1>{t.mine}</h1></div>
    {mutation.status && mutation.status !== 200 ? <><ActionStatus status={mutation.status} locale={locale} />{mutation.status === 409 && <p className="notice error">{t.downloadConflict}</p>}</> : null}
    {error ? <EmptyState icon="offline" role="alert" title={m.error} actions={<button className="secondary" onClick={() => setAttempt(n => n + 1)}>{m.retry}</button>} />
      : !items ? <p className="center-state" role="status">{m.loading}</p>
      : !items.length ? <EmptyState icon="license" title={t.emptyTitle} actions={<Link prefetch={false} className="button store" href={`/${locale}/store`}>{m.store.cartPage.browse}</Link>}><p>{t.emptyBody}</p></EmptyState>
      : <div className="store-table licenses-table"><table><thead><tr>{[t.colMaterial, t.colOrder, t.colLicence, t.colEnds, t.colAction].map(label => <th scope="col" key={label}>{label}</th>)}</tr></thead>
        <tbody>{items.map(l => {
          const title = localized(l.title, locale), view = licenseView(l, now), order = orderLabel({ id: l.order_id, order_number: l.order_number });
          return <tr key={l.id} data-testid="license-row" data-view={view}>
            <td data-label={t.colMaterial}><strong>{title}</strong><small className="license-number-line"><Link prefetch={false} href={`/${locale}/store/licenses/${l.id}`}><bdi dir="ltr" className="mono">{l.license_number}</bdi></Link></small></td>
            <td data-label={t.colOrder}>{opens(l.order_id) ? <Link prefetch={false} href={`/${locale}/store/orders/${l.order_id}/invoice`} aria-label={t.invoiceFor.replace("{id}", order)}><bdi dir="ltr" className="ref">{order}</bdi></Link> : <bdi dir="ltr" className="ref" data-testid="order-plain">{order}</bdi>}</td>
            <td data-label={t.colLicence}>{localized(l.terms.name, locale)}</td>
            <td data-label={t.colEnds}>{view === "ended" ? <span className="state-word warn"><Icon name="alert" size={14} />{t.endedOn.replace("{date}", longDate(l.valid_until, locale))}</span> : l.valid_until ? longDate(l.valid_until, locale) : t.noExpiry}</td>
            <td data-label={t.colAction} className="license-action">{
              view === "revoked" ? <span className="state-word danger"><Icon name="ban" size={14} />{t.revokedShort}{l.revoked_reason && <small> ({t.reasons[l.revoked_reason]})</small>}</span>
              : view === "ended" ? <Link prefetch={false} className="button secondary" href={`/${locale}/store/${l.listing_id}`} aria-label={t.renewFor.replace("{title}", title)}>{t.renew}</Link>
              : !downloader ? <Link prefetch={false} href={`/${locale}/store/licenses/${l.id}`}>{t.open}</Link>
              : view === "preparing" ? <span className="state-word muted"><Icon name="clock" size={14} />{t.preparingShort}</span>
              : <button className="store" disabled={mutation.busy} aria-busy={working === l.id} aria-label={t.downloadFor.replace("{title}", title)} onClick={() => void download(l.id)}><Icon name="download" />{t.download}</button>}
              {remaining?.id === l.id && <small className="muted" data-testid="downloads-remaining" role="status">{t.remaining.replace("{n}", String(remaining.n))}</small>}</td>
          </tr>;
        })}</tbody></table></div>}
    <p className="caption store-footnote">{t.footnote}</p>
  </>;
}

/** شهادة الترخيص بشروطه المجمّدة، والتنزيل برابط موقّع قصير العمر لا يُحفظ. */
export function LicenseCertificate({ locale, id }: { locale: Locale; id: string }) {
  const m = messages[locale], t = m.licenses, tp = m.templates, me = useUser(), mutation = useMutation(), downloader = hasRole(me, ...licenseDownloaders);
  const [license, setLicense] = useState<IssuedLicense | null>(null), [status, setStatus] = useState(0), [remaining, setRemaining] = useState<number | null>(null), clicks = useRef(0);
  useEffect(() => {
    const controller = new AbortController();
    void browserApi().GET("/licenses/{license_id}", { params: { path: { license_id: id } }, signal: controller.signal }).then(dataOrThrow).then(data => { if (!controller.signal.aborted) setLicense(data); }).catch(e => { if (!controller.signal.aborted) setStatus(e instanceof RequestError ? e.status : 503); });
    return () => controller.abort();
  }, [id]);
  async function download() {
    let url: string | undefined, left: number | undefined;
    // كل نقرة منحة تنزيل جديدة تُحصى في الخادم: بصمة النية فريدة لكل نقرة
    const ok = await mutation.run(`download:${id}:${++clicks.current}`, async header => { const result = await browserApi().POST("/licenses/{license_id}/download-url", { params: { path: { license_id: id }, header } }); url = result.data?.url; left = result.data?.downloads_remaining; return result; });
    if (ok && url) { setRemaining(left ?? null); window.location.assign(url); }
  }
  const back = <nav className="breadcrumb no-print" aria-label={m.store.item.breadcrumb}><ol><li><Link prefetch={false} href={`/${locale}/store/licenses`}>{t.mine}</Link></li>{license && <li aria-current="page"><bdi dir="ltr">{license.license_number}</bdi></li>}</ol></nav>;
  if (status) return <>{back}<p className="center-state" role="alert">{status === 404 ? t.notFound : m.error}</p></>;
  if (!license) return <>{back}<p className="center-state" role="status">{m.loading}</p></>;
  // «النوع» مرة واحدة: اسم القالب يُضاف حين يختلف عن اسم نوعه وحده. ومسار التحقق عنوان كامل من أصل الصفحة، قابل للنقر وصالح للطباعة.
  const typeName = m.store.licenseTypes[license.terms.type], templateName = localized(license.terms.name, locale), typeLine = templateName && templateName !== typeName ? `${typeName} · ${templateName}` : typeName;
  const verifyPath = `/${locale}/verify/${license.license_number}`;
  const terms = license.terms, territory = terms.territory.kind === "worldwide" ? tp.worldwide : (terms.territory.countries ?? []).join(", ");
  return <>{back}
    <article className="card certificate" data-testid="certificate">
      <p className="eyebrow">{t.certificate}</p><h1>{localized(license.title, locale)}</h1>
      <p><span className={`badge ${licenseTone(license.status)}`} data-testid="license-status">{t.statuses[license.status]}</span>{license.revoked_reason && <small className="muted"> {t.reasons[license.revoked_reason]}</small>}</p>
      <dl className="metadata">{[
        [t.number, <bdi dir="ltr" key="n">{license.license_number}</bdi>], [m.orders.orderNumber, <bdi dir="ltr" key="o" className="ref">{orderLabel({ id: license.order_id, order_number: license.order_number })}</bdi>], [t.type, typeLine],
        [tp.usage, terms.usage_media.map(u => tp.usageNames[u]).join("، ")], [tp.territory, territory], [tp.deliverables, terms.deliverables.map(d => tp.deliverableNames[d]).join("، ")],
        [tp.prohibitions, terms.prohibitions.map(p => tp.prohibitionNames[p]).join("، ") || "—"], [tp.attribution, localized(terms.attribution, locale)],
        [t.validFrom, formatDate(license.valid_from, locale)], [t.validUntil, license.valid_until ? formatDate(license.valid_until, locale) : t.noExpiry],
        ...(license.exclusive_until ? [[t.exclusiveUntil, formatDate(license.exclusive_until, locale)]] : []), [t.price, <bdi dir="ltr" key="p">{formatMoney(license.price, locale)}</bdi>], [t.issuedAt, formatDate(license.issued_at, locale)], [t.verify.link, <a key="v" href={verifyPath} data-testid="verify-url"><bdi dir="ltr" className="mono">{`${window.location.origin}${verifyPath}`}</bdi></a>],
      ].map(([label, value]) => <div key={String(label)}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
      <section><h2>{tp.terms}</h2><p className="terms-text">{localized(terms.terms, locale)}</p></section>
    </article>
    {license.status === "revoked" && <div className="notice error no-print" role="alert"><p>{t.revokedHelp.replace("{reason}", license.revoked_reason ? t.reasons[license.revoked_reason] : "—")}</p></div>}
    <section className="card no-print">{!!license.delivery_contents?.length && <><h2>{t.deliveryContents}</h2><ul data-testid="delivery-contents">{license.delivery_contents.map((c, i) => { const format = fileFormat(c.mime_type), kind = t.formats[format.kind];
          // بكلمات القارئ: نوع الملف لا رمز MIME، وكل قيمة باسمها.
          return <li key={i}>{tp.deliverableNames[c.deliverable]} · {format.name ? t.formatNamed.replace("{kind}", kind).replace("{name}", format.name) : kind} · {plural(c.count, m.shell.inbox.files, locale)}{c.duration_ms != null && <> · {m.store.duration} <bdi dir="ltr">{formatDuration(c.duration_ms)}</bdi></>}{c.width != null && c.height != null && <> · {m.store.resolution} <bdi dir="ltr">{c.width}×{c.height}</bdi></>}</li>; })}</ul></>}{license.delivery_size_bytes != null && <p data-testid="delivery-size">{t.deliverySize.replace("{size}", new Intl.NumberFormat(numberLocale(locale), { maximumFractionDigits: 2 }).format(license.delivery_size_bytes / 1024 ** 2))}</p>}<p className="overline">{t.filesNote}</p>{mutation.status !== 200 && <ActionStatus status={mutation.status} locale={locale} />}{mutation.status === 409 && <p className="notice error">{t.downloadConflict}</p>}
      {remaining !== null && <p className="muted" data-testid="downloads-remaining">{t.remaining.replace("{n}", String(remaining))}</p>}
      {!license.delivery_ready && license.status === "active" && <p className="notice">{t.preparing}</p>}
      <div className="actions">{downloader && <button className="store" disabled={mutation.busy || license.status !== "active" || !license.delivery_ready} onClick={() => void download()}>{t.download}</button>}<button className="secondary" onClick={() => window.print()}>{t.print}</button><Link prefetch={false} className="quiet" href={verifyPath}>{t.verify.link}</Link></div>
      <p className="muted">{t.downloadHelp}</p></section>
  </>;
}
