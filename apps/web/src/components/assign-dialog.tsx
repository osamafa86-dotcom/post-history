"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { browserApi, dataOrThrow } from "@/lib/browser-api";
import { messages, plural, shortTime, type Locale } from "@/lib/i18n";
import type { Material } from "@/lib/types";
import { candidateLoad, cleanNote, dueAt, duePresets, noteMax, rushes, validNote, type AssignmentCandidate, type AssignmentCreate, type DuePreset, type MaterialAssignment } from "@/lib/assignment-policy";
import { useMutation } from "@/lib/use-mutation";
import { ActionStatus } from "./action-status";
import { fill } from "./render-dialog";
import { Icon } from "./icon";

/** ساعة الطلب لحظة الإرسال (خارج المكوّن: الموعد يُحسب عند النقر لا عند الرسم). */
const currentTime = () => Date.now();
type Refusal = { code: "assignment_open"; assignmentId?: string } | { code: "assignment_not_allowed" } | { code: "assignee_not_eligible" };
type Props = { locale: Locale; material: Pick<Material, "id" | "title" | "priority" | "files">; onClose: () => void; onAssigned: (task: MaterialAssignment, name: string) => void };

/** اسم المرشّح كما يُعرض: اسم العمل، أو «عضو في فريق الإنتاج» بلا اسم. لا بريد ولا اسم حقيقي. */
export const candidateName = (c: Pick<AssignmentCandidate, "work_name">, locale: Locale) => c.work_name ?? messages[locale].assign.unnamed;
const initials = (name: string) => { const words = name.split(/\s+/).filter(Boolean); return (words.length > 1 ? [...words[0]][0] + [...words[1]][0] : [...(words[0] ?? "?")].slice(0, 2).join("")).toLocaleUpperCase(); };

/**
 * «تحويل إلى المونتير» (W3): المونتير بحِمله من `GET /assignment-candidates` (الأقل حِملًا أولًا)، والموعد بثلاثة خيارات يحسبها العميل،
 * والملاحظة بقاعدة العقد. الإسناد لا يغيّر الحالات الثلاث، فلا If-Match؛ والمفتاح والجسم ثابتان لإعادة المحاولة نفسها.
 */
