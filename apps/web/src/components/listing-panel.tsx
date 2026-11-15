"use client";
import { useEffect, useState } from "react";
import { browserApi, dataOrThrow, RequestError } from "@/lib/browser-api";
import { formatDate, messages, type Locale } from "@/lib/i18n";
import type { Material } from "@/lib/types";
import { hasRole } from "@/lib/review";
import { useMutation } from "@/lib/use-mutation";
import { formatMoney, localized } from "@/lib/store-format";
import { shortTextMax, type Template } from "@/lib/license-policy";
import type { Refusal } from "@/lib/refusal-policy";
import { emptyListing, inputOf, listingInput, listingLimits, listingReaders, listingStates, listingWriters, type Listing, type ListingInput } from "@/lib/listing-policy";
import { sensitivityState } from "@/lib/sensitivity";
import { useUser } from "./session-boundary";
import { ActionStatus } from "./action-status";
import { Icon } from "./icon";

type Loaded = { listing: Listing | null; tag: string | null };

/**
 * شروط العرض الأربعة بحالتها قبل أي محاولة (ADR 0118): الحقوق، والاعتماد التحريري للإصدار، والأصل المتحقق، وعدم الوسم بالحساسية. ما يراه
 * مسؤول الحقوق في صفحة المادة نفسها؛ والخادم يعيد التحقق عند الحفظ ويسمّي ما فشل.
 */
export function ListingConditions({ locale, material }: { locale: Locale; material: Pick<Material, "rights_state" | "editorial_state" | "technical_state" | "sensitivity"> }) {
  const c = messages[locale].listing.conditions, sensitivity = sensitivityState(material.sensitivity);
  const rows = [["rights_state", material.rights_state === "sellable"], ["editorial_state", material.editorial_state === "published"], ["technical_state", material.technical_state === "verified"], ["sensitivity", sensitivity.known && !sensitivity.flags.length]] as const;
  return <div className="listing-conditions" data-testid="listing-conditions"><p className="caption">{c.title}</p><ul>{rows.map(([name, met]) => <li key={name} data-met={met}>
    <Icon name={met ? "check" : "x"} size={14} /><span>{c[name]}</span><span className="visually-hidden">{met ? c.met : c.unmet}</span></li>)}</ul></div>;
}

