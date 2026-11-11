"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { browserApi, dataOrThrow } from "@/lib/browser-api";
import { formatDate, messages, type Locale } from "@/lib/i18n";
import type { Form, Material, MaterialType, Values } from "@/lib/types";
import { materialTypes, states } from "@/lib/query";
import { hasRole } from "@/lib/review";
import { acceptedFile, answerFollowup, answerSensitivity, cameraExtensions, fileKey, noSensitivityAnswer, sensitivityFlagNames, sensitivityFlags, uploadNeed, uploadRoles, type SensitivityAnswers } from "@/lib/upload-policy";
import { abortUpload, BffError, createMaterial, myUploads, startUpload, type SessionView, type UploadControl, type UploadUpdate } from "@/lib/desktop-upload";
import { clearUploads, forgetUpload, findUpload, pendingUploads, recordKey, type PendingUpload } from "@/lib/upload-store";
import { useUser } from "./session-boundary";
import { DynamicForm } from "./dynamic-form";
import { NoAccess } from "./empty-state";
import { Icon, type IconName } from "./icon";
import { TagEntry } from "./tag-entry";
import { numberLocale } from "@/lib/format";

type Row = { key: string; record: string; name: string; materialId: string; update: UploadUpdate; control?: UploadControl; verifiedAt?: number };
type Base = { title: string; types: MaterialType[]; tags: string[]; governorate: string; city: string; shot_at: string; priority: Material["priority"]; sensitivity: SensitivityAnswers; mode: Material["display_name"]["mode"]; pseudonym: string };
// نسخة الإرسال نفسها للمكتب (reporter-v2.md): لا نوع ولا جواب حساسية مسبق، والوسوم إلزامية.
const initial: Base = { title: "", types: [], tags: [], governorate: "", city: "", shot_at: "", priority: "normal", sensitivity: noSensitivityAnswer, mode: "network", pseudonym: "" };
const fill = (text: string, name: string) => text.replace("{name}", name);
const percent = (value: number, total: number) => total ? Math.floor((value / total) * 100) : 0;
/** الحجم بالميغابايت داخل الجملة («وصل 112 من 248 ميغابايت»، web-v2.md U2)، معزول الاتجاه عند العرض. */
export const megabytes = (value: number, locale: Locale) => new Intl.NumberFormat(locale === "ar" ? "ar-u-nu-latn" : "en", { maximumFractionDigits: value < 10 * 1048576 ? 1 : 0 }).format(value / 1048576);
/**
 * مرحلة الواجهة فوق حالة الجلسة (U2: ثماني مراحل فوق ست حالات عقد): الكلمة والأيقونة والنغمة معًا، لا لون وحده.
 * «انقطع الاتصال» مرحلة واجهة فوق `in_progress` حين يغيب الاتصال، و«مكرّر» فوق `deduplicated`.
 */
export function uploadStage(update: UploadUpdate, online = true): { stage: "hashing" | "created" | "uploading" | "offline" | "paused" | "verifying" | "verified" | "duplicate" | "failed"; tone: "brand" | "muted" | "warn" | "ok" | "danger"; icon: IconName } {
  if (update.phase === "failed") return { stage: "failed", tone: "danger", icon: "alert" };
  if (update.phase === "done") return update.session?.state === "deduplicated" ? { stage: "duplicate", tone: "muted", icon: "form" } : { stage: "verified", tone: "ok", icon: "check" };
  if (update.phase === "processing") return { stage: "verifying", tone: "brand", icon: "shield" };
  if (update.phase === "paused") return { stage: "paused", tone: "warn", icon: "clock" };
  if (update.phase === "uploading") return online ? { stage: "uploading", tone: "brand", icon: "upload" } : { stage: "offline", tone: "warn", icon: "offline" };
  return update.phase === "hashing" ? { stage: "hashing", tone: "muted", icon: "key" } : { stage: "created", tone: "muted", icon: "clock" };
}

