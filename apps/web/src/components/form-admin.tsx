"use client";
import { useEffect, useRef, useState } from "react";
import { browserApi, dataOrThrow } from "@/lib/browser-api";
import { fieldTypes, formBodyLimit, formReaders, formWriters, newField, nextForm, publishBody, validForm, type FormSummary } from "@/lib/form-admin";
import { formatDate, messages, type Locale } from "@/lib/i18n";
import { materialTypes } from "@/lib/query";
import { hasRole } from "@/lib/review";
import type { Field, Form, MaterialType } from "@/lib/types";
import { useMutation } from "@/lib/use-mutation";
import { ActionStatus } from "./action-status";
import { DynamicForm } from "./dynamic-form";
import { useUser } from "./session-boundary";

export function FormAdmin({ locale }: { locale: Locale }) {
  const m = messages[locale], t = m.formsAdmin, me = useUser(), allowed = hasRole(me, ...formReaders), writer = hasRole(me, ...formWriters), mutation = useMutation();
  const [items, setItems] = useState<FormSummary[] | null>(null), [current, setCurrent] = useState<Form | null>(null), [selected, setSelected] = useState<Form | null>(null);
  const [attempt, setAttempt] = useState(0), [error, setError] = useState(false), [reading, setReading] = useState(false), sequence = useRef({ value: 0 });
  const [draft, setDraft] = useState<Form | null>(null), [preview, setPreview] = useState<Form | null>(null), [invalid, setInvalid] = useState(false), [oversize, setOversize] = useState(false);
  const [confirm, setConfirm] = useState<"publish" | "discard" | null>(null);
  const [previewType, setPreviewType] = useState<MaterialType>("report"), [previewLocale, setPreviewLocale] = useState<Locale>(locale);
  useEffect(() => {
    if (!allowed) return;
    const counter = sequence.current, controller = new AbortController(), seq = ++counter.value;
    void Promise.all([browserApi().GET("/forms", { signal: controller.signal }).then(dataOrThrow), browserApi().GET("/forms/current", { signal: controller.signal }).then(result => result.response.status === 404 ? null : dataOrThrow(result))])
      .then(([list, latest]) => { if (!controller.signal.aborted && counter.value === seq) { setItems(list.items); setCurrent(latest); setSelected(latest); setError(false); } })
      .catch(() => { if (!controller.signal.aborted && counter.value === seq) setError(true); });
    return () => { controller.abort(); counter.value++; };
  }, [allowed, attempt]);
  if (!allowed) return <section className="center-state"><h1>{t.title}</h1><p role="alert">{t.denied}</p></section>;

  async function select(version: number) {
    const seq = ++sequence.current.value; setReading(true); setError(false);
    try {
      const value = dataOrThrow(await browserApi().GET("/forms/{version}", { params: { path: { version } } }));
      if (sequence.current.value === seq) setSelected(value);
    } catch { if (sequence.current.value === seq) setError(true); }
    finally { if (sequence.current.value === seq) setReading(false); }
  }
  function edit(next: Form) { setDraft(next); setPreview(null); setInvalid(false); setOversize(false); mutation.clearStatus(); }
  function review() {
    if (!draft) return;
    const valid = validForm(draft), tooLarge = new TextEncoder().encode(JSON.stringify(publishBody(draft))).length > formBodyLimit;
    setInvalid(!valid); setOversize(tooLarge);
    if (valid && !tooLarge) setPreview(structuredClone(draft));
  }
  async function publish() {
    if (!draft || !preview) return;
    setConfirm(null);
    const snapshot = publishBody(preview), tag = `"${preview.version - 1}"`;
    if (await mutation.run(JSON.stringify(snapshot), header => browserApi().POST("/forms", { params: { header: { ...header, "If-Match": tag } }, body: snapshot }))) {
      setDraft(null); setPreview(null); setItems(null); setSelected(null); setAttempt(n => n + 1);
    }
  }
  const shown = draft ? preview : selected;
  return <>
    <div className="page-heading"><div><h1>{t.title}</h1><p className="muted">{t.lead}</p>{!writer && <p className="notice">{t.readOnly}</p>}</div>
      {!draft && writer && items && !error && <button disabled={reading} onClick={() => { mutation.clearStatus(); edit(nextForm(selected, current?.version ?? 0)); }}>{selected ? t.clone : t.create}</button>}
    </div>
    <ActionStatus status={mutation.status} locale={locale} />
    {error && <p className="notice error" role="alert">{m.error} <button disabled={!!draft} onClick={() => { setItems(null); setAttempt(n => n + 1); }}>{m.retry}</button></p>}
    {!items && !error && <p role="status">{m.loading}</p>}
    {items && !draft && <section className="card"><h2>{t.history}</h2>{items.length === 0 ? <p>{t.empty}</p> : <>
      <label>{t.version}<select value={selected?.version ?? ""} disabled={reading} onChange={e => void select(Number(e.target.value))}>{items.map(item => <option key={item.version} value={item.version}>{item.version}{item.version === current?.version ? ` · ${t.current}` : ""}</option>)}</select></label>
      {selected && <p className="muted">{t.fieldCount}: {selected.fields.length} · {t.publishedAt}: {formatDate(selected.published_at, locale)}</p>}
      {reading && <p role="status">{m.loading}</p>}
    </>}</section>}
    {draft && <section className="card form-editor"><h2>{t.draft} {draft.version}</h2><p>{t.immutable}</p>
      <fieldset disabled={mutation.busy} className="form-editor-controls">
        <MaterialChecks locale={locale} value={draft.material_types ?? []} change={types => edit({ ...draft, material_types: types })} />
        {draft.fields.map((field, index) => <FieldEditor key={index} locale={locale} field={field} index={index} fields={draft.fields}
          change={next => edit({ ...draft, fields: draft.fields.map((f, i) => i === index ? next : f) })}
          remove={() => edit({ ...draft, fields: draft.fields.filter((_, i) => i !== index) })}
          move={delta => { const fields = [...draft.fields]; [fields[index], fields[index + delta]] = [fields[index + delta], fields[index]]; edit({ ...draft, fields }); }} />)}
        <button className="secondary" onClick={() => { let n = draft.fields.length + 1; while (draft.fields.some(f => f.key === `field_${n}`)) n++; edit({ ...draft, fields: [...draft.fields, newField("short_text", `field_${n}`)] }); }}>{t.addField}</button>
        <p className="muted">{t.v0}</p><p className="muted">{t.searchHelp}</p>
        {invalid && <p className="notice error" role="alert">{t.invalid}</p>}
        {oversize && <p className="notice error" role="alert">{t.tooLarge}</p>}
        <div className="actions"><button onClick={review}>{t.preview}</button><button className="secondary" onClick={() => setConfirm("discard")}>{t.discard}</button></div>
      </fieldset>
      {(mutation.status === 409 || mutation.status === 412) && <p className="notice">{t.conflictHelp}</p>}
    </section>}
    {shown && !reading && <section className="card form-admin-preview" aria-label={t.preview}>
      <h2>{t.preview} · {t.version} {shown.version}</h2><p className="muted">{t.previewHelp}</p>
      <div className="rule-row"><label>{t.previewLanguage}<select value={previewLocale} onChange={e => setPreviewLocale(e.target.value as Locale)}><option value="ar">{t.arabic}</option><option value="en">{t.english}</option></select></label>
        <label>{m.materialType}<select value={previewType} onChange={e => setPreviewType(e.target.value as MaterialType)}>{materialTypes.map(type => <option key={type} value={type}>{m.types[type]}</option>)}</select></label></div>
      <div lang={previewLocale} dir={previewLocale === "ar" ? "rtl" : "ltr"}>
        <DynamicForm key={`${JSON.stringify(shown)}:${previewType}:${previewLocale}`} schema={shown} type={previewType} permissions={[]} locale={previewLocale} />
      </div>
      {draft && preview && <button disabled={mutation.busy || mutation.status === 409 || mutation.status === 412} onClick={() => setConfirm("publish")}>{t.publish}</button>}
    </section>}
    {confirm && <dialog className="modal" ref={node => { if (node && !node.open) node.showModal(); }} onCancel={() => setConfirm(null)} aria-labelledby="form-confirm-title"><h2 id="form-confirm-title">{confirm === "publish" ? t.publish : t.discard}</h2><p>{confirm === "publish" ? t.publishWarning : t.discardWarning}</p>
      <div className="actions"><button autoFocus className="secondary" onClick={() => setConfirm(null)}>{m.cancel}</button><button disabled={mutation.busy} onClick={() => { if (confirm === "publish") void publish(); else { setConfirm(null); setDraft(null); setPreview(null); mutation.clearStatus(); setItems(null); setAttempt(n => n + 1); } }}>{m.confirm}</button></div></dialog>}
  </>;
}