/** إدراج المادة في الكتالوج للطاقم؛ المشتري يرى الكتالوج وحده بقائمته البيضاء. */
export function ListingPanel({ locale, material }: { locale: Locale; material: Material }) {
  const m = messages[locale], t = m.listing, me = useUser(), writer = hasRole(me, ...listingWriters), admin = hasRole(me, "system_admin"), mutation = useMutation();
  const [loaded, setLoaded] = useState<Loaded | null>(null), [templates, setTemplates] = useState<Template[]>([]), [error, setError] = useState(false), [attempt, setAttempt] = useState(0);
  const [draft, setDraft] = useState<ListingInput | null>(null), [invalid, setInvalid] = useState(false), [dropped, setDropped] = useState(0);
  const readable = hasRole(me, ...listingReaders), sellable = material.rights_state === "sellable";
  useEffect(() => {
    if (!readable) return;
    const controller = new AbortController();
    (async () => {
      try {
        const result = await browserApi().GET("/materials/{id}/listing", { params: { path: { id: material.id } }, signal: controller.signal });
        // بلا إدراج: 204 من الـBFF (و404 من خادم أقدم)، فالحالة فارغة.
        const found = [204, 404].includes(result.response.status) ? null : dataOrThrow(result);
        const list = writer ? dataOrThrow(await browserApi().GET("/license-templates", { signal: controller.signal })).items : [];
        if (!controller.signal.aborted) { setLoaded({ listing: found, tag: result.response.headers.get("ETag") }); setTemplates(list); setError(false); }
      } catch (e) { if (!controller.signal.aborted && !(e instanceof RequestError && e.status === 404)) setError(true); }
    })();
    return () => controller.abort();
  }, [material.id, attempt, readable, writer]);
  if (!readable) return null;

  async function save() {
    if (!draft || !loaded) return;
    const input = listingInput(draft as unknown as Record<string, unknown>);
    if (!input) { setInvalid(true); return; }
    setInvalid(false);
    const existing = loaded.listing, tag = loaded.tag;
    const ok = await mutation.run(JSON.stringify([material.id, tag, input]), header => existing
      ? browserApi().PUT("/materials/{id}/listing", { params: { path: { id: material.id }, header: { ...header, "If-Match": tag ?? "" } }, body: input })
      : browserApi().POST("/materials/{id}/listing", { params: { path: { id: material.id }, header }, body: input }));
    if (ok) { setDraft(null); setAttempt(n => n + 1); }
  }
  const set = <K extends keyof ListingInput>(key: K, value: ListingInput[K]) => setDraft(current => current && { ...current, [key]: value });
  // عروض القوالب المعطَّلة تُسقط عند فتح النموذج ويُقال ذلك: الخادم لا يقبل حفظها، ولا تظهر في النموذج فتُزال يدويًا.
  function open() {
    const base = loaded?.listing ? inputOf(loaded.listing) : emptyListing(material.title), offers = base.offers.filter(o => templates.some(t => t.id === o.license_template_id));
    setDropped(base.offers.length - offers.length); setDraft({ ...base, offers });
  }
  const listing = loaded?.listing ?? null;

  return <section className="card" aria-labelledby="listing-title"><h2 id="listing-title">{t.title}</h2>
    {error ? <><p role="alert">{m.error}</p><button className="secondary" onClick={() => setAttempt(n => n + 1)}>{m.retry}</button></>
      : !loaded ? <p role="status">{m.loading}</p>
      : draft ? <>{dropped > 0 && <p className="notice attention" role="status" data-testid="dropped-offers">{t.droppedOffers.replace("{n}", String(dropped))}</p>}
        <ListingConditions locale={locale} material={material} />
        <ListingForm locale={locale} draft={draft} templates={templates} set={set} admin={admin} sellable={sellable} busy={mutation.busy} invalid={invalid} status={mutation.status} refusal={mutation.refusal} onSave={() => void save()} onCancel={() => setDraft(null)} /></>
      : <>{listing ? <dl className="metadata" data-testid="listing-summary">{[
          [t.state, t.states[listing.state] + (listing.suspended_reason ? ` (${t.reasons[listing.suspended_reason]})` : "")],
          [t.listingTitle, localized(listing.title, locale)], [t.materialVersion, listing.material_version], [t.listedAt, formatDate(listing.listed_at, locale)], [t.offers, listing.offers.length],
        ].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl> : <p className="muted">{t.none}</p>}
        {!sellable && <p className="notice">{t.notSellable}</p>}
        {writer && <ListingConditions locale={locale} material={material} />}
        <ActionStatus status={mutation.status} locale={locale} refusal={mutation.refusal} />
        {writer && <button onClick={() => { mutation.clearStatus(); setInvalid(false); open(); }}>{listing ? t.edit : t.create}</button>}</>}
  </section>;
}

function Bilingual({ legend, value, change, area, names, max = 4000 }: { legend: string; value: { ar: string; en: string }; change: (next: { ar: string; en: string }) => void; area?: boolean; names: { ar: string; en: string }; max?: number }) {
  return <fieldset className="check-group bilingual"><legend>{legend}</legend>{(["ar", "en"] as const).map(lang => <label key={lang}>{names[lang]}{area
    ? <textarea lang={lang} dir={lang === "ar" ? "rtl" : "ltr"} rows={4} maxLength={4000} value={value[lang]} onChange={e => change({ ...value, [lang]: e.target.value })} />
    : <input lang={lang} dir={lang === "ar" ? "rtl" : "ltr"} maxLength={max} value={value[lang]} onChange={e => change({ ...value, [lang]: e.target.value })} />}</label>)}</fieldset>;
}

function ListingForm({ locale, draft, templates, set, admin, sellable, busy, invalid, status, refusal, onSave, onCancel }: { locale: Locale; draft: ListingInput; templates: Template[]; set: <K extends keyof ListingInput>(key: K, value: ListingInput[K]) => void; admin: boolean; sellable: boolean; busy: boolean; invalid: boolean; status: number; refusal: Refusal | null; onSave: () => void; onCancel: () => void }) {
  const m = messages[locale], t = m.listing, names = { ar: m.templates.arabic, en: m.templates.english };
  const offered = (id: string) => draft.offers.find(o => o.license_template_id === id);
  const toggle = (template: Template) => set("offers", offered(template.id) ? draft.offers.filter(o => o.license_template_id !== template.id) : [...draft.offers, { license_template_id: template.id, price_override: null }]);
  const override = (id: string, value: string, currency: "USD" | "ILS") => set("offers", draft.offers.map(o => o.license_template_id === id ? { ...o, price_override: value === "" ? null : { amount_minor: Math.round(Number(value) * 100), currency } } : o));
  return <form className="form-card rule-form" noValidate onSubmit={e => { e.preventDefault(); onSave(); }}>
    <Bilingual names={names} legend={t.listingTitle} value={draft.title} change={v => set("title", v)} max={shortTextMax} />
    <Bilingual names={names} legend={t.description} value={draft.description} change={v => set("description", v)} area />
    <fieldset className="check-group"><legend>{t.offers}</legend><small className="muted">{t.offersHelp}</small>
      {!templates.length && <p className="muted">{t.noTemplates}</p>}
      {templates.map(template => { const offer = offered(template.id), commercial = template.type === "commercial"; return <div key={template.id} className="offer-row" data-testid="listing-offer">
        <label className="check"><input type="checkbox" checked={!!offer} disabled={!offer && (draft.offers.length >= listingLimits.offers || commercial && !draft.commercial_allowed)} onChange={() => toggle(template)} />{localized(template.name, locale)} <small className="muted">{m.store.licenseTypes[template.type]} · <bdi dir="ltr">{formatMoney(template.base_price, locale)}</bdi></small></label>
        {offer && <label>{t.priceOverride}<input type="number" min={0} step="0.01" dir="ltr" value={offer.price_override ? offer.price_override.amount_minor / 100 : ""} placeholder={String(template.base_price.amount_minor / 100)} onChange={e => override(template.id, e.target.value, template.base_price.currency)} /></label>}
      </div>; })}</fieldset>
    <label className="check"><input type="checkbox" checked={draft.commercial_allowed ?? false} disabled={!admin} onChange={e => set("commercial_allowed", e.target.checked)} />{t.commercialAllowed}</label>
    {!admin && <small className="muted">{t.commercialAdmin}</small>}
    <label>{t.state}<select value={draft.state} onChange={e => set("state", e.target.value as ListingInput["state"])}>{listingStates.map(state => <option key={state} value={state} disabled={state === "listed" && !sellable}>{t.states[state]}</option>)}</select></label>
    {!sellable && <small className="muted">{t.notSellable}</small>}
    {invalid && <p className="notice error" role="alert">{t.invalid}</p>}
    <ActionStatus status={status} locale={locale} refusal={refusal} />
    <div className="actions"><button disabled={busy}>{busy ? m.review.saving : t.save}</button><button type="button" className="secondary" disabled={busy} onClick={onCancel}>{t.cancel}</button></div>
  </form>;
}
