"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { browserApi, dataOrThrow, RequestError } from "@/lib/browser-api";
import { formatDate, messages, type Locale } from "@/lib/i18n";
import { hasRole } from "@/lib/review";
import { useMutation } from "@/lib/use-mutation";
import { formatMoney, localized } from "@/lib/store-format";
import { licenseDownloaders, licenseReaders, type IssuedLicense } from "@/lib/issued-licenses";
import { useUser } from "../session-boundary";
import { ActionStatus } from "../action-status";
import { licenseTone } from "./license-verify";


/** تراخيص المؤسسة الصادرة (#203 بند 31). */
export function LicensesPage({ locale }: { locale: Locale }) {
  const m = messages[locale], t = m.licenses, me = useUser(), allowed = hasRole(me, ...licenseReaders);
  const [items, setItems] = useState<IssuedLicense[] | null>(null), [error, setError] = useState(false), [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!allowed) return;
    const controller = new AbortController();
    void browserApi().GET("/licenses", { signal: controller.signal }).then(dataOrThrow).then(data => { if (!controller.signal.aborted) { setItems(data.items); setError(false); } }).catch(() => { if (!controller.signal.aborted) setError(true); });
    return () => controller.abort();
  }, [allowed, attempt]);
  if (!allowed) return <section className="center-state"><h1>{t.title}</h1><p role="alert">{t.denied}</p></section>;
  return <><div className="page-heading"><div><h1>{t.title}</h1><p className="muted">{t.lead}</p></div><Link prefetch={false} className="button secondary" href={`/${locale}/store/orders`}>{t.invoices}</Link></div>
    {error ? <section className="center-state" role="alert"><p>{m.error}</p><button onClick={() => setAttempt(n => n + 1)}>{m.retry}</button></section>
      : !items ? <p className="center-state" role="status">{m.loading}</p> : !items.length ? <section className="empty"><p>{t.empty}</p><Link prefetch={false} href={`/${locale}/store`}>{m.store.back}</Link></section>
      : <ul className="license-cards">{items.map(l => <li key={l.id} className="card license-card" data-testid="license-row">
        <p className="license-head"><bdi className="mono license-number" dir="ltr">{l.license_number}</bdi><span className={`badge ${licenseTone(l.status)}`}>{t.statuses[l.status]}</span></p>
        <h2>{localized(l.title, locale)}</h2>
        <p className="muted">{[m.store.licenseTypes[l.terms.type], l.terms.term_days ? t.days.replace("{n}", String(l.terms.term_days)) : null, l.terms.territory.kind === "worldwide" ? m.templates.worldwide : (l.terms.territory.countries ?? []).join(", "), l.valid_until ? `${t.validUntil} ${formatDate(l.valid_until, locale)}` : t.noExpiry].filter(Boolean).join(" · ")}</p>
        <div className="actions"><Link prefetch={false} className="button secondary" href={`/${locale}/store/licenses/${l.id}`}>{t.open}</Link><Link prefetch={false} className="quiet" href={`/${locale}/verify/${l.license_number}`}>{t.verify.link}</Link></div></li>)}</ul>}
  </>;
}