export function DesktopUpload({ locale }: { locale: Locale }) {
  const m = messages[locale], u = m.upload, me = useUser(), reporter = hasRole(me, ...uploadRoles);
  const [files, setFiles] = useState<File[]>([]), [rejected, setRejected] = useState<string[]>([]), [rows, setRows] = useState<Row[]>([]), [pending, setPending] = useState<PendingUpload[]>([]);
  const [base, setBase] = useState<Base>(initial), [schema, setSchema] = useState<Form | null>(null), [formError, setFormError] = useState(false), [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false), [failure, setFailure] = useState<"invalid" | "create" | "files" | null>(null);
  // مفتاح عدم التكرار لإنشاء المادة يبقى في الذاكرة لإعادة المحاولة نفسها، ويتجدد مع كل مادة جديدة.
  const createKey = useRef(crypto.randomUUID()), controls = useRef(new Map<string, UploadControl>()), picker = useRef<HTMLInputElement>(null);
  const [online, setOnline] = useState(true);
  // «انقطع الاتصال» (U2 المرحلة 3): ما وصل محفوظ، وtus يستأنف وحده حين يعود.
  useEffect(() => { const sync = () => setOnline(navigator.onLine); sync(); window.addEventListener("online", sync); window.addEventListener("offline", sync); return () => { window.removeEventListener("online", sync); window.removeEventListener("offline", sync); }; }, []);
  const active = rows.some(row => ["hashing", "creating", "uploading", "paused"].includes(row.update.phase));
  const need = uploadNeed(base);

  // مركز الرفع: الجلسات غير النهائية من الخادم، وما يقابلها محليًا يُستأنف بإعادة اختيار الملف. السجل المحلي لجلسة
  // لم تعد جارية على الخادم يُمحى.
  const [sessions, setSessions] = useState<SessionView[] | null>(null), [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let live = true;
    void Promise.all([pendingUploads(), myUploads().catch(() => null)]).then(async ([local, remote]) => {
      if (remote) {
        const open = new Set(remote.items.map(s => s.id));
        await Promise.all(local.filter(item => item.session_id && !open.has(item.session_id)).map(item => forgetUpload(item.key)));
        local = local.filter(item => !item.session_id || open.has(item.session_id));
      }
      if (live) { setPending(local); setSessions(remote?.items ?? null); }
    });
    return () => { live = false; };
  }, [rows.length, refresh]);
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
    // النموذج كاملًا بلا تصفية بنوع: المادة قد تحمل أنواعًا عدة، والراسم يُظهر حقول كل نوع مختار كما يتحقق الخادم.
    void browserApi().GET("/forms/current", { signal: controller.signal }).then(dataOrThrow)
      .then(data => { if (!controller.signal.aborted) { setSchema(data); setFormError(false); } }).catch(() => { if (!controller.signal.aborted) setFormError(true); });
    return () => controller.abort();
  }, [attempt, reporter]);

  async function launch(file: File, materialId: string) {
    const key = fileKey(file), record = await recordKey(key);
    if (controls.current.has(key)) return;
    const report = (update: UploadUpdate) => { const at = Date.now(); setRows(current => current.map(row => row.key === key ? { ...row, update, verifiedAt: row.verifiedAt ?? (update.phase === "done" ? at : undefined) } : row)); };
    setRows(current => [...current.filter(row => row.key !== key), { key, record, name: file.name, materialId, update: { phase: "hashing", hashed: 0, sent: 0, total: file.size, resumed: false } }]);
    const control = startUpload(file, materialId, report);
    controls.current.set(key, control);
    setRows(current => current.map(row => row.key === key ? { ...row, control } : row));
    void control.done.finally(() => { controls.current.delete(key); setRefresh(n => n + 1); });
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
    // لا يُرسَل طلب بلا جواب صريح عن الحساسية، ولو وصل الإرسال من غير الزر
    const sensitivity = sensitivityFlags(base.sensitivity);
    if (need || !sensitivity || Array.from(title).length < 5 || Array.from(title).length > 80 || !base.governorate.trim() || !base.city.trim() || (base.mode === "pseudonym" && !base.pseudonym.trim())) { setFailure("invalid"); return; }
    setBusy(true); setFailure(null);
    try {
      const material = await createMaterial<Material>({
        title, material_types: materialTypes.filter(type => base.types.includes(type)), tags: base.tags, governorate: base.governorate.trim(), city: base.city.trim(), ...(base.shot_at ? { shot_at: new Date(base.shot_at).toISOString() } : {}),
        priority: base.priority, sensitivity,
        display_name: base.mode === "pseudonym" ? { mode: "pseudonym", pseudonym: base.pseudonym.trim() } : { mode: base.mode },
        form_version: schema!.version, dynamic_fields: dynamic,
      }, createKey.current);
      for (const file of files) void launch(file, material.id);
      createKey.current = crypto.randomUUID(); setFiles([]); setBase(initial);
    } catch (error) { setFailure(error instanceof BffError && error.status === 422 ? "invalid" : "create"); }
    finally { setBusy(false); }
  }

  if (!reporter) return <NoAccess locale={locale} me={me} title={u.title} denied={u.reporterOnly} />;
  const set = <K extends keyof Base>(key: K, value: Base[K]) => setBase(current => ({ ...current, [key]: value }));
  return <><Heading locale={locale} />
    <section className="card upload-step upload-files" aria-labelledby="upload-files-title"><h2 id="upload-files-title"><span className="step-number" dir="ltr">1</span>{u.files}</h2>
      <label className="drop-zone"><Icon name="upload" size={28} /><strong id="upload-choose">{u.choose}</strong><small id="upload-files-help">{u.filesHelp}</small>
        <input ref={picker} type="file" multiple accept={cameraExtensions.join(",")} aria-labelledby="upload-choose" aria-describedby="upload-files-help" onChange={e => { void choose(e.target.files); e.target.value = ""; }} /></label>
      {rejected.map(name => <p key={name} className="notice error" role="alert">{fill(u.unsupported, name)}</p>)}
      {files.length > 0 && <ul className="upload-selection">{files.map(file => <li key={fileKey(file)}><Icon name="film" size={16} /><bdi>{file.name}</bdi> <small className="muted"><bdi dir="ltr">{bytes(file.size, locale)}</bdi></small></li>)}</ul>}
      <UploadCenter locale={locale} sessions={(sessions ?? []).filter(s => !rows.some(row => row.update.session?.id === s.id))} pending={pending.filter(item => !rows.some(row => row.record === item.key))} changed={() => setRefresh(n => n + 1)} pick={() => picker.current?.click()} />
    </section>
    {rows.length > 0 && <section className="upload-rows" aria-live="polite" aria-label={u.progressTitle}>{rows.map(row => <UploadRow key={row.key} row={row} online={online} locale={locale} pick={() => picker.current?.click()} />)}</section>}
    {files.length > 0 && <section className="card form-card upload-step" aria-labelledby="upload-material-title"><h2 id="upload-material-title"><span className="step-number" dir="ltr">2</span>{u.material}</h2>
      <fieldset className="upload-types"><legend>{u.types}</legend><small className="field-help">{u.typesHelp}</small>
        <div className="chip-row">{materialTypes.map(type => { const on = base.types.includes(type);
          return <button key={type} type="button" className="chip" aria-pressed={on} onClick={() => set("types", on ? base.types.filter(other => other !== type) : [...base.types, type])}>{m.types[type]}</button>; })}</div></fieldset>
      {formError ? <div role="alert"><p>{m.formMissing}</p><button onClick={() => setAttempt(n => n + 1)}>{m.retry}</button></div> : !schema ? <p role="status">{m.loading}</p> :
        <DynamicForm key={schema.version} schema={schema} type={base.types} permissions={me.permissions} locale={locale} onSubmit={dynamic => void submit(dynamic)} submitLabel={busy ? u.creating : u.start} disabled={busy || !!need}>
          <div className="upload-base">
            <label>{u.titleLabel}<input value={base.title} maxLength={80} required onChange={e => set("title", e.target.value)} /></label>
            <label>{m.governorate}<input value={base.governorate} maxLength={64} required onChange={e => set("governorate", e.target.value)} /></label>
            <label>{u.city}<input value={base.city} maxLength={64} required onChange={e => set("city", e.target.value)} /></label>
            <label>{u.shotAt}<input type="datetime-local" value={base.shot_at} onChange={e => set("shot_at", e.target.value)} /></label>
            <label>{u.priority}<select value={base.priority} onChange={e => set("priority", e.target.value as Base["priority"])}>{states.priority.map(p => <option key={p} value={p}>{m.states.priority[p]}</option>)}</select></label>
            <fieldset className="upload-tags"><legend>{u.tags}</legend><small className="field-help">{u.tagsHelp}</small><TagEntry locale={locale} tags={base.tags} onChange={tags => set("tags", tags)} /></fieldset>
            <fieldset className="upload-question"><legend>{u.sensitivityQuestion}</legend><small className="field-help">{u.sensitivityHelp}</small>
              <Answer name="sensitivity" value={base.sensitivity.gate === null ? null : base.sensitivity.gate === "yes"} locale={locale} onChange={yes => set("sensitivity", answerSensitivity(base.sensitivity, yes ? "yes" : "no"))} />
              {base.sensitivity.gate === "yes" && sensitivityFlagNames.map(flag => <fieldset key={flag} className="upload-followup"><legend>{u.followups[flag]}</legend>
                <Answer name={`sensitivity-${flag}`} value={base.sensitivity[flag]} locale={locale} onChange={yes => set("sensitivity", answerFollowup(base.sensitivity, flag, yes))} /></fieldset>)}
            </fieldset>
            <label>{u.displayName}<select value={base.mode} onChange={e => set("mode", e.target.value as Base["mode"])}>{(["network", "pseudonym", "real_name"] as const).map(mode => <option key={mode} value={mode}>{u.displayModes[mode]}</option>)}</select></label>
            {base.mode === "pseudonym" && <label>{u.pseudonym}<input value={base.pseudonym} maxLength={80} onChange={e => set("pseudonym", e.target.value)} /></label>}
          </div>
        </DynamicForm>}
      {need && schema && !formError && <p className="field-hint" role="status" data-testid="upload-need">{u.need[need]}</p>}
      {failure && <p className="notice error" role="alert">{failure === "invalid" ? u.invalid : failure === "files" ? u.noFiles : u.createFailed}</p>}
    </section>}
  </>;
}

