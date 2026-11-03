"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { browserApi, dataOrThrow, RequestError } from "@/lib/browser-api";
import { formatDate, messages, shortTime, type Locale } from "@/lib/i18n";
import type { Material } from "@/lib/types";
import { hasRole } from "@/lib/review";
import { byteSize, cleanNote, exportRoles, isOpen, mediaDuration, nextStates, noteMax, producedReaders, rushes, taskReaders, validNote, type AssignmentTransition, type MaterialAssignment, type MaterialExport } from "@/lib/assignment-policy";
import { startUpload, type UploadControl, type UploadUpdate } from "@/lib/desktop-upload";
import { isSensitive } from "@/lib/render-policy";
import { useMutation } from "@/lib/use-mutation";
import { useUser } from "./session-boundary";
import { EmptyState, NoAccess } from "./empty-state";
import { ActionStatus } from "./action-status";
import { DueText, TaskState } from "./task-parts";
import { ConfirmDialog } from "./admin-parts";
import { megabytes, uploadStage } from "./desktop-upload";
import { fill } from "./render-dialog";
import { Icon } from "./icon";

const exportPollMs = 10000;

/**
 * المهمة (W6): العنوان وسطر «عاجل · أسندها … · المطلوب …»، وملاحظة المحرّر، والرشزات (أصول المادة) وتنزيلها حزمةً واحدة
 * (`/materials/{id}/export`: الأصل والنسخة الخفيفة وFCPXML/EDL)، وأفعال المهمة بجدول العقد. «رفع المادة المُنتَجة» بمسار tus نفسه
 * بنوع `produced` (ADR 0104، 0105)، و«تم» يحمل معرّف ملفها؛ «افتح في المحرّر العاجل» لمرحلة «مكتب المحرّر» (ADR 0097، 0083).
 */
