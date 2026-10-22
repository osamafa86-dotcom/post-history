"use client";
import { useEffect, useState } from "react";
import { browserApi, dataOrThrow } from "@/lib/browser-api";
import { messages, type Locale } from "@/lib/i18n";
import { hasRole } from "@/lib/review";
import { useMutation } from "@/lib/use-mutation";
import { formatMoney, localized } from "@/lib/store-format";
import { currencies, deliverables, emptyTemplate, inputOf, licenseTypes, prohibitions, templateInput, templateLimits, templateRoles, templateWriters, termRequired, usageMedia, type Template, type TemplateInput } from "@/lib/license-policy";
import { useUser } from "./session-boundary";
import { ActionStatus } from "./action-status";

type Draft = { id: string | null; tag: string | null; template: TemplateInput };
const toggle = <T,>(list: T[], value: T) => list.includes(value) ? list.filter(v => v !== value) : [...list, value];

export function LicenseTemplates({ locale }: { locale: Locale }) {
  const m = messages[locale], t = m.templates, me = useUser(), writer = hasRole(me, ...templateWriters), allowed = hasRole(me, ...templateRoles), mutation = useMutation();
  const [items, setItems] = useState<Template[] | null>(null), [error, setError] = useState(false), [attempt, setAttempt] = useState(0), [disabled, setDisabled] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null), [invalid, setInvalid] = useState(false);
  useEffect(() => {
    if (!allowed) return;
    const controller = new AbortController();
    void browserApi().GET("/license-templates", { params: { query: { include_disabled: disabled } }, signal: controller.signal }).then(dataOrThrow).then(data => { if (!controller.signal.aborted) { setItems(data.items); setError(false); } }).catch(() => { if (!controller.signal.aborted) setError(true); });
    return () => controller.abort();
  }, [attempt, allowed, disabled]);
  if (!allowed) return <section className="center-state"><h1>{t.title}</h1><p role="alert">{t.denied}</p></section>;

  async function open(template: Template) {
    // القراءة المفردة تعطي الإصدار الحالي في ETag؛ الحفظ يكتب إصدارًا جديدًا بعده.
    mutation.clearStatus(); setInvalid(false);
    try {
      const result = await browserApi().GET("/license-templates/{template_id}", { params: { path: { template_id: template.id } } });
      const data = dataOrThrow(result);
      setDraft({ id: data.id, tag: result.response.headers.get("ETag"), template: inputOf(data) });
    } catch { setError(true); }
  }
  async function save() {
    if (!draft) return;
    const input = templateInput(draft.template as unknown as Record<string, unknown>);
    if (!input) { setInvalid(true); return; }
    setInvalid(false);
    const current = draft;
    const ok = await mutation.run(JSON.stringify(current), header => current.id
      ? browserApi().PUT("/license-templates/{template_id}", { params: { path: { template_id: current.id }, header: { ...header, "If-Match": current.tag ?? "" } }, body: input })
      : browserApi().POST("/license-templates", { params: { header }, body: input }));
    if (ok) { setDraft(null); setAttempt(n => n + 1); }
  }
  const set = <K extends keyof TemplateInput>(key: K, value: TemplateInput[K]) => setDraft(current => current && { ...current, template: { ...current.template, [key]: value } });

  return <><div className="page-heading"><div><h1>{t.title}</h1><p className="muted">{t.lead}</p>{!writer && <p className="notice">{t.readOnly}</p>}</div>{writer && !draft && <button onClick={() => { mutation.clearStatus(); setInvalid(false); setDraft({ id: null, tag: null, template: emptyTemplate() }); }}>{t.new}</button>}</div>
    {!draft && <><ActionStatus status={mutation.status} locale={locale} /><label className="check"><input type="checkbox" checked={disabled} onChange={e => { setItems(null); setDisabled(e.target.checked); }} />{t.showDisabled}</label></>}
    {draft ? <TemplateForm locale={locale} template={draft.template} editing={!!draft.id} set={set} busy={mutation.busy} onSave={() => void save()} onCancel={() => setDraft(null)} invalid={invalid} status={mutation.status} />
      : error ? <section className="center-state" role="alert"><p>{m.error}</p><button onClick={() => setAttempt(n => n + 1)}>{m.retry}</button></section>
      : !items ? <p className="center-state" role="status">{m.loading}</p>
      : !items.length ? <p className="empty">{t.empty}</p>
      : <div className="table-panel"><div className="table-scroll"><table><thead><tr>{[t.name, t.type, t.price, t.version, t.enabledLabel, ""].map(label => <th scope="col" key={label}>{label}</th>)}</tr></thead>
        <tbody>{items.map(item => <tr key={item.id} data-testid="template-row"><td>{localized(item.name, locale)}</td><td>{m.store.licenseTypes[item.type]}</td><td dir="ltr">{formatMoney(item.base_price, locale)}</td><td>{item.version}</td><td><span className={`badge ${item.enabled ? "good" : ""}`}>{item.enabled ? t.enabled : t.disabled}</span></td>
          <td>{writer && <button className="secondary" onClick={() => void open(item)}>{t.edit}</button>}</td></tr>)}</tbody></table></div></div>}
  </>;
}

function Checks<T extends string>({ legend, values, selected, label, change, name, locked = [] }: { legend: string; values: readonly T[]; selected: T[]; label: (value: T) => string; change: (next: T[]) => void; name: string; locked?: readonly T[] }) {
  return <fieldset className="check-group"><legend>{legend}</legend>{values.map(value => <label key={value} className="check"><input type="checkbox" name={name} value={value} disabled={locked.includes(value)} checked={selected.includes(value)} onChange={() => change(toggle(selected, value))} />{label(value)}</label>)}</fieldset>;
}

