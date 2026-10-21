"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { browserApi, dataOrThrow } from "@/lib/browser-api";
import { formatDate, messages, type Locale } from "@/lib/i18n";
import type { Form, Material, MaterialType, Values } from "@/lib/types";
import { materialTypes, states } from "@/lib/query";
import { hasRole } from "@/lib/review";
import { acceptedFile, cameraExtensions, fileKey, uploadRoles } from "@/lib/upload-policy";
import { BffError, createMaterial, startUpload, type UploadControl, type UploadUpdate } from "@/lib/desktop-upload";
import { clearUploads, forgetUpload, findUpload, pendingUploads, recordKey, type PendingUpload } from "@/lib/upload-store";
import { useUser } from "./session-boundary";
import { DynamicForm } from "./dynamic-form";

type Row = { key: string; record: string; name: string; materialId: string; update: UploadUpdate; control?: UploadControl };
type Base = { title: string; type: MaterialType; governorate: string; city: string; shot_at: string; priority: Material["priority"]; minors: boolean; injured: boolean; graphic: boolean; mode: Material["display_name"]["mode"]; pseudonym: string };
const initial: Base = { title: "", type: "raw_footage", governorate: "", city: "", shot_at: "", priority: "normal", minors: false, injured: false, graphic: false, mode: "network", pseudonym: "" };
const fill = (text: string, name: string) => text.replace("{name}", name);
const percent = (value: number, total: number) => total ? Math.floor((value / total) * 100) : 0;