export function TaskDetail({ locale, id }: { locale: Locale; id: string }) {
  const m = messages[locale], t = m.task, me = useUser(), allowed = hasRole(me, ...taskReaders);
  const [task, setTask] = useState<MaterialAssignment | null>(null), [material, setMaterial] = useState<Material | null>(null), [error, setError] = useState(0), [materialFailed, setMaterialFailed] = useState(false);
  const [attempt, setAttempt] = useState(0), [now, setNow] = useState(() => Date.now()), [notice, setNotice] = useState("");
  const [produced, setProduced] = useState<Produced | null>(null), control = useRef<UploadControl | null>(null);
  // مغادرة الصفحة توقف النقل وتبقي سجل الاستئناف؛ اختيار الملف نفسه بعدها يستأنف.
  useEffect(() => () => control.current?.stop(), []);
  useEffect(() => {
    if (!allowed) return;
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    async function load() {
      try { const data = dataOrThrow(await browserApi().GET("/assignments/{assignment_id}", { params: { path: { assignment_id: id } }, signal: controller.signal })); if (!controller.signal.aborted) { setTask(data); setError(0); setNow(Date.now()); } }
      catch (e) { if (!controller.signal.aborted) setError(e instanceof RequestError ? e.status : 503); }
      finally { if (!controller.signal.aborted) timer = setTimeout(load, 30000); }
    }
    void load(); return () => { controller.abort(); clearTimeout(timer); };
  }, [allowed, id, attempt]);
  const materialId = task?.material_id;
  useEffect(() => {
    if (!materialId) return;
    const controller = new AbortController();
    void browserApi().GET("/materials/{id}", { params: { path: { id: materialId } }, signal: controller.signal })
      .then(result => { const data = dataOrThrow(result); if (!controller.signal.aborted) { setMaterial(data); setMaterialFailed(false); } })
      .catch(() => { if (!controller.signal.aborted) setMaterialFailed(true); });
    return () => controller.abort();
  }, [materialId]);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 30000); return () => clearInterval(timer); }, []);
  useEffect(() => { if (!notice) return; const timer = setTimeout(() => setNotice(""), 8000); return () => clearTimeout(timer); }, [notice]);

  const mine = hasRole(me, "producer");
  const crumbs = (title?: string) => <nav className="breadcrumb" aria-label={m.shell.material.breadcrumb}><Link prefetch={false} className="back-link" href={`/${locale}/${mine ? "tasks" : "inbox"}`} aria-label={mine ? t.backToTasks : m.back}>{mine ? t.crumb : m.inbox}</Link>{title && <><span className="breadcrumb-sep"><Icon name="chevron" size={14} /></span><span aria-current="page">{title}</span></>}</nav>;
  if (!allowed) return <NoAccess locale={locale} me={me} title={m.tasks.title} denied={t.denied} />;
  if (error && !task) return <>{crumbs()}<EmptyState icon={error === 404 ? "search" : "alert"} role="alert" title={error === 404 ? m.notFound : m.error} actions={<button onClick={() => setAttempt(n => n + 1)}>{m.retry}</button>} /></>;
  if (!task) return <>{crumbs()}<p className="visually-hidden" role="status">{m.loading}</p><div className="material-layout" aria-hidden="true"><div className="material-main"><span className="skeleton line wide" /><span className="skeleton card" /></div><div className="material-side"><span className="skeleton card" /></div></div></>;
  const title = material?.title ?? (materialFailed ? m.tasks.materialUnavailable : m.loading), assignee = task.assignee_id === me.user_id;
  const upload = (file: File) => {
    control.current?.cancel();
    const next = startUpload(file, task.material_id, update => setProduced(current => current && current.control === next ? { ...current, update } : current), "produced");
    control.current = next;
    setProduced({ name: file.name, control: next, update: { phase: "hashing", hashed: 0, sent: 0, total: file.size, resumed: false } });
  };
  const discard = () => { control.current?.cancel(); control.current = null; setProduced(null); };
  const by = task.assigned_by_name ? fill(t.assignedBy, { name: task.assigned_by_name, time: shortTime(task.created_at) }) : fill(t.assignedByEditor, { time: shortTime(task.created_at) });
  return <>{crumbs(title)}{notice && <p className="toast" role="status">{notice}</p>}
    <div className="page-head task-head">
      <div><h1>{title}</h1>
        <p className="material-meta" data-testid="task-meta">{task.priority !== "normal" && <span className={`priority-pill ${task.priority}`}>{task.priority === "urgent" && <Icon name="bolt" size={12} />}{m.states.priority[task.priority]}</span>}
          <span>{by}</span><span><DueText task={task} now={now} locale={locale} /></span><TaskState state={task.state} locale={locale} />
          {material && isSensitive(material) && <span className="badge sensitive"><Icon name="shield" size={12} />{m.tasks.sensitive}</span>}</p>
        {!assignee && <p className="caption"><bdi>{t.assignee.replace("{name}", task.assignee_name ?? t.assigneeUnnamed)}</bdi></p>}</div>
      <div className="page-actions"><Link prefetch={false} className="button secondary" href={`/${locale}/materials/${task.material_id}`}>{t.openMaterial}</Link></div>
    </div>
    <div className="material-layout task-layout">
      <div className="material-main">
        <section className="card" aria-labelledby="task-note-title"><h2 id="task-note-title">{t.note}</h2>
          {task.note ? <p className="task-note" data-testid="task-note"><bdi>{task.note}</bdi></p> : <p className="muted">{t.noNote}</p>}
          {task.state === "returned" && task.return_note && <><h3>{t.returnNote}</h3><p className="task-note"><bdi>{task.return_note}</bdi></p></>}
        </section>
        <Rushes locale={locale} material={material} failed={materialFailed} />
      </div>
      <div className="material-side">
        <TaskActions locale={locale} task={task} produced={produced} onMoved={next => { if (next.state === "done") { control.current = null; setProduced(null); } setTask(next); setNotice(next.state === "done" ? (next.produced_file_id ? t.produced.deliveredWith : t.produced.deliveredWithout) : t.moved.replace("{state}", m.tasks.state[next.state])); }} onStale={() => { setNotice(t.changed); setAttempt(n => n + 1); }} />
        {assignee && isOpen(task.state) && <ProducedUpload locale={locale} produced={produced} upload={upload} discard={discard} />}
      </div>
    </div>
  </>;
}