export function AssignDialog({ locale, material, onClose, onAssigned }: Props) {
  const m = messages[locale], t = m.assign, mutation = useMutation(), dialog = useRef<HTMLDialogElement>(null), pending = useRef<{ fingerprint: string; body: AssignmentCreate } | null>(null);
  const [candidates, setCandidates] = useState<AssignmentCandidate[] | null>(null), [failed, setFailed] = useState(false), [attempt, setAttempt] = useState(0);
  const [chosen, setChosen] = useState<string | null>(null), [preset, setPreset] = useState<DuePreset>("30m"), [note, setNote] = useState(""), [refusal, setRefusal] = useState<Refusal | null>(null), [now, setNow] = useState(() => Date.now());
  useEffect(() => { if (dialog.current && !dialog.current.open) dialog.current.showModal(); }, []);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 30000); return () => clearInterval(timer); }, []);
  useEffect(() => {
    const controller = new AbortController();
    void browserApi().GET("/assignment-candidates", { signal: controller.signal }).then(result => {
      const data = dataOrThrow(result);
      if (controller.signal.aborted) return;
      setCandidates(data.items); setFailed(false); setChosen(current => current && data.items.some(c => c.user_id === current) ? current : data.items[0]?.user_id ?? null);
    }).catch(() => { if (!controller.signal.aborted) setFailed(true); });
    return () => controller.abort();
  }, [attempt]);
  const close = () => { dialog.current?.close(); onClose(); };
  const person = candidates?.find(c => c.user_id === chosen) ?? null, trimmed = note.trim(), noteOk = !trimmed || validNote(trimmed);
  const presets = duePresets.filter(p => dueAt(p, now) !== null), due = dueAt(preset, now);
  const { count } = rushes(material);

  async function submit() {
    if (!person || !noteOk) return;
    // الجسم يُبنى مرة لكل نية (المونتير والموعد والملاحظة)، فإعادة المحاولة بعد انقطاع ترسل الموعد نفسه بالمفتاح نفسه.
    const fingerprint = JSON.stringify([material.id, person.user_id, preset, trimmed]);
    if (pending.current?.fingerprint !== fingerprint) {
      const at = dueAt(preset, currentTime()); if (!at) return;
      pending.current = { fingerprint, body: { assignee_id: person.user_id, due_at: at, ...(trimmed ? { note: trimmed } : {}) } };
    }
    const body = pending.current.body;
    let created: MaterialAssignment | undefined, error: { code?: unknown; details?: unknown } | undefined, status = 0;
    const ok = await mutation.run(fingerprint, async header => {
      const result = await browserApi().POST("/materials/{id}/assignments", { params: { path: { id: material.id }, header }, body });
      created = result.data; error = result.error as typeof error; status = result.response.status; return result;
    });
    if (status < 500 && status !== 429) pending.current = null;
    if (ok && created) { onAssigned(created, candidateName(person, locale)); close(); return; }
    if (error?.code === "assignment_open") { const details = error.details as { assignment_id?: unknown } | undefined; setRefusal({ code: "assignment_open", assignmentId: typeof details?.assignment_id === "string" ? details.assignment_id : undefined }); return; }
    if (error?.code === "assignment_not_allowed") { setRefusal({ code: "assignment_not_allowed" }); return; }
    if (error?.code === "assignee_not_eligible") { setRefusal({ code: "assignee_not_eligible" }); setChosen(null); setAttempt(n => n + 1); }
  }
  const change = (apply: () => void) => { setRefusal(null); mutation.clearStatus(); apply(); };

  return <dialog ref={dialog} className="modal assign-dialog" aria-labelledby="assign-title" aria-describedby="assign-subtitle" data-testid="assign-dialog" onCancel={e => { e.preventDefault(); close(); }}>
    <form noValidate onSubmit={e => { e.preventDefault(); void submit(); }}>
      <header className="assign-head">
        <span className="sheet-handle" aria-hidden="true" />
        <div><h2 id="assign-title">{t.title}</h2>
          <p id="assign-subtitle" className="muted">{fill(t.subtitle, { title: material.title, files: plural(count, m.tasks.rushes, locale), priority: m.states.priority[material.priority] })}</p></div>
        <button type="button" className="icon-button sheet-close" aria-label={t.close} onClick={close}><Icon name="x" /></button>
      </header>
      <fieldset className="assign-people"><legend className="visually-hidden">{t.candidates}</legend>
        {failed ? <p className="notice error" role="alert">{m.error} <button type="button" className="link-button" onClick={() => setAttempt(n => n + 1)}>{m.retry}</button></p>
          : !candidates ? <p role="status" className="muted">{t.loadingCandidates}</p>
          : !candidates.length ? <p className="notice">{t.noCandidates}</p>
          : <ul>{candidates.map(c => {
            const name = candidateName(c, locale), load = candidateLoad(c);
            const line = load.free ? t.free : [plural(load.open, t.openTasks, locale), load.urgent ? t.urgentTasks.replace("{n}", String(load.urgent)) : null, load.overdue ? t.overdueTasks.replace("{n}", String(load.overdue)) : null].filter(Boolean).join(m.shell.listSeparator);
            return <li key={c.user_id}><label className={`person-option${chosen === c.user_id ? " selected" : ""}`} data-testid="assign-candidate">
              <span className="avatar" aria-hidden="true">{initials(name)}</span>
              <span className="person-text"><strong><bdi>{name}</bdi></strong><small className={load.overdue ? "attention-text" : undefined}>{line}</small></span>
              <input type="radio" name="assignee" value={c.user_id} checked={chosen === c.user_id} onChange={() => change(() => setChosen(c.user_id))} />
            </label></li>;
          })}</ul>}
      </fieldset>
      <fieldset className="assign-due"><legend>{t.due}</legend>
        <div className="due-options">{presets.map(p => <label key={p} className={`chip${preset === p ? " active" : ""}`}><input className="visually-hidden" type="radio" name="due" value={p} checked={preset === p} onChange={() => change(() => setPreset(p))} />{t.presets[p]}</label>)}</div>
        {due && <p className="field-hint">{t.dueAt.replace("{time}", shortTime(due))}</p>}
      </fieldset>
      <label className="assign-note">{t.note}
        <input dir="auto" maxLength={noteMax} value={note} aria-invalid={!noteOk} aria-describedby="assign-note-hint" onChange={e => change(() => setNote(cleanNote(e.target.value)))} />
        <small id="assign-note-hint" className="field-hint">{t.noteHint}</small>
      </label>
      {refusal && <p className="notice error" role="alert" data-testid="assign-refusal">{refusal.code === "assignment_open" ? <>{t.open}{refusal.assignmentId && <> <Link prefetch={false} href={`/${locale}/tasks/${refusal.assignmentId}`}>{m.tasks.open}</Link></>}</> : refusal.code === "assignment_not_allowed" ? t.notAllowed : t.notEligible}</p>}
      {!refusal && mutation.status !== 0 && mutation.status !== 200 && <ActionStatus status={mutation.status} locale={locale} />}
      <footer className="assign-foot">
        <button type="submit" disabled={!person || !due || !noteOk || mutation.busy}>{person ? fill(t.submit, { name: candidateName(person, locale) }) : t.submitPlain}</button>
        <button type="button" className="secondary" disabled={mutation.busy} onClick={close}>{t.cancel}</button>
      </footer>
    </form>
  </dialog>;
}