/** شهادة الترخيص بشروطه المجمّدة، والتنزيل برابط موقّع قصير العمر لا يُحفظ. */
export function LicenseCertificate({ locale, id }: { locale: Locale; id: string }) {
  const m = messages[locale], t = m.licenses, tp = m.templates, me = useUser(), mutation = useMutation(), downloader = hasRole(me, ...licenseDownloaders);
  const [license, setLicense] = useState<IssuedLicense | null>(null), [status, setStatus] = useState(0), [remaining, setRemaining] = useState<number | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void browserApi().GET("/licenses/{license_id}", { params: { path: { license_id: id } }, signal: controller.signal }).then(dataOrThrow).then(data => { if (!controller.signal.aborted) setLicense(data); }).catch(e => { if (!controller.signal.aborted) setStatus(e instanceof RequestError ? e.status : 503); });
    return () => controller.abort();
  }, [id]);
  async function download() {
    let url: string | undefined, left: number | undefined;
    const ok = await mutation.run(`download:${id}:${Date.now()}`, async header => { const result = await browserApi().POST("/licenses/{license_id}/download-url", { params: { path: { license_id: id }, header } }); url = result.data?.url; left = result.data?.downloads_remaining; return result; });
    if (ok && url) { setRemaining(left ?? null); window.location.assign(url); }
  }
  const back = <Link prefetch={false} className="back-link" href={`/${locale}/store/licenses`}>{t.title}</Link>;
  if (status) return <>{back}<p className="center-state" role="alert">{status === 404 ? t.notFound : m.error}</p></>;
  if (!license) return <>{back}<p className="center-state" role="status">{m.loading}</p></>;
  const terms = license.terms, territory = terms.territory.kind === "worldwide" ? tp.worldwide : (terms.territory.countries ?? []).join(", ");
  return <>{back}
    <article className="card certificate" data-testid="certificate">
      <p className="eyebrow">{t.certificate}</p><h1>{localized(license.title, locale)}</h1>
      <p><span className={`badge ${licenseTone(license.status)}`} data-testid="license-status">{t.statuses[license.status]}</span>{license.revoked_reason && <small className="muted"> {t.reasons[license.revoked_reason]}</small>}</p>
      <dl className="metadata">{[
        [t.number, <bdi dir="ltr" key="n">{license.license_number}</bdi>], [t.type, `${m.store.licenseTypes[terms.type]} · ${localized(terms.name, locale)}`],
        [tp.usage, terms.usage_media.map(u => tp.usageNames[u]).join("، ")], [tp.territory, territory], [tp.deliverables, terms.deliverables.map(d => tp.deliverableNames[d]).join("، ")],
        [tp.prohibitions, terms.prohibitions.map(p => tp.prohibitionNames[p]).join("، ") || "—"], [tp.attribution, localized(terms.attribution, locale)],
        [t.validFrom, formatDate(license.valid_from, locale)], [t.validUntil, license.valid_until ? formatDate(license.valid_until, locale) : t.noExpiry],
        ...(license.exclusive_until ? [[t.exclusiveUntil, formatDate(license.exclusive_until, locale)]] : []), [t.price, <bdi dir="ltr" key="p">{formatMoney(license.price, locale)}</bdi>], [t.issuedAt, formatDate(license.issued_at, locale)], [t.verify.link, <bdi dir="ltr" key="v" className="mono">{`/${locale}/verify/${license.license_number}`}</bdi>],
      ].map(([label, value]) => <div key={String(label)}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
      <section><h2>{tp.terms}</h2><p className="terms-text">{localized(terms.terms, locale)}</p></section>
    </article>
    {license.status === "revoked" && <div className="notice error no-print" role="alert"><p>{t.revokedHelp.replace("{reason}", license.revoked_reason ? t.reasons[license.revoked_reason] : "—")}</p></div>}
    <section className="card no-print"><p className="overline">{t.filesNote}</p>{mutation.status !== 200 && <ActionStatus status={mutation.status} locale={locale} />}{mutation.status === 409 && <p className="notice error">{t.downloadConflict}</p>}
      {remaining !== null && <p className="muted" data-testid="downloads-remaining">{t.remaining.replace("{n}", String(remaining))}</p>}
      {!license.delivery_ready && license.status === "active" && <p className="notice">{t.preparing}</p>}
      <div className="actions">{downloader && <button disabled={mutation.busy || license.status !== "active" || !license.delivery_ready} onClick={() => void download()}>{t.download}</button>}<button className="secondary" onClick={() => window.print()}>{t.print}</button><Link prefetch={false} className="quiet" href={`/${locale}/verify/${license.license_number}`}>{t.verify.link}</Link></div>
      <p className="muted">{t.downloadHelp}</p></section>
  </>;
}