/** أفعال المهمة بجدول العقد لهذا المستخدم: المسنَد إليه يتقدّم بها ويعيدها، ومن يملك الإسناد يعيدها. الإعادة بسبب اختياري لا يدخل تنبيهًا. */
function TaskActions({ locale, task, produced, onMoved, onStale }: { locale: Locale; task: MaterialAssignment; produced: Produced | null; onMoved: (task: MaterialAssignment) => void; onStale: () => void }) {
  const m = messages[locale], t = m.task, me = useUser(), mutation = useMutation(), [returning, setReturning] = useState(false), [reason, setReason] = useState("");
  const [delivering, setDelivering] = useState(false);
  const steps = nextStates(task, me), forward = steps.filter(step => step !== "returned"), trimmed = reason.trim(), reasonOk = !trimmed || validNote(trimmed);
  const fileId = producedFileId(produced), pending = !!produced && !["done", "failed"].includes(produced.update.phase);
  async function move(to: AssignmentTransition["to"]) {
    const body: AssignmentTransition = { to, ...(to === "returned" && trimmed ? { note: trimmed } : {}), ...(to === "done" && fileId ? { produced_file_id: fileId } : {}) };
    let next: MaterialAssignment | undefined, code: unknown;
    const ok = await mutation.run(JSON.stringify([task.id, task.state, body]), async header => {
      const result = await browserApi().POST("/assignments/{assignment_id}/transitions", { params: { path: { assignment_id: task.id }, header }, body });
      next = result.data; code = (result.error as { code?: unknown } | undefined)?.code; return result;
    });
    setDelivering(false);
    if (ok && next) { setReturning(false); setReason(""); onMoved(next); return; }
    if (code === "invalid_transition") onStale();
  }
  const closed = !isOpen(task.state);
  return <section className="card task-actions" aria-labelledby="task-actions-title" data-testid="task-actions"><h2 id="task-actions-title">{t.actionsTitle}</h2>
    {closed ? <><p data-testid="task-closed">{(task.state === "done" ? t.closedDone : t.closedReturned).replace("{time}", formatDate(task.closed_at, locale))}</p>
      {task.state === "done" && <p className="caption" data-testid="task-delivered">{task.produced_file_id ? t.produced.deliveredWith : t.produced.deliveredWithout}</p>}
      {task.produced_file_id && hasRole(me, ...producedReaders) && <ProducedDownload locale={locale} materialId={task.material_id} fileId={task.produced_file_id} />}</> : <>
      {forward.length > 0 && <div className="next-actions">{forward.map((to, i) => <button key={to} type="button" className={i ? "secondary" : undefined} data-testid={`act-${to}`} disabled={mutation.busy || (to === "done" && pending)} onClick={() => { if (to === "done") { mutation.clearStatus(); setDelivering(true); } else void move(to); }}>{t.act[to]}</button>)}</div>}
      {forward.includes("done") && <p className="caption">{pending ? t.produced.waiting : t.doneHint}</p>}
      {steps.includes("returned") && (returning ? <form className="return-form" onSubmit={e => { e.preventDefault(); if (reasonOk) void move("returned"); }}>
        <h3>{t.returnTitle}</h3>
        <label>{t.returnReason}<input dir="auto" maxLength={noteMax} value={reason} aria-invalid={!reasonOk} aria-describedby="return-hint" onChange={e => { mutation.clearStatus(); setReason(cleanNote(e.target.value)); }} /></label>
        <small id="return-hint" className="field-hint">{reasonOk ? t.returnHint : t.invalidNote}</small>
        <div className="actions"><button type="submit" className="danger" disabled={!reasonOk || mutation.busy}>{t.confirmReturn}</button><button type="button" className="secondary" disabled={mutation.busy} onClick={() => setReturning(false)}>{m.cancel}</button></div>
      </form> : <button type="button" className="quiet" onClick={() => setReturning(true)}>{t.act.returned}</button>)}
    </>}
    <ActionStatus status={mutation.status === 200 ? 0 : mutation.status} locale={locale} />
    {delivering && <ConfirmDialog locale={locale} testId="confirm-done" title={t.act.done} confirm={t.act.done} busy={mutation.busy} status={0} onConfirm={() => void move("done")} onCancel={() => setDelivering(false)}>
      <p>{fileId ? t.produced.effectWithFile : t.produced.effectWithout}</p>
      {fileId && produced && <p className="caption">{t.produced.fileLabel}: <bdi>{produced.name}</bdi></p>}
    </ConfirmDialog>}
  </section>;
}

type Produced = { name: string; update: UploadUpdate; control: UploadControl };
/** معرّف الملف حين تتحقّق بصمته وحدها؛ المكرّر ليس ملفًا جديدًا على المادة فلا يُسلَّم من هنا. */
const producedFileId = (produced: Produced | null) => produced?.update.phase === "done" && produced.update.session?.state === "verified" && produced.update.session.file_id ? produced.update.session.file_id : null;

/**
 * النسخة المُنتَجة (W6، ADR 0104، 0105): للمسنَد إليه في مهمة مفتوحة، بمسار tus نفسه ونوع `produced`؛ الخادم يحكم في المهمة.
 * الأصل لا يُمس، والنسخة ملف جديد على المادة، و«سلّمت المهمة» يحملها بعد التحقّق من بصمتها. اسم الملف لصاحبه وحده ولا يُرسل.
 */
