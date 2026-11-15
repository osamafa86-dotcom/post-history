"use client";
import { useEffect, useRef, useState } from "react";
import { browserApi } from "@/lib/browser-api";
import { formatDate, messages, type Locale } from "@/lib/i18n";
import type { Material, MaterialType, TransitionRecord } from "@/lib/types";
import { timecode } from "@/lib/editor";
import { materialTypes } from "@/lib/query";
import { answerMin, changedFields, changeRequest, editableStates, editErrors, type EditField } from "@/lib/material-edit";
import { lacksOriginal } from "@/lib/my-materials";
import { acceptedFile, cameraExtensions, fileKey } from "@/lib/upload-policy";
import { startUpload, type UploadControl } from "@/lib/desktop-upload";
import { recordKey } from "@/lib/upload-store";
import { useMutation } from "@/lib/use-mutation";
import { ActionStatus } from "./action-status";
import { UploadRow, type Row } from "./desktop-upload";
import { Icon } from "./icon";

type Props = { locale: Locale; material: Material; tag: string | null; records: TransitionRecord[] | null; editing: () => void; release: () => void; reload: () => void; notify: (label: string) => void };

/**
 * ما يفعله صاحب المادة من صفحتها (قرار المنسّق 2026-11-15): ملاحظة المشرف أعلى الصفحة حين يُطلب تعديل مع «أعد الإرسال للمراجعة» بحوار
 * مبسّط، ورفع الملف لمادة لم يصل أصلها أو فشل رفعه (فلا تبقى مادة بلا ملف بلا طريق لإكمالها)، وتعديل حقولها الوصفية ما دامت قبل القبول.
 */
export function OwnerPanel({ locale, material, tag, records, editing, release, reload, notify }: Props) {
  const m = messages[locale], o = m.owner, [dialog, setDialog] = useState<"resubmit" | "edit" | null>(null), [uploading, setUploading] = useState(false);
  // الرفع الجاري يبقي لوحته حتى ينتهي: تحديث المادة في أثنائه (وصول ملفها قبل التحقق) لا يزيلها فيوقف النقل.
  const changes = material.editorial_state === "needs_changes", note = changes ? changeRequest(records) : null, missing = lacksOriginal(material) || uploading;
  const mayEdit = (editableStates as readonly string[]).includes(material.editorial_state);
  if (!changes && !missing && !mayEdit) return null;
  const open = (which: "resubmit" | "edit") => { editing(); setDialog(which); }, close = () => { setDialog(null); release(); };
  const edit = mayEdit && <button type="button" className="secondary" disabled={!tag} onClick={() => open("edit")}>{o.edit}</button>;
  return <section className="owner-panel" data-testid="owner-panel" aria-label={o.title}>
    {changes && <div className="owner-notice warn" role="status" data-testid="owner-changes"><h2><Icon name="alert" size={18} />{o.changesTitle}</h2>
      {note?.reason && <blockquote className="supervisor-note" data-testid="owner-note"><p><bdi dir="auto">{note.reason}</bdi></p><footer>{note.note_timecode_ms != null && <span>{m.mine.at} <bdi dir="ltr">{timecode(note.note_timecode_ms)}</bdi> · </span>}{formatDate(note.occurred_at, locale)}</footer></blockquote>}
      <div className="actions"><button type="button" disabled={!tag} onClick={() => open("resubmit")}>{o.resubmit}</button>{edit}</div></div>}
    {missing && <OwnerUpload key={`${material.id}:upload`} locale={locale} material={material} tag={tag} editing={editing} reload={reload} active={setUploading} />}
    {!changes && edit && <div className="actions owner-edit">{edit}</div>}
    {dialog === "resubmit" && <ResubmitDialog locale={locale} material={material} tag={tag} onClose={close} onDone={() => { setDialog(null); notify(m.states.editorial_state.reviewing); reload(); }} />}
    {dialog === "edit" && <EditDialog locale={locale} material={material} tag={tag} onClose={close} onDone={() => { setDialog(null); reload(); }} />}
  </section>;
}