function UploadCenter({ locale, sessions, pending, changed, pick }: { locale: Locale; sessions: SessionView[]; pending: PendingUpload[]; changed: () => void; pick: () => void }) {
  const u = messages[locale].upload, [busy, setBusy] = useState<string | null>(null), [failed, setFailed] = useState(false);
  // جلسات بلا سجل محلي (جهاز آخر، أو تخزين ممسوح) لا تُستأنف هنا، لكن تُلغى.
  const local = (id: string) => pending.find(item => item.session_id === id);
  const orphans = pending.filter(item => !item.session_id || !sessions.some(s => s.id === item.session_id));
  if (!sessions.length && !orphans.length) return null;
  async function abort(id: string) {
    setBusy(id); setFailed(false);
    try { await abortUpload(id); const record = local(id); if (record) await forgetUpload(record.key); changed(); }
    catch { setFailed(true); } finally { setBusy(null); }
  }
  // «أُغلق التبويب» (U2 المرحلة 4): الجلسة محفوظة لكن المتصفح لا يحتفظ بالملف، فيُعاد اختيار الملف نفسه ليكمل من نسبته.
  return <div className="upload-pending"><h3>{u.pending}</h3>{failed && <p className="notice error" role="alert">{u.abortFailed}</p>}<ul>
    {sessions.map(s => { const pct = percent(s.bytes_received, s.size_bytes), resumable = !!local(s.id);
      return <li key={s.id} className="upload-card" data-testid="pending-upload" data-resumable={resumable ? "true" : "false"}>
        <div className="upload-card-head"><span className="badge state warn"><Icon name="clock" size={14} />{u.stage.incomplete.replace("{pct}", String(pct))}</span><small className="muted">{formatDate(s.created_at, locale)}</small></div>
        <span className="upload-bar" aria-hidden="true"><span style={{ inlineSize: `${pct}%` }} /></span>
        <p className="caption"><bdi dir="ltr">{bytes(s.bytes_received, locale)} / {bytes(s.size_bytes, locale)}</bdi></p>
        <p className="upload-note">{resumable ? u.reselect.replace("{pct}", String(pct)) : u.otherDevice}</p>
        <div className="actions">{resumable && <button type="button" onClick={pick}>{u.chooseSame}</button>}<button type="button" className="secondary" disabled={busy === s.id} onClick={() => void abort(s.id)}>{u.abort}</button></div>
      </li>; })}
    {orphans.map(item => <li key={item.key} className="upload-card" data-testid="pending-upload" data-resumable="true">
      <div className="upload-card-head"><span className="badge state warn"><Icon name="clock" size={14} />{u.stage.paused}</span><small className="muted">{formatDate(new Date(item.updated_at).toISOString(), locale)}</small></div>
      <p className="caption"><bdi dir="ltr">{bytes(item.create.size_bytes, locale)}</bdi></p><p className="upload-note">{u.pendingHelp}</p>
      <div className="actions"><button type="button" onClick={pick}>{u.chooseSame}</button><button type="button" className="secondary" onClick={() => void forgetUpload(item.key).then(changed)}>{u.forget}</button></div></li>)}
  </ul></div>;
}