function ProducedUpload({ locale, produced, upload, discard }: { locale: Locale; produced: Produced | null; upload: (file: File) => void; discard: () => void }) {
  const m = messages[locale], u = m.upload, t = m.task.produced, picker = useRef<HTMLInputElement>(null);
  const update = produced?.update, view = update ? uploadStage(update) : null, moving = !!update && ["hashing", "uploading", "paused"].includes(update.phase);
  const value = update ? (update.phase === "hashing" ? update.hashed : update.sent) : 0, pct = update?.total ? Math.floor((value / update.total) * 100) : 0;
  const line = !update || !view ? "" : view.stage === "uploading" ? u.stage.progress.replace("{sent}", megabytes(update.sent, locale)).replace("{total}", megabytes(update.total, locale)).replace("{pct}", String(pct))
    : view.stage === "paused" ? u.stage.pausedAt.replace("{pct}", String(pct)) : view.stage === "failed" ? u.failure[update.failure ?? "rejected"] : view.stage === "duplicate" ? t.duplicate : view.stage === "verified" ? t.ready : u.stage[view.stage];
  return <section className="card produced-card" aria-labelledby="produced-title" data-testid="produced-upload" data-stage={view?.stage ?? "empty"}>
    <h2 id="produced-title">{t.title}</h2><p className="caption">{t.lead}</p>
    <input ref={picker} type="file" hidden aria-label={t.choose} data-testid="produced-input" onChange={event => { const file = event.target.files?.[0]; event.target.value = ""; if (file) upload(file); }} />
    {produced && update && view && <div className={`upload-card ${update.phase}`}>
      <div className="upload-card-head"><strong><bdi>{produced.name}</bdi></strong></div>
      {moving ? <progress max={update.total} value={value} aria-label={t.fileLabel} /> : <span className={`upload-bar ${view.tone}`} aria-hidden="true"><span style={{ inlineSize: update.phase === "failed" ? `${pct}%` : "100%" }} /></span>}
      <p className={`upload-stage ${view.tone}`} role="status"><Icon name={view.icon} size={16} /><span>{line}</span></p>
    </div>}
    <div className="actions">
      {!produced ? <button type="button" className="secondary" onClick={() => picker.current?.click()}><Icon name="upload" size={16} />{t.choose}</button>
        : update && ["done", "failed"].includes(update.phase) ? <button type="button" className="secondary" onClick={() => picker.current?.click()}>{update.phase === "failed" ? t.again : t.replace}</button>
        : <button type="button" className="secondary" onClick={discard}>{u.cancel}</button>}
      {produced && update && ["done", "failed"].includes(update.phase) && <button type="button" className="quiet" onClick={discard}>{m.cancel}</button>}
    </div>
  </section>;
}

/** تنزيل النسخة المُنتَجة لمن يراها: الرابط يُطلب عند النقر ولا يُخزَّن، والخادم يسجّل إصداره. */
function ProducedDownload({ locale, materialId, fileId }: { locale: Locale; materialId: string; fileId: string }) {
  const t = messages[locale].task.produced, [busy, setBusy] = useState(false), [failed, setFailed] = useState(false);
  async function download() {
    setBusy(true); setFailed(false);
    try {
      // مسار الـBFF وحده (كمسار `content`)؛ الخادم يُصدر الرابط من `GET /materials/{id}/files/{file_id}/download-url`.
      const response = await fetch(`/api/bff/materials/${materialId}/files/${fileId}/produced-url`, { credentials: "same-origin", cache: "no-store" });
      if (response.status === 401) window.dispatchEvent(new Event("session-revoked"));
      const data = response.ok ? await response.json() as { url?: unknown } : null;
      if (typeof data?.url === "string") { window.location.assign(data.url); return; }
      setFailed(true);
    } catch { setFailed(true); } finally { setBusy(false); }
  }
  return <><div className="actions"><button type="button" className="secondary" data-testid="produced-download" disabled={busy} onClick={() => void download()}><Icon name="download" size={16} />{t.download}</button></div>
    {failed && <p className="notice error" role="alert">{t.downloadFailed}</p>}</>;
}

/**
 * الرشزات (W6): أصول المادة كما في `Material.files` بمدتها وحجمها، وتنزيلها حزمة التصدير الواحدة. العقد لا يعطي رابطًا لكل أصل،
 * والحزمة تُبنى عند الطلب: «تنزيل الكل» يطلبها ثم يستطلع حالتها كل عشر ثوانٍ، ورابطها يُطلب عند النقر ولا يُخزَّن، والخادم يسجّل
 * كل إصدار رابط في التدقيق (ومنه رشزات المادة الحسّاسة، web-v2.md M3). المشرف لا يملك تنزيل الأصل في العقد، فيرى القائمة وحدها.
 */