/** الحوار المبسّط: حقل واحد «ماذا عدّلت؟» والهدف مُسبق (`needs_changes → reviewing`)، لا اختيار حالة ولا لغة حجز. */
function ResubmitDialog({ locale, material, tag, onClose, onDone }: { locale: Locale; material: Material; tag: string | null; onClose: () => void; onDone: () => void }) {
  const m = messages[locale], o = m.owner, mutation = useMutation(), dialog = useRef<HTMLDialogElement>(null), [answer, setAnswer] = useState("");
  useEffect(() => { if (dialog.current && !dialog.current.open) dialog.current.showModal(); }, []);
  const short = answer.trim().length < answerMin, close = () => { dialog.current?.close(); onClose(); };
  async function submit() {
    if (short || !tag) return;
    const body = { track: "editorial" as const, to: "reviewing", reason: answer.trim() };
    if (await mutation.run(JSON.stringify([material.id, tag, body]), header => browserApi().POST("/materials/{id}/transitions", { params: { path: { id: material.id }, header: { ...header, "If-Match": tag } }, body }))) { dialog.current?.close(); onDone(); }
  }
  return <dialog ref={dialog} className="modal owner-dialog" aria-labelledby="resubmit-title" onCancel={e => { e.preventDefault(); close(); }}>
    <form noValidate onSubmit={e => { e.preventDefault(); void submit(); }}>
      <h2 id="resubmit-title">{o.resubmit}</h2><p className="muted">{o.resubmitLead}</p>
      <label>{o.whatChanged}<textarea required minLength={answerMin} maxLength={2000} value={answer} aria-describedby="resubmit-help resubmit-min" onChange={e => setAnswer(e.target.value)} /></label>
      <p id="resubmit-help" className="muted">{o.whatChangedHelp}</p>
      <p id="resubmit-min" className={answer && short ? "field-hint error" : "field-hint"} role="status">{short ? o.minChars : ""}</p>
      {mutation.status === 412 ? <div className="notice error" role="alert"><p>{m.review.changed}</p></div> : <ActionStatus status={mutation.status} locale={locale} />}
      <div className="actions"><button type="button" className="secondary" disabled={mutation.busy} onClick={close}>{m.cancel}</button><button disabled={short || !tag || mutation.busy}>{o.send}</button></div>
    </form>
  </dialog>;
}

/** تعديل الحقول الوصفية: العنوان والمحافظة والمدينة والأنواع. يُرسل ما تغيّر وحده بـ`If-Match`؛ الحالات والملف لا يُمسّان. */
function EditDialog({ locale, material, tag, onClose, onDone }: { locale: Locale; material: Material; tag: string | null; onClose: () => void; onDone: () => void }) {
  const m = messages[locale], o = m.owner, u = m.upload, mutation = useMutation(), dialog = useRef<HTMLDialogElement>(null);
  const [draft, setDraft] = useState({ title: material.title, governorate: material.governorate, city: material.city, material_types: [...material.material_types] as MaterialType[] }), [tried, setTried] = useState(false);
  useEffect(() => { if (dialog.current && !dialog.current.open) dialog.current.showModal(); }, []);
  const wrong = tried ? editErrors(draft) : [], invalid = (field: EditField) => wrong.includes(field), changed = changedFields(material, draft);
  const close = () => { dialog.current?.close(); onClose(); };
  const error = (field: EditField, text: string) => <span className="field-error" id={`edit-${field}-error`}>{invalid(field) && text}</span>;
  const marks = (field: EditField) => ({ "aria-invalid": invalid(field), "aria-describedby": `edit-${field}-error` });
  async function submit() {
    setTried(true);
    if (editErrors(draft).length) { dialog.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus(); return; }
    if (!changed || !tag) return;
    if (await mutation.run(JSON.stringify([material.id, tag, changed]), header => browserApi().PATCH("/materials/{id}", { params: { path: { id: material.id }, header: { ...header, "If-Match": tag } }, body: changed }))) { dialog.current?.close(); onDone(); }
  }
  return <dialog ref={dialog} className="modal owner-dialog" aria-labelledby="edit-title" onCancel={e => { e.preventDefault(); close(); }}>
    <form noValidate onSubmit={e => { e.preventDefault(); void submit(); }}>
      <h2 id="edit-title">{o.edit}</h2><p className="muted">{o.editLead}</p>
      <div className="upload-field"><label>{u.titleLabel}<input value={draft.title} maxLength={80} required {...marks("title")} onChange={e => setDraft(d => ({ ...d, title: e.target.value }))} /></label>{error("title", u.errors.title)}</div>
      <div className="upload-field"><label>{m.governorate}<input value={draft.governorate} maxLength={64} required list="edit-governorates" {...marks("governorate")} onChange={e => setDraft(d => ({ ...d, governorate: e.target.value }))} /></label>{error("governorate", u.errors.governorate)}
        <datalist id="edit-governorates">{Object.entries(m.governorates).map(([name, shown]) => <option key={name} value={name}>{shown === name ? undefined : shown}</option>)}</datalist></div>
      <div className="upload-field"><label>{u.city}<input value={draft.city} maxLength={64} required {...marks("city")} onChange={e => setDraft(d => ({ ...d, city: e.target.value }))} /></label>{error("city", u.errors.city)}</div>
      <fieldset className="upload-types" aria-describedby="edit-material_types-error"><legend>{u.types}</legend>
        <div className="chip-row">{materialTypes.map(type => { const on = draft.material_types.includes(type);
          return <button key={type} type="button" className="chip" aria-pressed={on} onClick={() => setDraft(d => ({ ...d, material_types: on ? d.material_types.filter(other => other !== type) : [...d.material_types, type] }))}>{m.types[type]}</button>; })}</div>
        {error("material_types", u.need.type)}</fieldset>
      {mutation.status === 412 ? <div className="notice error" role="alert"><p>{m.review.changed}</p></div> : <ActionStatus status={mutation.status} locale={locale} />}
      <div className="actions"><button type="button" className="secondary" disabled={mutation.busy} onClick={close}>{m.cancel}</button><button disabled={!changed || !tag || mutation.busy}>{o.save}</button></div>
    </form>
  </dialog>;
}

