"use client";
import { useEffect, useRef, useState } from "react";
import { browserApi, dataOrThrow } from "@/lib/browser-api";
import { messages, plural, type Locale, type PluralForms } from "@/lib/i18n";
import { activeLicenseReaders, type ActiveLicenses } from "@/lib/issued-licenses";
import { hasRole } from "@/lib/review";
import type { Material, Transition } from "@/lib/types";
import { reasonReaches, stateColumn, tracks, transitionOptions } from "@/lib/review";
import { reasonLimits } from "@/lib/admin-policy";
import { timecode } from "@/lib/editor";
import { useMutation } from "@/lib/use-mutation";
import { useUser } from "./session-boundary";
import { ActionStatus } from "./action-status";
import { StateBadge } from "./states";
import { LengthCounter } from "./admin-parts";
import { sensitivityState } from "@/lib/sensitivity";

export const reasonMin = 5;
/** ما كتبه المستخدم في الحوار: يُحفظ عبر «تحميل التغييرات» بعد تعارض، فلا يضيع السبب إن بقي الهدف متاحًا. */
export type TransitionDraft = { track: Transition["track"]; to: string; reason: string; pin: boolean; at: number };
type Props = { locale: Locale; material: Material; tag: string | null; initial?: TransitionDraft | null; keep?: (draft: TransitionDraft) => void; editing: () => void; reload: () => void; onClose: () => void; onDone: (label: string) => void };

/**
 * ما يقوله الحوار قبل أن تخرج حقوق المادة من «صالحة للترخيص» (قرار المنسّق 2026-11-15، ADR 0118): كم ترخيصًا مدفوعًا سيُبطل وعند كم مؤسسة، وأن
 * الإبطال نهائي بلا استرداد آلي. العدّ المجهول (تعذّر، أو دور لا يقرؤه) يُقال كذلك ولا يُسكت عنه.
 */
export function RevocationNotice({ locale, counts }: { locale: Locale; counts: ActiveLicenses | "loading" | "unknown" }) {
  const t = messages[locale].review;
  if (counts === "loading") return <p className="muted" role="status" data-testid="revocation-notice" data-state="loading">{t.revokeCounting}</p>;
  if (counts !== "unknown" && counts.active_licenses === 0) return <p className="muted" role="note" data-testid="revocation-notice" data-state="none">{t.revokeNone}</p>;
  return <div className="notice attention" role="alert" data-testid="revocation-notice" data-state={counts === "unknown" ? "unknown" : "some"}>
    <p><strong>{counts === "unknown" ? t.revokeUnknown : t.revokeEffect.replace("{licenses}", plural(counts.active_licenses, t.revokeLicenses as PluralForms, locale)).replace("{organizations}", plural(counts.organizations, t.revokeOrganizations as PluralForms, locale))}</strong></p>
    {counts !== "unknown" && <p>{t.revokeFinal}</p>}
  </div>;
}

