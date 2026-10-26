"use client";
import { useEffect, useRef, useState } from "react";
import { browserApi } from "@/lib/browser-api";
import { messages, type Locale } from "@/lib/i18n";
import type { Material, Transition } from "@/lib/types";
import { stateColumn, tracks, transitionOptions } from "@/lib/review";
import { reasonLimits } from "@/lib/admin-policy";
import { timecode } from "@/lib/editor";
import { useMutation } from "@/lib/use-mutation";
import { useUser } from "./session-boundary";
import { ActionStatus } from "./action-status";
import { StateBadge } from "./states";

export const reasonMin = 5;
type Props = { locale: Locale; material: Material; tag: string | null; editing: () => void; reload: () => void; onClose: () => void; onDone: (label: string) => void };

/** حوار التحويل (B3): انتقال واحد بسبب إلزامي، وتعليق اختياري على ثانية المشغّل، ومعاينة ما يصل المراسل، وتأكيد ثانٍ للرفض. */
export function TransitionDialog({ locale, material, tag, editing, reload, onClose, onDone }: Props) {
  const m = messages[locale], t = m.review, me = useUser(), mutation = useMutation();
  const available = tracks.filter(track => transitionOptions(material, me, track).length);
  const [track, setTrack] = useState<Transition["track"]>(available[0] ?? "editorial"), [to, setTo] = useState(""), [reason, setReason] = useState("");
  const [pin, setPin] = useState(false), [at, setAt] = useState(0), [armed, setArmed] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null), options = transitionOptions(material, me, track);
  const column = stateColumn[track], label = (value: string) => (m.states[column] as Record<string, string>)[value] ?? value;
  useEffect(() => { if (dialog.current && !dialog.current.open) dialog.current.showModal(); }, []);
  // تأكيد الرفض يبقى مسلّحًا خمس ثوانٍ ثم يعود الزر إلى حاله.
  useEffect(() => { if (!armed) return; const timer = setTimeout(() => setArmed(false), 5000); return () => clearTimeout(timer); }, [armed]);
  const valid = !!tag && options.includes(to) && reason.trim().length >= reasonMin;
  // يُغلق الحوار الأصلي أولًا كي يعود التركيز إلى زر «تحويل الحالة» خارج النافذة.
  const close = () => { dialog.current?.close(); onClose(); };

  async function submit() {
    editing();
    if (!valid || !tag) return;
    if (to === "rejected" && !armed) { setArmed(true); return; }
    const body: Transition = { track, to, reason: reason.trim(), ...(pin ? { note_timecode_ms: at } : {}) };
    const ok = await mutation.run(JSON.stringify([material.id, tag, body]), header => browserApi().POST("/materials/{id}/transitions", { params: { path: { id: material.id }, header: { ...header, "If-Match": tag } }, body }));
    setArmed(false);
    if (ok) { onDone(label(to)); reload(); }
  }
  function capture(checked: boolean) {
    // الثانية الحالية من مشغّل المعاينة إن وُجد؛ وإلا الصفر.
    const video = document.querySelector<HTMLVideoElement>(".material-player video");
    setAt(Math.max(0, Math.round((video?.currentTime ?? 0) * 1000))); setPin(checked);
  }
  return <dialog ref={dialog} className="modal transition-dialog" aria-modal="true" aria-labelledby="transition-title" onCancel={e => { e.preventDefault(); close(); }}>
    <form noValidate onChange={editing} onSubmit={e => { e.preventDefault(); void submit(); }}>
      <h2 id="transition-title">{t.dialogTitle}</h2>
      {available.length > 1 && <label>{t.track}<select aria-label={t.track} value={track} onChange={e => { setTrack(e.target.value as Transition["track"]); setTo(""); setArmed(false); }}>{available.map(key => <option key={key} value={key}>{m[key]}</option>)}</select></label>}
      <div className="transition-row"><StateBadge track={column} value={material[column]} locale={locale} /><span aria-hidden="true">{locale === "ar" ? "←" : "→"}</span>{to ? <StateBadge track={column} value={to as Material[typeof column]} locale={locale} /> : <span className="muted">{t.chooseTarget}</span>}</div>
      <fieldset className="choice-group"><legend>{t.target}</legend>
        {options.map(value => <label key={value} className={`choice ${to === value ? "selected" : ""}`}><input type="radio" name="target" value={value} checked={to === value} onChange={() => { setTo(value); setArmed(false); }} />
          <span><strong>{label(value)}</strong>{(t.consequences as Record<string, string>)[value] && <small className="muted">{(t.consequences as Record<string, string>)[value]}</small>}</span></label>)}
      </fieldset>
      <label>{t.reason}<textarea aria-label={t.reason} required minLength={reasonMin} maxLength={reasonLimits.transition} value={reason} onChange={e => setReason(e.target.value)} aria-describedby="reason-help" /></label>
      <p id="reason-help" className="muted">{t.reasonHelp}</p>
      <label className="check"><input type="checkbox" checked={pin} onChange={e => capture(e.target.checked)} />{t.pinTime}{pin && <span className="time-chip" dir="ltr">{timecode(at)}</span>}</label>
      {to && <section className="notification-preview" aria-label={t.previewTitle}><p className="muted">{t.previewTitle}</p><p>{t.previewText.replace("{state}", label(to))}{reason.trim() && <> «<bdi>{reason.trim()}</bdi>»</>}</p></section>}
      {mutation.status === 412 ? <div className="notice error" role="alert"><p>{t.changed}</p><button type="button" className="secondary" onClick={reload}>{t.reloadChanges}</button></div> : <ActionStatus status={mutation.status} locale={locale} />}
      <div className="actions"><button type="button" className="secondary" disabled={mutation.busy} onClick={close}>{m.cancel}</button>
        <button className={to === "rejected" && armed ? "danger" : ""} disabled={!valid || mutation.busy || mutation.status === 412}>{mutation.busy ? t.saving : to === "rejected" && armed ? t.confirmReject : to ? t.confirmTo.replace("{state}", label(to)) : t.apply}</button></div>
      {to === "rejected" && <p className="muted">{t.rejectHelp}</p>}
    </form>
  </dialog>;
}