/**
 * رفع الملف لهذه المادة نفسها بمسار الرفع من الحاسوب (`startUpload`)، فلا تُنشأ مادة ثانية. المادة التي فشل رفعها يُعاد مسارها الفني
 * إلى الانتظار أولًا (انتقال صاحبها `failed → pending`)، لأن الخادم لا يقبل أصلًا لمسار فاشل.
 */
function OwnerUpload({ locale, material, tag, editing, reload, active }: { locale: Locale; material: Material; tag: string | null; editing: () => void; reload: () => void; active: (on: boolean) => void }) {
  const m = messages[locale], o = m.owner, u = m.upload, retry = useMutation(), picker = useRef<HTMLInputElement>(null), control = useRef<UploadControl | null>(null);
  const [row, setRow] = useState<Row | null>(null), [rejected, setRejected] = useState(""), [online, setOnline] = useState(true), failed = material.technical_state === "failed";
  useEffect(() => { const sync = () => setOnline(navigator.onLine); sync(); window.addEventListener("online", sync); window.addEventListener("offline", sync); return () => { window.removeEventListener("online", sync); window.removeEventListener("offline", sync); }; }, []);
  // مغادرة الصفحة توقف النقل وتبقي سجل الاستئناف، كما في صفحة الرفع.
  useEffect(() => () => control.current?.stop(), []);
  async function choose(list: FileList | null) {
    const file = list?.[0];
    if (!file) return;
    if (!acceptedFile(file.name)) { setRejected(file.name); return; }
    setRejected(""); editing();
    if (failed && tag && !await retry.run(`${material.id}:retry:${tag}`, header => browserApi().POST("/materials/{id}/transitions", { params: { path: { id: material.id }, header: { ...header, "If-Match": tag } }, body: { track: "technical", to: "pending", reason: o.retryReason } }))) return;
    const key = fileKey(file), record = await recordKey(key);
    active(true); setRow({ key, record, name: file.name, materialId: material.id, update: { phase: "hashing", hashed: 0, sent: 0, total: file.size, resumed: false } });
    const started = startUpload(file, material.id, update => setRow(current => current && { ...current, update, verifiedAt: current.verifiedAt ?? (update.phase === "done" ? Date.now() : undefined) }));
    control.current = started; setRow(current => current && { ...current, control: started });
    void started.done.then(update => { control.current = null; if (update.phase === "done") { reload(); active(false); } });
  }
  const busy = !!row && ["hashing", "creating", "uploading", "paused", "processing"].includes(row.update.phase);
  return <div className={`owner-notice ${failed ? "danger" : "warn"}`} data-testid="owner-upload"><h2><Icon name="upload" size={18} />{failed ? o.failedTitle : o.noFileTitle}</h2><p>{failed ? o.failedBody : o.noFileBody}</p>
    <input ref={picker} className="visually-hidden" type="file" tabIndex={-1} aria-hidden="true" accept={cameraExtensions.join(",")} data-testid="owner-file" onChange={e => { void choose(e.target.files); e.target.value = ""; }} />
    {rejected && <p className="notice error" role="alert">{u.unsupported.replace("{name}", rejected)}</p>}
    <ActionStatus status={retry.status === 200 ? 0 : retry.status} locale={locale} />
    {row ? <div aria-live="polite"><UploadRow row={row} online={online} locale={locale} pick={() => picker.current?.click()} /></div> : null}
    {!busy && row?.update.phase !== "done" && <div className="actions"><button type="button" disabled={retry.busy || (failed && !tag)} onClick={() => picker.current?.click()}>{o.uploadHere}</button></div>}
  </div>;
}