function Bilingual({ legend, value, change, area, names }: { names: { ar: string; en: string }; legend: string; value: { ar: string; en: string }; change: (next: { ar: string; en: string }) => void; area?: boolean }) {
  return <fieldset className="check-group bilingual"><legend>{legend}</legend>{(["ar", "en"] as const).map(lang => <label key={lang}>{names[lang]}{area
    ? <textarea lang={lang} dir={lang === "ar" ? "rtl" : "ltr"} rows={4} maxLength={templateLimits.text} value={value[lang]} onChange={e => change({ ...value, [lang]: e.target.value })} />
    : <input lang={lang} dir={lang === "ar" ? "rtl" : "ltr"} maxLength={templateLimits.text} value={value[lang]} onChange={e => change({ ...value, [lang]: e.target.value })} />}</label>)}</fieldset>;
}

function TemplateForm({ locale, template, editing, set, busy, onSave, onCancel, invalid, status }: { locale: Locale; template: TemplateInput; editing: boolean; set: <K extends keyof TemplateInput>(key: K, value: TemplateInput[K]) => void; busy: boolean; onSave: () => void; onCancel: () => void; invalid: boolean; status: number }) {
  const m = messages[locale], t = m.templates, countries = template.territory.kind === "countries" ? template.territory.countries ?? [] : [];
  const number = (value: string) => value === "" ? null : Number(value);
  return <form className="card form-card rule-form" noValidate onSubmit={e => { e.preventDefault(); onSave(); }}>
    {editing && <p className="notice">{t.newVersion}</p>}
    <label>{t.type}<select value={template.type} disabled={editing} onChange={e => { const type = e.target.value as TemplateInput["type"]; set("type", type); set("exclusivity_hours", type === "exclusive_temporary" ? 48 : null); if (termRequired.includes(type) && !template.term_days) set("term_days", 365); }}>{licenseTypes.map(type => <option key={type} value={type}>{m.store.licenseTypes[type]}</option>)}</select></label>
    {template.type === "commercial" && <p className="muted">{t.commercialHelp}</p>}
    <Bilingual names={{ ar: t.arabic, en: t.english }} legend={t.name} value={template.name} change={v => set("name", v)} />
    <Bilingual names={{ ar: t.arabic, en: t.english }} legend={t.terms} value={template.terms} change={v => set("terms", v)} area />
    <Bilingual names={{ ar: t.arabic, en: t.english }} legend={t.attribution} value={template.attribution} change={v => set("attribution", v)} />
    <Checks legend={t.usage} name="usage" values={usageMedia} selected={template.usage_media} label={v => t.usageNames[v]} change={next => set("usage_media", next)} />
    <div className="rule-row"><label>{t.territory}<select value={template.territory.kind} onChange={e => set("territory", e.target.value === "worldwide" ? { kind: "worldwide" } : { kind: "countries", countries: [] })}><option value="worldwide">{t.worldwide}</option><option value="countries">{t.countries}</option></select></label>
      {template.territory.kind === "countries" && <label>{t.countryCodes}<input dir="ltr" value={countries.join(", ")} onChange={e => set("territory", { kind: "countries", countries: e.target.value.toUpperCase().split(/[\s,]+/).filter(Boolean) })} /><small className="muted">{t.countryHelp}</small></label>}</div>
    <div className="rule-row"><label>{t.term}<input type="number" min={templateLimits.termMin} max={templateLimits.termMax} value={template.term_days ?? ""} onChange={e => set("term_days", number(e.target.value))} /><small className="muted">{termRequired.includes(template.type) ? t.termRequired : t.termHelp}</small></label>
      {template.type === "exclusive_temporary" && <label>{t.exclusivity}<input type="number" min={templateLimits.hoursMin} max={templateLimits.hoursMax} value={template.exclusivity_hours ?? ""} onChange={e => set("exclusivity_hours", number(e.target.value))} /></label>}</div>
    <Checks legend={t.deliverables} name="deliverables" values={deliverables} selected={template.deliverables} label={v => t.deliverableNames[v]} change={next => set("deliverables", next)} />
    <Checks legend={t.prohibitions} name="prohibitions" values={prohibitions} locked={["ai_training"]} selected={template.prohibitions} label={v => t.prohibitionNames[v]} change={next => set("prohibitions", next)} />
    <small className="muted">{t.aiHelp}</small>
    <div className="rule-row"><label>{t.price}<input type="number" min={0} step="0.01" dir="ltr" value={template.base_price.amount_minor / 100} onChange={e => set("base_price", { ...template.base_price, amount_minor: Math.round(Number(e.target.value) * 100) })} /></label>
      <label>{t.currency}<select value={template.base_price.currency} onChange={e => set("base_price", { ...template.base_price, currency: e.target.value as TemplateInput["base_price"]["currency"] })}>{currencies.map(c => <option key={c} value={c}>{c}</option>)}</select></label></div>
    <label className="check"><input type="checkbox" checked={template.enabled} onChange={e => set("enabled", e.target.checked)} />{t.enabled}</label>
    {invalid && <p className="notice error" role="alert">{t.invalid}</p>}
    <ActionStatus status={status} locale={locale} />
    <div className="actions"><button disabled={busy}>{busy ? m.review.saving : t.save}</button><button type="button" className="secondary" disabled={busy} onClick={onCancel}>{t.cancel}</button></div>
  </form>;
}