function Rushes({ locale, material, failed }: { locale: Locale; material: Material | null; failed: boolean }) {
  const m = messages[locale], t = m.task, me = useUser(), may = hasRole(me, ...exportRoles), mutation = useMutation();
  const [state, setState] = useState<MaterialExport | null>(null), [stateFailed, setStateFailed] = useState(false), [linkBusy, setLinkBusy] = useState(false), [linkFailed, setLinkFailed] = useState(false), [poll, setPoll] = useState(0);
  const wanted = useRef(false), materialId = material?.id;
  useEffect(() => {
    if (!may || !materialId) return;
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    async function load() {
      try {
        const data = dataOrThrow(await browserApi().GET("/materials/{id}/export", { params: { path: { id: materialId! } }, signal: controller.signal }));
        if (controller.signal.aborted) return;
        setState(data); setStateFailed(false);
        if (data.state === "requested") timer = setTimeout(load, exportPollMs);
        else if (data.state === "ready" && wanted.current) { wanted.current = false; void download(); }
      } catch { if (!controller.signal.aborted) setStateFailed(true); }
    }
    void load(); return () => { controller.abort(); clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [may, materialId, poll]);
  async function download() {
    if (!materialId) return;
    setLinkBusy(true); setLinkFailed(false);
    try {
      const result = await browserApi().GET("/materials/{id}/export/download-url", { params: { path: { id: materialId } } });
      if (result.response.status === 401) window.dispatchEvent(new Event("session-revoked"));
      if (result.data?.url) { window.location.assign(result.data.url); return; }
      if ((result.error as { code?: unknown } | undefined)?.code === "export_not_ready") { setPoll(n => n + 1); return; }
      setLinkFailed(true);
    } catch { setLinkFailed(true); } finally { setLinkBusy(false); }
  }
  async function prepare() {
    if (!materialId) return;
    wanted.current = true;
    let next: MaterialExport | undefined;
    if (await mutation.run(`${materialId}:export`, async header => { const result = await browserApi().POST("/materials/{id}/export", { params: { path: { id: materialId }, header } }); next = result.data; return result; }) && next) {
      setState(next);
      if (next.state === "ready") { wanted.current = false; void download(); } else setPoll(n => n + 1);
    } else wanted.current = false;
  }
  const list = material ? rushes(material) : null, size = list ? byteSize(list.size) : null;
  const busy = mutation.busy || linkBusy || state?.state === "requested";
  return <section className="card rushes-card" id="rushes" aria-labelledby="rushes-title" data-testid="rushes">
    <div className="rushes-head"><div><h2 id="rushes-title">{t.rushesTitle.replace("{n}", String(list?.count ?? 0))}</h2><p className="caption">{t.rushesLead}</p></div>
      {may && list && list.count > 0 && <button type="button" disabled={busy || stateFailed} onClick={() => void (state?.state === "ready" ? download() : prepare())} data-testid="download-all">
        <Icon name="download" size={16} />{state?.state === "failed" ? t.exportRetry : size ? <bdi>{t.downloadAllSize.replace("{size}", size)}</bdi> : t.downloadAll}</button>}</div>
    {!may && <p className="notice">{t.exportRoleOnly}</p>}
    {state?.state === "requested" && <p className="notice" role="status" data-testid="export-preparing">{t.preparing}</p>}
    {state?.state === "failed" && <p className="notice error" role="alert">{t.exportFailed}</p>}
    {(linkFailed || stateFailed) && <p className="notice error" role="alert">{m.error}</p>}
    <ActionStatus status={mutation.status === 200 ? 0 : mutation.status} locale={locale} />
    {failed ? <p className="muted">{m.tasks.materialUnavailable}</p> : !list ? <p role="status" className="muted">{m.loading}</p> : <ol className="rush-list">{list.files.map((file, i) => {
      const photo = file.mime_type?.startsWith("image/"), duration = mediaDuration(file.duration_ms), bytes = byteSize(file.size_bytes);
      return <li key={file.id} data-testid="rush"><span className="row-thumb" aria-hidden="true"><Icon name={photo ? "preview" : "film"} /></span>
        <span className="rush-name"><strong>{(photo ? t.photo : file.mime_type?.startsWith("video/") || duration ? t.clip : t.file).replace("{n}", String(i + 1))}</strong>{duration && <> · <bdi dir="ltr">{duration}</bdi></>}</span>
        {bytes && <small className="muted" dir="ltr">{bytes}</small>}</li>;
    })}</ol>}
    {may && <p className="caption rushes-hint">{t.exportHint}</p>}
  </section>;
}