/** جواب «لا/نعم» بلا اختيار مسبق: `null` حتى يجيب المراسل. */
function Answer({ name, value, locale, onChange }: { name: string; value: boolean | null; locale: Locale; onChange: (yes: boolean) => void }) {
  const m = messages[locale];
  return <div className="answer-pair">{([false, true] as const).map(yes => <label key={String(yes)} className="check"><input type="radio" name={name} checked={value === yes} onChange={() => onChange(yes)} />{yes ? m.yes : m.no}</label>)}</div>;
}

function Heading({ locale }: { locale: Locale }) {
  const u = messages[locale].upload;
  return <div className="page-head"><div><h1>{u.title}</h1><p className="muted">{u.lead}</p></div></div>;
}

/** بطاقة الرفع (U2): اسم الملف وحجمه، والشريط، ثم سطر المرحلة بأيقونة وكلمة، ثم أفعالها. اسم الملف لصاحب الجلسة وحده ولا يُنقل إلى سجل. */
function UploadRow({ row, online, locale, pick }: { row: Row; online: boolean; locale: Locale; pick: () => void }) {
  const m = messages[locale], u = m.upload, { update, control } = row, { stage, tone, icon } = uploadStage(update, online);
  const receipt = update.session?.receipt_number, delivered = stage === "verified" && !!receipt;
  const value = update.phase === "hashing" ? update.hashed : update.sent, pct = percent(value, update.total), moving = ["hashing", "uploading", "paused"].includes(update.phase);
  const line = stage === "uploading" ? u.stage.progress.replace("{sent}", megabytes(update.sent, locale)).replace("{total}", megabytes(update.total, locale)).replace("{pct}", String(pct))
    : stage === "paused" ? u.stage.pausedAt.replace("{pct}", String(pct)) : stage === "failed" ? u.failure[update.failure ?? "rejected"] : u.stage[stage];
  return <article className={`upload-card ${update.phase}`} data-testid="upload-row" data-phase={update.phase} data-stage={stage}>
    <div className="upload-card-head"><strong><bdi>{row.name}</bdi></strong><small className="muted"><bdi dir="ltr">{bytes(update.total, locale)}</bdi></small>{update.resumed && <span className="badge">{u.resumed}</span>}</div>
    {moving ? <progress max={update.total} value={value} aria-label={fill(u.progress, row.name)} /> : <span className={`upload-bar ${tone}`} aria-hidden="true"><span style={{ inlineSize: update.phase === "failed" ? `${pct}%` : "100%" }} /></span>}
    {/* الإيصال بطاقة لا سطر (reporter-v2.md 06): ما وصل، ومتى، وبأي بصمة */}
    {delivered ? <div className="upload-receipt" data-testid="upload-receipt-card"><h3><Icon name="check" size={18} />{u.receiptTitle}</h3>
      <dl>
        <div><dt>{u.receipt}</dt><dd><bdi dir="ltr" className="ref" data-testid="upload-receipt">{receipt}</bdi></dd></div>
        {row.verifiedAt !== undefined && <div><dt>{u.receiptTime}</dt><dd>{formatDate(new Date(row.verifiedAt).toISOString(), locale)}</dd></div>}
        <div><dt>{u.receiptSize}</dt><dd><bdi dir="ltr">{bytes(update.total, locale)}</bdi></dd></div>
        {update.sha && <div><dt>{u.receiptHash}</dt><dd><bdi dir="ltr" className="ref">{update.sha.slice(0, 8)}</bdi></dd></div>}
      </dl></div>
      : <p className={`upload-stage ${tone}`}><Icon name={icon} size={16} /><span><strong className="visually-hidden">{u.phase[update.phase]}: </strong>{line}</span></p>}
    {stage === "uploading" && <p className="caption">{u.stage.keepOpen}</p>}
    {stage === "failed" && update.failure && ["checksum_mismatch", "network"].includes(update.failure) && <p className="caption">{u.stage.failedHint}</p>}
    {receipt && !delivered && <p className="caption">{u.receipt}: <bdi dir="ltr" className="ref" data-testid="upload-receipt">{receipt}</bdi></p>}
    <div className="actions">
      {update.phase === "uploading" && <button className="secondary" onClick={() => control?.pause()}>{u.pause}</button>}
      {update.phase === "paused" && <button onClick={() => control?.resume()}>{u.resume}</button>}
      {["hashing", "creating", "uploading", "paused"].includes(update.phase) && <button className="secondary" onClick={() => control?.cancel()}>{u.cancel}</button>}
      {update.phase === "failed" && update.failure !== "session_revoked" && <button type="button" onClick={pick}>{u.uploadAgain}</button>}
      {update.phase === "done" && <button type="button" className="secondary" onClick={pick}>{u.uploadAnother}</button>}
      {["processing", "done"].includes(update.phase) && <Link prefetch={false} className="button secondary" href={`/${locale}/materials/${row.materialId}`}>{u.open}</Link>}
    </div>
  </article>;
}

function bytes(value: number, locale: Locale) {
  const units = ["B", "KB", "MB", "GB", "TB"]; let index = 0, size = value;
  while (size >= 1024 && index < units.length - 1) { size /= 1024; index++; }
  return `${new Intl.NumberFormat(numberLocale(locale), { maximumFractionDigits: 1 }).format(size)} ${units[index]}`;
}