/** حوار التحويل (B3): انتقال واحد بسبب إلزامي، وتعليق اختياري على ثانية المشغّل، ومعاينة ما يصل المراسل، وتأكيد ثانٍ للرفض ولإبطال التراخيص. */
export function TransitionDialog({ locale, material, tag, initial, keep, editing, reload, onClose, onDone }: Props) {
  const m = messages[locale], t = m.review, me = useUser(), mutation = useMutation();
  const available = tracks.filter(track => transitionOptions(material, me, track).length);
  const [track, setTrack] = useState<Transition["track"]>(initial?.track ?? available[0] ?? "editorial"), [to, setTo] = useState(initial?.to ?? ""), [reason, setReason] = useState(initial?.reason ?? "");
  const [pin, setPin] = useState(initial?.pin ?? false), [at, setAt] = useState(initial?.at ?? 0), [armed, setArmed] = useState(false), [blurred, setBlurred] = useState(false);
  // نشر مادة موسومة بالحساسية (قرار المنسّق 2026-11-15): مسموح بتأكيد صريح يسمّي الوسوم. المجهولة الحساسية تُعامل كالموسومة.
  const sensitivity = sensitivityState(material.sensitivity), sensitivePublish = track === "editorial" && to === "published" && (!sensitivity.known || sensitivity.flags.length > 0);
  const dialog = useRef<HTMLDialogElement>(null), options = transitionOptions(material, me, track);
  // خروج الحقوق من «صالحة للترخيص» يُبطل التراخيص الفاعلة نهائيًا: يُعدّ ما سيُبطل قبل التأكيد، ويُطلب تأكيد ثانٍ ما لم يكن العدد صفرًا.
  const revokes = track === "rights" && material.rights_state === "sellable" && !!to && to !== "sellable", countable = hasRole(me, ...activeLicenseReaders);
  const [counted, setCounted] = useState<ActiveLicenses | "unknown" | null>(null);
  useEffect(() => {
    if (!revokes || !countable) return;
    const controller = new AbortController();
    void browserApi().GET("/materials/{id}/active-licenses", { params: { path: { id: material.id } }, signal: controller.signal }).then(dataOrThrow).then(data => { if (!controller.signal.aborted) setCounted(data); }).catch(() => { if (!controller.signal.aborted) setCounted("unknown"); });
    return () => controller.abort();
  }, [revokes, countable, material.id]);
  const counts = !revokes ? null : !countable ? "unknown" : counted ?? "loading", revoking = !!counts && counts !== "loading" && (counts === "unknown" || counts.active_licenses > 0);
  const twice = to === "rejected" || revoking;
  const column = stateColumn[track], label = (value: string) => (m.states[column] as Record<string, string>)[value] ?? value;
  useEffect(() => { if (dialog.current && !dialog.current.open) dialog.current.showModal(); }, []);
  // تأكيد الرفض يبقى مسلّحًا خمس ثوانٍ ثم يعود الزر إلى حاله.
  useEffect(() => { if (!armed) return; const timer = setTimeout(() => setArmed(false), 5000); return () => clearTimeout(timer); }, [armed]);
  const valid = !!tag && options.includes(to) && reason.trim().length >= reasonMin && (!sensitivePublish || blurred) && counts !== "loading";
  // يُغلق الحوار الأصلي أولًا كي يعود التركيز إلى زر «تحويل الحالة» خارج النافذة.
  const close = () => { dialog.current?.close(); onClose(); };

  async function submit() {
    editing();
    if (!valid || !tag) return;
    if (twice && !armed) { setArmed(true); return; }
    const body: Transition = { track, to, reason: reason.trim(), ...(pin && track === "editorial" ? { note_timecode_ms: at } : {}) };
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
        {options.map(value => <label key={value} className={`choice ${to === value ? "selected" : ""}`}><input type="radio" name="target" value={value} checked={to === value} onChange={() => { setTo(value); setArmed(false); setBlurred(false); }} />
          <span><strong>{label(value)}</strong>{(t.consequences as Record<string, string>)[value] && <small className="muted">{(t.consequences as Record<string, string>)[value]}</small>}</span></label>)}
      </fieldset>
      <label>{t.reason}<textarea aria-label={t.reason} required minLength={reasonMin} maxLength={reasonLimits.transition} value={reason} onChange={e => setReason(e.target.value)} aria-describedby="reason-help" /></label>
      <p id="reason-help" className="muted">{t.reasonHelp} <LengthCounter value={reason} max={reasonLimits.transition} /></p>
      {track === "editorial" && to === "published" && !material.files.some(file => file.kind === "produced" && file.state === "verified") && <p className="notice" role="note" data-testid="publish-no-produced">{t.publishNoProduced}</p>}
      {counts && <RevocationNotice locale={locale} counts={counts} />}
      {sensitivePublish && <div className="notice attention" role="note" data-testid="sensitive-publish"><p><strong>{t.sensitivePublish.replace("{flags}", sensitivity.known ? sensitivity.flags.map(flag => m.upload[flag]).join(m.shell.listSeparator) : m.shell.material.sensitivityUnknown)}</strong></p>
        <label className="check"><input type="checkbox" checked={blurred} onChange={e => setBlurred(e.target.checked)} />{t.sensitiveConfirm}</label></div>}
      {track === "editorial" && <label className="check"><input type="checkbox" checked={pin} onChange={e => capture(e.target.checked)} />{t.pinTime}{pin && <span className="time-chip" dir="ltr">{timecode(at)}</span>}</label>}
      {to && (reasonReaches(track, to)
        ? <section className="notification-preview" data-testid="reason-reaches" aria-label={t.previewTitle}><p className="muted">{t.previewTitle}</p><p>{t.previewText.replace("{state}", label(to))}{reason.trim() && <> «<bdi>{reason.trim()}</bdi>»</>}</p></section>
        : <p className="muted" data-testid="reason-stays">{t.reasonStays}</p>)}
      {mutation.status === 412 ? <div className="notice error" role="alert"><p>{t.changed}</p><button type="button" className="secondary" onClick={() => { keep?.({ track, to, reason, pin, at }); reload(); }}>{t.reloadChanges}</button></div> : <ActionStatus status={mutation.status} locale={locale} />}
      <div className="actions"><button type="button" className="secondary" disabled={mutation.busy} onClick={close}>{m.cancel}</button>
        <button className={twice && armed ? "danger" : ""} data-testid="transition-submit" disabled={!valid || mutation.busy || mutation.status === 412}>{mutation.busy ? t.saving : to === "rejected" && armed ? t.confirmReject : revoking && armed ? t.confirmRevoke.replace("{state}", label(to)) : to ? t.confirmTo.replace("{state}", label(to)) : t.apply}</button></div>
      {to === "rejected" && <p className="muted">{t.rejectHelp}</p>}
      {revoking && <p className="muted" data-testid="revoke-help">{t.revokeHelp}</p>}
    </form>
  </dialog>;
}