function MaterialChecks({ locale, value, change }: { locale: Locale; value: MaterialType[]; change: (value: MaterialType[]) => void }) {
  const m = messages[locale];
  return <fieldset className="check-group"><legend>{m.formsAdmin.materialScope}</legend>{materialTypes.map(type => <label className="check" key={type}><input type="checkbox" checked={value.includes(type)} onChange={() => change(value.includes(type) ? value.filter(t => t !== type) : [...value, type])} />{m.types[type]}</label>)}</fieldset>;
}
function Bilingual({ locale, legend, value, change }: { locale: Locale; legend: string; value?: Field["label"]; change: (value: Field["label"]) => void }) {
  const t = messages[locale].formsAdmin;
  return <fieldset className="check-group bilingual"><legend>{legend}</legend>{(["ar", "en"] as const).map(lang => <label key={lang}>{lang === "ar" ? t.arabic : t.english}<input lang={lang} dir={lang === "ar" ? "rtl" : "ltr"} maxLength={200} value={value?.[lang] ?? ""} onChange={e => change({ ar: value?.ar ?? "", en: value?.en ?? "", [lang]: e.target.value })} /></label>)}</fieldset>;
}
function FieldEditor({ locale, field, index, fields, change, remove, move }: { locale: Locale; field: Field; index: number; fields: Field[]; change: (field: Field) => void; remove: () => void; move: (delta: number) => void }) {
  const m = messages[locale], t = m.formsAdmin;
  const set = <K extends keyof Field>(key: K, value: Field[K]) => { const next = { ...field, [key]: value }; if (value === undefined) delete next[key]; change(next); };
  const v = field.validation ?? {}, options = v.options ?? [];
  const rule = <K extends keyof NonNullable<Field["validation"]>>(key: K, value: NonNullable<Field["validation"]>[K]) => { const next = { ...v, [key]: value }; if (value === undefined) delete next[key]; set("validation", next); };
  const numeric = (key: "min_length" | "max_length" | "min" | "max" | "min_items" | "max_items" | "max_size_bytes") => <label key={key}>{t.rules[key]}<input type="number" step={field.type === "number" ? "any" : "1"} value={v[key] ?? ""} onChange={e => rule(key, e.target.value === "" ? undefined : e.target.valueAsNumber)} /></label>;
  const select = field.type === "select" || field.type === "multi_select";
  return <fieldset className="form-field-editor" data-testid="field-editor"><legend>{t.field} {index + 1}</legend>
    <div className="rule-row"><label>{t.key}<input aria-label={t.key} aria-describedby={`form-key-help-${index}`} dir="ltr" maxLength={64} value={field.key} onChange={e => set("key", e.target.value)} /><small id={`form-key-help-${index}`} className="muted">{t.keyHelp}</small></label>
      <label>{t.type}<select aria-label={t.type} aria-describedby={`form-type-help-${index}`} value={field.type} onChange={e => { const type = e.target.value as Field["type"], next = { ...field, type, validation: newField(type, field.key).validation }; delete next.default; if (!["select", "multi_select", "attachment"].includes(next.type)) delete next.validation; change(next); }}>{fieldTypes.map(type => <option key={type} value={type} disabled={type === "location"}>{t.types[type]}</option>)}</select><small id={`form-type-help-${index}`} className="muted">{t.typeHelp}</small></label></div>
    <Bilingual locale={locale} legend={t.label} value={field.label} change={v => set("label", v)} />
    <Bilingual locale={locale} legend={t.help} value={field.help} change={v => set("help", !v.ar && !v.en ? undefined : v)} />
    <div className="actions"><label className="check"><input type="checkbox" checked={field.required} onChange={e => set("required", e.target.checked)} />{t.required}</label><label className="check"><input type="checkbox" checked={field.searchable ?? false} onChange={e => set("searchable", e.target.checked)} />{t.searchable}</label></div>
    <MaterialChecks locale={locale} value={field.material_types ?? []} change={v => set("material_types", v)} />
    <fieldset className="check-group"><legend>{t.condition}</legend><p className="muted">{t.conditionHelp}</p><label>{t.conditionField}<select value={field.condition?.field ?? ""} onChange={e => set("condition", e.target.value ? { field: e.target.value, equals: "" } : undefined)}><option value="">{t.always}</option>{fields.filter(f => f.key !== field.key).map((f, i) => <option key={i} value={f.key}>{f.label[locale] || f.key}</option>)}</select></label>
      {field.condition && <><label>{t.valueType}<select value={typeof field.condition.equals} onChange={e => set("condition", { ...field.condition!, equals: e.target.value === "boolean" ? true : e.target.value === "number" ? 0 : "" })}>{(["string", "number", "boolean"] as const).map(type => <option key={type} value={type}>{t.valueTypes[type]}</option>)}</select></label>
        <label>{t.equals}{typeof field.condition.equals === "boolean" ? <select value={String(field.condition.equals)} onChange={e => set("condition", { ...field.condition!, equals: e.target.value === "true" })}><option value="true">{m.yes}</option><option value="false">{m.no}</option></select> : <input type={typeof field.condition.equals === "number" ? "number" : "text"} value={field.condition.equals} onChange={e => set("condition", { ...field.condition!, equals: typeof field.condition!.equals === "number" ? e.target.valueAsNumber : e.target.value })} />}</label></>}
    </fieldset>
    <fieldset className="check-group"><legend>{t.validation}</legend><div className="rule-row">
      {["short_text", "long_text"].includes(field.type) && <>{numeric("min_length")}{numeric("max_length")}<label>{t.pattern}<input dir="ltr" maxLength={500} value={v.pattern ?? ""} onChange={e => rule("pattern", e.target.value || undefined)} /></label></>}
      {field.type === "number" && <>{numeric("min")}{numeric("max")}</>}
      {["multi_select", "attachment"].includes(field.type) && <>{numeric("min_items")}{numeric("max_items")}</>}
      {field.type === "attachment" && <><label>{t.accept}<input dir="ltr" value={v.accept?.join(",") ?? ""} onChange={e => rule("accept", e.target.value.split(",").map(s => s.trim()))} /></label>{numeric("max_size_bytes")}</>}
      {field.type === "datetime" && (["not_before", "not_after"] as const).map(key => <label key={key}>{t.rules[key]}<input dir="ltr" value={v[key] ?? ""} onChange={e => rule(key, e.target.value || undefined)} /><small className="muted">{t.dateHelp}</small></label>)}
    </div>{select && <>{options.map((option, i) => <fieldset className="form-option" key={i}><legend>{t.option} {i + 1}</legend><label>{t.optionValue}<input dir="ltr" maxLength={64} value={option.value} onChange={e => rule("options", options.map((o, n) => n === i ? { ...o, value: e.target.value } : o))} /></label><Bilingual locale={locale} legend={t.label} value={option.label} change={label => rule("options", options.map((o, n) => n === i ? { ...o, label } : o))} /><button className="secondary" onClick={() => rule("options", options.filter((_, n) => n !== i))}>{t.removeOption}</button></fieldset>)}<button className="secondary" disabled={options.length >= 200} onClick={() => rule("options", [...options, { value: `option_${options.length + 1}`, label: { ar: "", en: "" } }])}>{t.addOption}</button></>}
    </fieldset>
    <DefaultValue locale={locale} field={field} change={value => set("default", value)} />
    <div className="actions"><button className="secondary" disabled={index === 0} onClick={() => move(-1)}>{t.up}</button><button className="secondary" disabled={index === fields.length - 1} onClick={() => move(1)}>{t.down}</button><button className="secondary danger-link" onClick={remove}>{t.removeField}</button></div>
  </fieldset>;
}
function DefaultValue({ locale, field, change }: { locale: Locale; field: Field; change: (value: Field["default"]) => void }) {
  const m = messages[locale], t = m.formsAdmin, value = field.default;
  if (field.type === "location" || field.type === "attachment") return value === undefined ? null : <button className="secondary" onClick={() => change(undefined)}>{t.clearDefault}</button>;
  return <fieldset className="check-group"><legend>{t.default}</legend>
    {field.type === "boolean" ? <label>{t.defaultValue}<select value={typeof value === "boolean" ? String(value) : ""} onChange={e => change(e.target.value === "" ? undefined : e.target.value === "true")}><option value="">{t.noDefault}</option><option value="true">{m.yes}</option><option value="false">{m.no}</option></select></label>
      : field.type === "select" || field.type === "multi_select" ? <label>{t.defaultValue}<select multiple={field.type === "multi_select"} value={field.type === "multi_select" ? Array.isArray(value) ? value.map(String) : [] : typeof value === "string" ? value : ""} onChange={e => change(field.type === "multi_select" ? Array.from(e.target.selectedOptions).map(o => o.value) : e.target.value || undefined)}>{field.type === "select" && <option value="">{t.noDefault}</option>}{field.validation?.options?.map((o, i) => <option key={i} value={o.value}>{o.label[locale]}</option>)}</select></label>
        : <label>{t.defaultValue}<input dir={field.type === "staff_member" || field.type === "datetime" ? "ltr" : undefined} type={field.type === "number" ? "number" : "text"} step="any" value={typeof value === "string" || typeof value === "number" ? value : ""} onChange={e => change(e.target.value === "" ? undefined : field.type === "number" ? e.target.valueAsNumber : e.target.value)} />{field.type === "datetime" && <small className="muted">{t.dateHelp}</small>}</label>}
    <button className="secondary" onClick={() => change(undefined)}>{t.clearDefault}</button>
  </fieldset>;
}
