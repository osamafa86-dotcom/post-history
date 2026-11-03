"use client";
import { NoAccess } from "./empty-state";
import { useEffect, useRef, useState } from "react";
import { browserApi, dataOrThrow } from "@/lib/browser-api";
import { fieldTypes, formBodyLimit, formReaders, formWriters, newField, nextForm, publishBody, storeBlocked, urgentLocked, validForm, withToggles, type FormSummary } from "@/lib/form-admin";
import { formatDate, messages, type Locale } from "@/lib/i18n";
import { materialTypes } from "@/lib/query";
import { hasRole } from "@/lib/review";
import type { Field, Form, MaterialType } from "@/lib/types";
import { useMutation } from "@/lib/use-mutation";
import { ActionStatus } from "./action-status";
import { DynamicForm } from "./dynamic-form";
import { ConfirmDialog } from "./admin-parts";
import { Icon, type IconName } from "./icon";
import { fill } from "@/lib/admin-text";
import { useUser } from "./session-boundary";

const typeIcons: Record<Field["type"], IconName> = { short_text: "text", long_text: "pencil", number: "hash", select: "check", multi_select: "list", datetime: "calendar", location: "pin", boolean: "toggle", staff_member: "user", attachment: "clip" };
/** حقول العقد في إرسالة المراسل (`MaterialCreate`): تُعرض ثابتة لا تُحذف ولا تُعدَّل من هنا؛ نصّها في تطبيق المراسل. */
const coreFields = [
  { key: "title", icon: "text", required: true }, { key: "material_types", icon: "list", required: true }, { key: "tags", icon: "tag", required: true },
  { key: "location", icon: "pin", required: true, encrypted: true }, { key: "shot_at", icon: "clock", required: false }, { key: "priority", icon: "bolt", required: true },
  { key: "sensitivity", icon: "alert", required: true }, { key: "display_name", icon: "user", required: true },
] as const satisfies readonly { key: string; icon: IconName; required: boolean; encrypted?: boolean }[];

/**
 * منشئ النماذج (A3): ثلاث لوحات كما في الإطار، أنواع الحقول ثم الحقول ثم إعدادات الحقل المحدد. حقول العقد ثابتة و«المكان» موسوم
 * «مشفّر»، وحقول النموذج تُضاف من لوحة الأنواع وتُرتَّب بزرّين. الإصدار لقطة كاملة: «نشر الإصدار N» بعد المعاينة وبتأكيد، و`If-Match` من
 * الإصدار السابق، والتغيير يسري على الإرسالات الجديدة وحدها. «يظهر في الإرسال العاجل» و«يُرسل إلى المتجر» ليسا في العقد فلا يُرسمان.
 */
