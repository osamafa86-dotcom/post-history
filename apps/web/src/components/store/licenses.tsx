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

const tone = (status: IssuedLicense["status"]) => status === "active" ? "good" : "bad";

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
  return <><div className="page-heading"><div><h1>{t.title}</h1><p className="muted">{t.lead}</p></div></div>
    {error ? <section className="center-state" role="alert"><p>{m.error}</p><button onClick={() => setAttempt(n => n + 1)}>{m.retry}</button></section>
      : !items ? <p className="center-state" role="status">{m.loading}</p> : !items.length ? <p className="empty">{t.empty}</p>
      : <div className="table-panel"><div className="table-scroll"><table><thead><tr>{[t.number, t.material, t.type, t.validUntil, t.status, ""].map(label => <th scope="col" key={label}>{label}</th>)}</tr></thead>
        <tbody>{items.map(l => <tr key={l.id} data-testid="license-row"><td dir="ltr">{l.license_number}</td><td>{localized(l.title, locale)}</td><td>{m.store.licenseTypes[l.terms.type]}</td><td>{l.valid_until ? formatDate(l.valid_until, locale) : t.noExpiry}</td><td><span className={`badge ${tone(l.status)}`}>{t.statuses[l.status]}</span></td><td><Link prefetch={false} href={`/${locale}/store/licenses/${l.id}`}>{t.open}</Link></td></tr>)}</tbody></table></div></div>}
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
      <p><span className={`badge ${tone(license.status)}`} data-testid="license-status">{t.statuses[license.status]}</span>{license.revoked_reason && <small className="muted"> {t.reasons[license.revoked_reason]}</small>}</p>
      <dl className="metadata">{[
        [t.number, <bdi dir="ltr" key="n">{license.license_number}</bdi>], [t.type, `${m.store.licenseTypes[terms.type]} · ${localized(terms.name, locale)}`],
        [tp.usage, terms.usage_media.map(u => tp.usageNames[u]).join("، ")], [tp.territory, territory], [tp.deliverables, terms.deliverables.map(d => tp.deliverableNames[d]).join("، ")],
        [tp.prohibitions, terms.prohibitions.map(p => tp.prohibitionNames[p]).join("، ") || "—"], [tp.attribution, localized(terms.attribution, locale)],
        [t.validFrom, formatDate(license.valid_from, locale)], [t.validUntil, license.valid_until ? formatDate(license.valid_until, locale) : t.noExpiry],
        ...(license.exclusive_until ? [[t.exclusiveUntil, formatDate(license.exclusive_until, locale)]] : []), [t.price, <bdi dir="ltr" key="p">{formatMoney(license.price, locale)}</bdi>], [t.issuedAt, formatDate(license.issued_at, locale)],
      ].map(([label, value]) => <div key={String(label)}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
      <section><h2>{tp.terms}</h2><p className="terms-text">{localized(terms.terms, locale)}</p></section>
    </article>
    <section className="card no-print">{mutation.status !== 200 && <ActionStatus status={mutation.status} locale={locale} />}{mutation.status === 409 && <p className="notice error">{t.downloadConflict}</p>}
      {remaining !== null && <p className="muted" data-testid="downloads-remaining">{t.remaining.replace("{n}", String(remaining))}</p>}
      {!license.delivery_ready && license.status === "active" && <p className="notice">{t.preparing}</p>}
      <div className="actions">{downloader && <button disabled={mutation.busy || license.status !== "active" || !license.delivery_ready} onClick={() => void download()}>{t.download}</button>}<button className="secondary" onClick={() => window.print()}>{t.print}</button></div>
      <p className="muted">{t.downloadHelp}</p></section>
  </>;
}