export function DesktopUpload({ locale }: { locale: Locale }) {
  const m = messages[locale], u = m.upload, me = useUser(), reporter = hasRole(me, ...uploadRoles);
  const [files, setFiles] = useState<File[]>([]), [rejected, setRejected] = useState<string[]>([]), [rows, setRows] = useState<Row[]>([]), [pending, setPending] = useState<PendingUpload[]>([]);
  const [base, setBase] = useState<Base>(initial), [schema, setSchema] = useState<Form | null>(null), [formError, setFormError] = useState(false), [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false), [failure, setFailure] = useState<"invalid" | "create" | "files" | null>(null);
  // مفتاح عدم التكرار لإنشاء المادة يبقى في الذاكرة لإعادة المحاولة نفسها، ويتجدد مع كل مادة جديدة.
  const createKey = useRef(crypto.randomUUID()), controls = useRef(new Map<string, UploadControl>());
  const active = rows.some(row => ["hashing", "creating", "uploading", "paused"].includes(row.update.phase));

  useEffect(() => { void pendingUploads().then(setPending); }, [rows.length]);
  useEffect(() => {
    // الخروج أو الإبطال: يتوقف كل رفع جارٍ ويُمسح ما حُفظ للاستئناف.
    const running = controls.current;
    const stop = () => { for (const control of running.values()) control.cancel(); running.clear(); clearUploads(); };
    window.addEventListener("clear-private-state", stop);
    // مغادرة الصفحة داخل التطبيق توقف النقل وتبقي سجل الاستئناف.
    return () => { window.removeEventListener("clear-private-state", stop); for (const control of running.values()) control.stop(); };
  }, []);
  useEffect(() => {
    if (!active) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = u.leaveWarning; };
    window.addEventListener("beforeunload", warn); return () => window.removeEventListener("beforeunload", warn);
  }, [active, u.leaveWarning]);
  useEffect(() => {
    if (!reporter) return;
    const controller = new AbortController();
    void browserApi().GET("/forms/current", { params: { query: { material_type: base.type } }, signal: controller.signal }).then(dataOrThrow)
      .then(data => { if (!controller.signal.aborted) { setSchema(data); setFormError(false); } }).catch(() => { if (!controller.signal.aborted) setFormError(true); });
    return () => controller.abort();
  }, [base.type, attempt, reporter]);

  async function launch(file: File, materialId: string) {
    const key = fileKey(file), record = await recordKey(key);
    if (controls.current.has(key)) return;
    const report = (update: UploadUpdate) => setRows(current => current.map(row => row.key === key ? { ...row, update } : row));
    setRows(current => [...current.filter(row => row.key !== key), { key, record, name: file.name, materialId, update: { phase: "hashing", hashed: 0, sent: 0, total: file.size, resumed: false } }]);
    const control = startUpload(file, materialId, report);
    controls.current.set(key, control);
    setRows(current => current.map(row => row.key === key ? { ...row, control } : row));
    void control.done.finally(() => { controls.current.delete(key); void pendingUploads().then(setPending); });
  }

  async function choose(list: FileList | null) {
    const chosen = Array.from(list ?? []), fresh: File[] = [];
    setRejected(chosen.filter(file => !acceptedFile(file.name)).map(file => file.name)); setFailure(null);
    for (const file of chosen.filter(file => acceptedFile(file.name))) {
      // ملف سبق رفع جزء منه: يُستأنف مباشرة لمادته، بلا نموذج جديد.
      const known = await findUpload(await recordKey(fileKey(file)));
      if (known) void launch(file, known.material_id); else fresh.push(file);
    }
    setFiles(fresh);
  }

  async function submit(dynamic: Values) {
    if (!files.length) { setFailure("files"); return; }
    const title = base.title.trim();
    if (Array.from(title).length < 5 || Array.from(title).length > 80 || !base.governorate.trim() || !base.city.trim() || (base.mode === "pseudonym" && !base.pseudonym.trim())) { setFailure("invalid"); return; }
    setBusy(true); setFailure(null);
    try {
      const material = await createMaterial<Material>({
        title, material_types: [base.type], governorate: base.governorate.trim(), city: base.city.trim(), ...(base.shot_at ? { shot_at: new Date(base.shot_at).toISOString() } : {}),
        priority: base.priority, sensitivity: { minors: base.minors, injured: base.injured, graphic: base.graphic },
        display_name: base.mode === "pseudonym" ? { mode: "pseudonym", pseudonym: base.pseudonym.trim() } : { mode: base.mode },
        form_version: schema!.version, dynamic_fields: dynamic,
      }, createKey.current);
      for (const file of files) void launch(file, material.id);
      createKey.current = crypto.randomUUID(); setFiles([]); setBase(initial);
    } catch (error) { setFailure(error instanceof BffError && error.status === 422 ? "invalid" : "create"); }
    finally { setBusy(false); }
  }

  if (!reporter) return <><Heading locale={locale} /><p className="notice">{u.reporterOnly}</p></>;
  const set = <K extends keyof Base>(key: K, value: Base[K]) => setBase(current => ({ ...current, [key]: value }));
  return <><Heading locale={locale} />
    <section className="card form-card upload-files"><h2>{u.files}</h2>
      <label>{u.choose}<input type="file" multiple accept={cameraExtensions.join(",")} aria-describedby="upload-files-help" onChange={e => { void choose(e.target.files); e.target.value = ""; }} /></label>
      <small className="muted" id="upload-files-help">{u.filesHelp}</small>
      {rejected.map(name => <p key={name} className="notice error" role="alert">{fill(u.unsupported, name)}</p>)}
      {files.length > 0 && <ul className="upload-selection">{files.map(file => <li key={fileKey(file)} dir="auto">{file.name} <small className="muted" dir="ltr">{bytes(file.size, locale)}</small></li>)}</ul>}
      {pending.filter(item => !rows.some(row => row.record === item.key)).length > 0 && <div className="upload-pending"><h3>{u.pending}</h3><p className="muted">{u.pendingHelp}</p><ul>{pending.filter(item => !rows.some(row => row.record === item.key)).map(item => <li key={item.key} data-testid="pending-upload"><span dir="ltr">{bytes(item.create.size_bytes, locale)}</span> <small className="muted">{formatDate(new Date(item.updated_at).toISOString(), locale)}</small><button className="quiet" onClick={() => void forgetUpload(item.key).then(pendingUploads).then(setPending)}>{u.forget}</button></li>)}</ul></div>}
    </section>
    {rows.length > 0 && <section className="card upload-rows" aria-live="polite">{rows.map(row => <UploadRow key={row.key} row={row} locale={locale} />)}</section>}
    {files.length > 0 && <section className="card form-card"><h2>{u.material}</h2>
      {formError ? <div role="alert"><p>{m.formMissing}</p><button onClick={() => setAttempt(n => n + 1)}>{m.retry}</button></div> : !schema ? <p role="status">{m.loading}</p> :
        <DynamicForm key={`${base.type}-${schema.version}`} schema={schema} type={base.type} permissions={me.permissions} locale={locale} onSubmit={dynamic => void submit(dynamic)} submitLabel={busy ? u.creating : u.start} disabled={busy}>
          <div className="upload-base">
            <label>{u.titleLabel}<input value={base.title} maxLength={80} required onChange={e => set("title", e.target.value)} /></label>
            <label>{u.types}<select value={base.type} onChange={e => set("type", e.target.value as MaterialType)}>{materialTypes.map(type => <option key={type} value={type}>{m.types[type]}</option>)}</select></label>
            <label>{m.governorate}<input value={base.governorate} maxLength={64} required onChange={e => set("governorate", e.target.value)} /></label>
            <label>{u.city}<input value={base.city} maxLength={64} required onChange={e => set("city", e.target.value)} /></label>
            <label>{u.shotAt}<input type="datetime-local" value={base.shot_at} onChange={e => set("shot_at", e.target.value)} /></label>
            <label>{u.priority}<select value={base.priority} onChange={e => set("priority", e.target.value as Base["priority"])}>{states.priority.map(p => <option key={p} value={p}>{m.states.priority[p]}</option>)}</select></label>
            <fieldset><legend>{u.sensitivity}</legend>{(["minors", "injured", "graphic"] as const).map(flag => <label key={flag} className="check"><input type="checkbox" checked={base[flag]} onChange={e => set(flag, e.target.checked)} />{u[flag]}</label>)}</fieldset>
            <label>{u.displayName}<select value={base.mode} onChange={e => set("mode", e.target.value as Base["mode"])}>{(["network", "pseudonym", "real_name"] as const).map(mode => <option key={mode} value={mode}>{u.displayModes[mode]}</option>)}</select></label>
            {base.mode === "pseudonym" && <label>{u.pseudonym}<input value={base.pseudonym} maxLength={80} onChange={e => set("pseudonym", e.target.value)} /></label>}
          </div>
        </DynamicForm>}
      {failure && <p className="notice error" role="alert">{failure === "invalid" ? u.invalid : failure === "files" ? u.noFiles : u.createFailed}</p>}
    </section>}
  </>;
}