export function FormAdmin({ locale }: { locale: Locale }) {
  const m = messages[locale], t = m.formsAdmin, me = useUser(), allowed = hasRole(me, ...formReaders), writer = hasRole(me, ...formWriters), mutation = useMutation();
  const [items, setItems] = useState<FormSummary[] | null>(null), [current, setCurrent] = useState<Form | null>(null), [selected, setSelected] = useState<Form | null>(null);
  const [attempt, setAttempt] = useState(0), [error, setError] = useState(false), [reading, setReading] = useState(false), sequence = useRef({ value: 0 });
  const [draft, setDraft] = useState<Form | null>(null), [preview, setPreview] = useState<Form | null>(null), [invalid, setInvalid] = useState(false), [oversize, setOversize] = useState(false);
  const [confirm, setConfirm] = useState<"publish" | "discard" | null>(null), [active, setActive] = useState(0);
  const [previewType, setPreviewType] = useState<MaterialType>("report"), [previewLocale, setPreviewLocale] = useState<Locale>(locale);
  useEffect(() => {
    if (!allowed) return;
    const counter = sequence.current, controller = new AbortController(), seq = ++counter.value;
    void Promise.all([browserApi().GET("/forms", { signal: controller.signal }).then(dataOrThrow), browserApi().GET("/forms/current", { signal: controller.signal }).then(result => result.response.status === 404 ? null : dataOrThrow(result))])
      .then(([list, latest]) => { if (!controller.signal.aborted && counter.value === seq) { setItems(list.items); setCurrent(latest); setSelected(latest); setActive(0); setError(false); } })
      .catch(() => { if (!controller.signal.aborted && counter.value === seq) setError(true); });
    return () => { controller.abort(); counter.value++; };
  }, [allowed, attempt]);
  if (!allowed) return <NoAccess locale={locale} me={me} title={t.title} denied={t.denied} />;

  async function select(version: number) {
    const seq = ++sequence.current.value; setReading(true); setError(false);
    try {
      const value = dataOrThrow(await browserApi().GET("/forms/{version}", { params: { path: { version } } }));
      if (sequence.current.value === seq) { setSelected(value); setActive(0); }
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
  function add(type: Field["type"]) {
    if (!draft) return;
    let n = draft.fields.length + 1; while (draft.fields.some(f => f.key === `field_${n}`)) n++;
    edit({ ...draft, fields: [...draft.fields, newField(type, `field_${n}`)] }); setActive(draft.fields.length);
  }
  function move(index: number, delta: number) {
    if (!draft) return;
    const fields = [...draft.fields]; [fields[index], fields[index + delta]] = [fields[index + delta], fields[index]];
    edit({ ...draft, fields }); setActive(index + delta);
  }
  const form = draft ?? selected, shown = draft ? preview : selected, fields = form?.fields ?? [], index = Math.min(active, Math.max(0, fields.length - 1)), field = fields[index];
  const version = draft ? draft.version : selected?.version;
  return <>
    <div className="page-head"><div><h1>{version ? fill(draft ? t.titleDraft : t.titleVersion, { title: t.titleV2, version }) : t.titleV2}</h1><p className="muted">{t.leadV2}</p>{!writer && <p className="notice">{t.readOnly}</p>}</div>
      <div className="page-actions">
        {!draft && writer && items && !error && <button type="button" disabled={reading} onClick={() => { mutation.clearStatus(); edit(nextForm(selected, current?.version ?? 0)); setActive(0); }}>{selected ? t.clone : t.create}</button>}
        {draft && <><button type="button" className={preview ? "secondary" : undefined} disabled={mutation.busy} onClick={review}>{t.preview}</button>
          {preview && <button type="button" disabled={mutation.busy || mutation.status === 409 || mutation.status === 412} onClick={() => setConfirm("publish")}>{fill(t.publishVersion, { version: draft.version })}</button>}
          <button type="button" className="secondary" disabled={mutation.busy} onClick={() => setConfirm("discard")}>{t.discard}</button></>}
      </div></div>
    <ActionStatus status={mutation.status} locale={locale} />
    {(mutation.status === 409 || mutation.status === 412) && <p className="notice">{t.conflictHelp}</p>}
    {error && <p className="notice error" role="alert">{m.error} <button type="button" className="link-button" disabled={!!draft} onClick={() => { setItems(null); setAttempt(n => n + 1); }}>{m.retry}</button></p>}
    {!items && !error && <p role="status" className="muted">{m.loading}</p>}
    {items && !draft && <div className="form-history">{items.length === 0 ? <p className="muted">{t.empty}</p> : <>
      <label className="inline-filter">{t.version}<select value={selected?.version ?? ""} disabled={reading} onChange={e => void select(Number(e.target.value))}>{items.map(item => <option key={item.version} value={item.version}>{item.version}{item.version === current?.version ? ` · ${t.current}` : ""}</option>)}</select></label>
      {selected && <p className="caption">{t.fieldCount}: {selected.fields.length} · {t.publishedAt}: {formatDate(selected.published_at, locale)}</p>}
      {reading && <p role="status" className="caption">{m.loading}</p>}
    </>}</div>}
    {draft && <p className="notice">{t.immutable}</p>}
    {invalid && <p className="notice error" role="alert">{t.invalid}</p>}
    {oversize && <p className="notice error" role="alert">{t.tooLarge}</p>}
    {form && <div className="form-builder">
      <section className="card palette" aria-labelledby="palette-title"><h2 id="palette-title">{t.palette}</h2>
        <ul className="palette-list">{fieldTypes.map(type => <li key={type}><button type="button" className="palette-item" disabled={!draft || mutation.busy || type === "location"} aria-label={fill(t.addType, { type: t.types[type] })} onClick={() => add(type)}><Icon name={typeIcons[type]} size={16} /><span>{t.types[type]}</span></button></li>)}</ul>
        {(draft || writer) && <p className="caption">{draft ? t.v0 : t.paletteHelp}</p>}
      </section>
      <section className="card fields-pane" aria-labelledby="fields-title"><h2 id="fields-title">{t.fieldsTitle}</h2>
        <h3 className="pane-sub"><Icon name="lock" size={14} />{t.contractFields}</h3>
        <ul className="field-rows core">{coreFields.map(core => <li key={core.key} className="field-row core" data-testid="core-field"><span className="field-icon"><Icon name={core.icon} size={16} /></span>
          <span className="field-text"><strong>{t.core[core.key].label}</strong><small className="muted">{t.core[core.key].hint}</small></span>
          <span className="field-badges">{"encrypted" in core && core.encrypted && <span className="badge state ok"><Icon name="lock" size={14} />{t.encrypted}</span>}<RequiredBadge locale={locale} required={core.required} /></span></li>)}</ul>
        <p className="caption">{t.contractNote}</p>
        <h3 className="pane-sub">{t.dynamicFields}</h3>
        {!fields.length ? <p className="empty">{t.noFields}</p> : <ol className="field-rows">{fields.map((item, i) => <li key={i} className={`field-row${i === index ? " selected" : ""}`} data-testid="field-row">
          <button type="button" className="field-select" aria-pressed={i === index} onClick={() => setActive(i)}><span className="field-icon"><Icon name={typeIcons[item.type]} size={16} /></span>
            <span className="field-text"><strong>{item.label[locale] || item.key || fill(t.untitled, { n: i + 1 })}</strong><small className="muted">{t.types[item.type]} · <bdi dir="ltr">{item.key}</bdi></small></span></button>
          <span className="field-badges">{item.searchable && <span className="badge state brand"><Icon name="search" size={14} />{t.searchable}</span>}<ToggleBadges locale={locale} field={item} /><RequiredBadge locale={locale} required={item.required} /></span>
          {draft && <span className="row-buttons"><button type="button" className="icon-button small-icon" disabled={i === 0 || mutation.busy} aria-label={fill(t.moveUpField, { field: item.key })} onClick={() => move(i, -1)}><Icon name="chevron" size={16} /></button><button type="button" className="icon-button small-icon down" disabled={i === fields.length - 1 || mutation.busy} aria-label={fill(t.moveDownField, { field: item.key })} onClick={() => move(i, 1)}><Icon name="chevron" size={16} /></button></span>}
        </li>)}</ol>}
        {draft && <button type="button" className="quiet add-field" disabled={mutation.busy} onClick={() => add("short_text")}><Icon name="plus" size={16} /> {t.addField}</button>}
      </section>
      <section className="card field-settings" aria-labelledby="settings-title"><h2 id="settings-title">{t.settingsTitle}</h2>
        {!field ? <p className="muted">{t.selectField}</p>
          : draft ? <fieldset disabled={mutation.busy} className="form-editor-controls"><FieldEditor key={index} locale={locale} field={field} index={index} fields={draft.fields}
            change={next => edit({ ...draft, fields: draft.fields.map((f, i) => i === index ? next : f) })}
            remove={() => { edit({ ...draft, fields: draft.fields.filter((_, i) => i !== index) }); setActive(Math.max(0, index - 1)); }}
            move={delta => move(index, delta)} /></fieldset>
          : <FieldSummary locale={locale} field={field} />}
        {draft && <MaterialChecks locale={locale} value={draft.material_types ?? []} change={types => edit({ ...draft, material_types: types })} />}
        {draft && <p className="caption">{t.searchHelp}</p>}
      </section>
    </div>}
    {shown && !reading && <section className="card form-admin-preview" aria-label={t.preview}>
      <h2>{t.preview} · {t.version} {shown.version}</h2><p className="muted">{t.previewHelp}</p>
      <div className="rule-row"><label>{t.previewLanguage}<select value={previewLocale} onChange={e => setPreviewLocale(e.target.value as Locale)}><option value="ar">{t.arabic}</option><option value="en">{t.english}</option></select></label>
        <label>{m.materialType}<select value={previewType} onChange={e => setPreviewType(e.target.value as MaterialType)}>{materialTypes.map(type => <option key={type} value={type}>{m.types[type]}</option>)}</select></label></div>
      <div lang={previewLocale} dir={previewLocale === "ar" ? "rtl" : "ltr"}>
        <DynamicForm key={`${JSON.stringify(shown)}:${previewType}:${previewLocale}`} schema={shown} type={previewType} permissions={[]} locale={previewLocale} />
      </div>
    </section>}
    {confirm && <ConfirmDialog locale={locale} testId="form-confirm" title={confirm === "publish" ? fill(t.publishVersion, { version: draft?.version ?? "" }) : t.discard} confirm={m.confirm} busy={mutation.busy} status={0} onCancel={() => setConfirm(null)}
      onConfirm={() => { if (confirm === "publish") void publish(); else { setConfirm(null); setDraft(null); setPreview(null); mutation.clearStatus(); setItems(null); setAttempt(n => n + 1); } }}>
      <p>{confirm === "publish" ? t.publishWarning : t.discardWarning}</p>
    </ConfirmDialog>}
  </>;
}

/** شارتا المفتاحين في صف الحقل: ما خرج من العاجل وما يُرسل إلى المتجر؛ الافتراضيان بلا شارة. */
function ToggleBadges({ locale, field }: { locale: Locale; field: Field }) {
  const t = messages[locale].formsAdmin.toggles;
  return <>{field.show_in_urgent === false && <span className="badge state muted" data-testid="badge-out-of-urgent"><Icon name="bolt" size={14} />{t.outOfUrgent}</span>}
    {field.send_to_store === true && <span className="badge state brand" data-testid="badge-to-store"><Icon name="store" size={14} />{t.storeBadge}</span>}</>;
}

function RequiredBadge({ locale, required }: { locale: Locale; required: boolean }) {
  const t = messages[locale].formsAdmin;
  return required ? <span className="badge state ok"><Icon name="check" size={14} />{t.required}</span> : <span className="badge state muted"><Icon name="clock" size={14} />{t.optional}</span>;
}

/** إعدادات الحقل للقراءة (الإصدار المنشور أو دور القراءة): التسمية باللغتين والنوع والمفتاح والإلزام والشرط. */
function FieldSummary({ locale, field }: { locale: Locale; field: Field }) {
  const m = messages[locale], t = m.formsAdmin;
  const rows: [string, React.ReactNode][] = [[t.label, <>{field.label.ar} · <bdi>{field.label.en}</bdi></>], [t.type, t.types[field.type]], [t.key, <bdi dir="ltr" key="key">{field.key}</bdi>], [t.required, field.required ? m.yes : m.no], [t.searchable, field.searchable ? m.yes : m.no],
    [t.toggles.inUrgent, field.show_in_urgent === false ? m.no : m.yes], [t.toggles.toStore, field.send_to_store === true ? m.yes : m.no]];
  if (field.help) rows.splice(1, 0, [t.help, <>{field.help.ar} · <bdi>{field.help.en}</bdi></>]);
  if (field.condition) rows.push([t.condition, <><bdi dir="ltr">{field.condition.field}</bdi> = <bdi dir="ltr">{String(field.condition.equals)}</bdi></>]);
  return <dl className="metadata field-summary">{rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>;
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
  const set = <K extends keyof Field>(key: K, value: Field[K]) => { const next = { ...field, [key]: value }; if (value === undefined) delete next[key]; change(withToggles(next)); };
  const v = field.validation ?? {}, options = v.options ?? [];
  const rule = <K extends keyof NonNullable<Field["validation"]>>(key: K, value: NonNullable<Field["validation"]>[K]) => { const next = { ...v, [key]: value }; if (value === undefined) delete next[key]; set("validation", next); };
  const numeric = (key: "min_length" | "max_length" | "min" | "max" | "min_items" | "max_items" | "max_size_bytes") => <label key={key}>{t.rules[key]}<input type="number" step={field.type === "number" ? "any" : "1"} value={v[key] ?? ""} onChange={e => rule(key, e.target.value === "" ? undefined : e.target.valueAsNumber)} /></label>;
  const select = field.type === "select" || field.type === "multi_select";
  return <fieldset className="form-field-editor" data-testid="field-editor"><legend>{t.field} {index + 1}</legend>
    <div className="rule-row"><label>{t.key}<input aria-label={t.key} aria-describedby={`form-key-help-${index}`} dir="ltr" maxLength={64} value={field.key} onChange={e => set("key", e.target.value)} /><small id={`form-key-help-${index}`} className="muted">{t.keyHelp}</small></label>
      <label>{t.type}<select aria-label={t.type} aria-describedby={`form-type-help-${index}`} value={field.type} onChange={e => { const type = e.target.value as Field["type"], next = { ...field, type, validation: newField(type, field.key).validation }; delete next.default; if (!["select", "multi_select", "attachment"].includes(next.type)) delete next.validation; change(withToggles(next)); }}>{fieldTypes.map(type => <option key={type} value={type} disabled={type === "location"}>{t.types[type]}</option>)}</select><small id={`form-type-help-${index}`} className="muted">{t.typeHelp}</small></label></div>
    <Bilingual locale={locale} legend={t.label} value={field.label} change={v => set("label", v)} />
    <Bilingual locale={locale} legend={t.help} value={field.help} change={v => set("help", !v.ar && !v.en ? undefined : v)} />
    <div className="actions"><label className="check"><input type="checkbox" checked={field.required} onChange={e => set("required", e.target.checked)} />{t.required}</label><label className="check"><input type="checkbox" checked={field.searchable ?? false} onChange={e => set("searchable", e.target.checked)} />{t.searchable}</label></div>
    <div className="field-toggles" data-testid="field-toggles">
      <label className="check"><input type="checkbox" data-testid="toggle-urgent" checked={field.show_in_urgent !== false} disabled={urgentLocked(field)} aria-describedby={`form-urgent-help-${index}`} onChange={e => set("show_in_urgent", e.target.checked)} />{t.toggles.inUrgent}</label>
      <small id={`form-urgent-help-${index}`} className="muted">{t.toggles.inUrgentHelp}</small>
      <label className="check"><input type="checkbox" data-testid="toggle-store" checked={field.send_to_store === true} disabled={storeBlocked(field)} aria-describedby={`form-store-help-${index}`} onChange={e => set("send_to_store", e.target.checked)} />{t.toggles.toStore}</label>
      <small id={`form-store-help-${index}`} className="muted">{t.toggles.toStoreHelp}</small>
    </div>
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