function Heading({ locale }: { locale: Locale }) {
  const u = messages[locale].upload;
  return <div className="page-heading"><div><p className="eyebrow">{u.nav}</p><h1>{u.title}</h1><p className="muted">{u.lead}</p></div></div>;
}

function UploadRow({ row, locale }: { row: Row; locale: Locale }) {
  const m = messages[locale], u = m.upload, { update, control } = row;
  const value = update.phase === "hashing" ? update.hashed : update.sent;
  return <article className={`upload-row ${update.phase}`} data-testid="upload-row" data-phase={update.phase}>
    <div className="upload-row-head"><strong dir="auto">{row.name}</strong><span className={`badge ${update.phase === "done" ? "good" : update.phase === "failed" ? "bad" : ""}`}>{u.phase[update.phase]}</span>{update.resumed && <span className="badge">{u.resumed}</span>}</div>
    {["hashing", "uploading", "paused"].includes(update.phase) && <><progress max={update.total} value={value} aria-label={fill(u.progress, row.name)} /><small className="muted" dir="ltr">{percent(value, update.total)}% · {bytes(value, locale)} / {bytes(update.total, locale)}</small></>}
    {update.failure && <p className="notice error" role="alert">{u.failure[update.failure]}</p>}
    {update.session?.receipt_number && <p>{u.receipt}: <span dir="ltr" data-testid="upload-receipt">{update.session.receipt_number}</span></p>}
    <div className="actions">
      {update.phase === "uploading" && <button className="secondary" onClick={() => control?.pause()}>{u.pause}</button>}
      {update.phase === "paused" && <button onClick={() => control?.resume()}>{u.resume}</button>}
      {["hashing", "creating", "uploading", "paused"].includes(update.phase) && <button className="quiet" onClick={() => control?.cancel()}>{u.cancel}</button>}
      {["processing", "done"].includes(update.phase) && <Link prefetch={false} href={`/${locale}/materials/${row.materialId}`}>{u.open}</Link>}
    </div>
  </article>;
}

function bytes(value: number, locale: Locale) {
  const units = ["B", "KB", "MB", "GB", "TB"]; let index = 0, size = value;
  while (size >= 1024 && index < units.length - 1) { size /= 1024; index++; }
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(size)} ${units[index]}`;
}
