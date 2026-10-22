"use client";
import { useEffect, useState } from "react";
import { browserApi, dataOrThrow } from "@/lib/browser-api";
import { formatDate, messages, type Locale } from "@/lib/i18n";
import type { Contributor, Material, Transition, TransitionRecord } from "@/lib/types";
import { contributorRoles, hasRole, stateColumn, tracks, transitionOptions, validContributors } from "@/lib/review";
import { useMutation } from "@/lib/use-mutation";
import { useUser } from "./session-boundary";
import { ActionStatus } from "./action-status";
import { StateBadge } from "./states";
import { reasonLimits } from "@/lib/admin-policy";

type Props = { locale: Locale; material: Material; tag: string | null; editing: () => void; reload: () => void };
export function ReviewActions(props: Props) {
  const { locale, material, tag, editing, reload } = props, m = messages[locale], t = m.review, me = useUser();
  const available = tracks.filter(track => transitionOptions(material, me, track).length);
  const [track, setTrack] = useState<Transition["track"]>(available[0] ?? "editorial"), [to, setTo] = useState(""), [reason, setReason] = useState(""), [timecode, setTimecode] = useState("");
  const mutation = useMutation(), reservation = useMutation();
  const options = transitionOptions(material, me, track), blocked = !tag || mutation.busy || mutation.status === 412;
  const mayReserve = hasRole(me, "producer", "editor_in_chief") && ["accepted", "in_production"].includes(material.editorial_state) && material.reserved_by === null;
  const mayRelease = !!material.reserved_by && (hasRole(me, "supervisor", "editor_in_chief", "system_admin") || hasRole(me, "producer") && material.reserved_by === me.user_id);
  return <>
    <section className="card" aria-labelledby="review-title"><div className="page-heading"><h2 id="review-title">{t.title}</h2><button className="secondary" disabled={mutation.busy || reservation.busy} onClick={reload}>{t.reload}</button></div>
      <p className="muted">{t.lead}</p>{!tag && <p className="notice">{t.versionMissing}</p>}
      {available.length ? <form className="action-form" onChange={editing} onSubmit={async event => {
        event.preventDefault(); editing(); if (!tag || !options.includes(to)) return;
        const body: Transition = { track, to, reason, ...(timecode ? { note_timecode_ms: Number(timecode) } : {}) };
        if (await mutation.run(JSON.stringify([material.id, tag, body]), header => browserApi().POST("/materials/{id}/transitions", { params: { path: { id: material.id }, header: { ...header, "If-Match": tag } }, body }))) reload();
      }}>
        <fieldset disabled={blocked}><div className="field-grid"><label>{t.track}<select aria-label={t.track} value={track} onChange={e => { setTrack(e.target.value as Transition["track"]); setTo(""); }}>{available.map(key => <option key={key} value={key}>{m[key]}</option>)}</select></label>
          <label>{t.target}<select aria-label={t.target} required value={to} onChange={e => setTo(e.target.value)}><option value="">{m.choose}</option>{options.map(value => <option key={value} value={value}>{(m.states[stateColumn[track]] as Record<string, string>)[value]}</option>)}</select></label></div>
          <label>{t.reason}<textarea aria-label={t.reason} required maxLength={reasonLimits.transition} value={reason} onChange={e => setReason(e.target.value)} /></label><p className="muted">{t.reasonHelp}</p>
          <label>{t.timecode}<input type="number" min="0" step="1" value={timecode} onChange={e => setTimecode(e.target.value)} /></label>
          <button disabled={!reason.trim() || !to}>{mutation.busy ? t.saving : t.apply}</button></fieldset>
      </form> : <p className="notice">{t.noTransitions}</p>}
      <ActionStatus status={mutation.status} locale={locale} />
      <div className="reservation"><h3>{t.reservation}</h3><p className="muted">{material.reserved_by === undefined ? m.notAvailable : material.reserved_by === null ? t.unreserved : material.reserved_by === me.user_id ? t.yourReservation : t.reserved}</p>{material.reserved_at && <p>{formatDate(material.reserved_at, locale)}</p>}
        <div className="actions">{mayReserve && <button disabled={!tag || reservation.busy || reservation.status === 412} onClick={async () => { editing(); if (tag && await reservation.run(JSON.stringify([material.id, "reserve", tag]), header => browserApi().POST("/materials/{id}/reservation", { params: { path: { id: material.id }, header: { ...header, "If-Match": tag } } }))) reload(); }}>{t.reserve}</button>}
          {mayRelease && <button className="secondary" disabled={reservation.busy} onClick={async () => { editing(); if (await reservation.run(`${material.id}:release`, header => browserApi().DELETE("/materials/{id}/reservation", { params: { path: { id: material.id }, header } }))) reload(); }}>{t.release}</button>}</div>
        <ActionStatus status={reservation.status} locale={locale} />
      </div>
    </section>
    <Contributors {...props} /><TransitionHistory locale={locale} id={material.id} />
  </>;
}
function Contributors({ locale, material, tag, editing, reload }: Props) {
  const m = messages[locale], t = m.review, me = useUser(), mutation = useMutation();
  const [rows, setRows] = useState<Contributor[]>(material.contributors?.map(row => ({ ...row })) ?? []);
  const editable = hasRole(me, "rights_officer", "system_admin"), valid = validContributors(rows);
  function update(index: number, patch: Partial<Contributor>) { editing(); setRows(old => old.map((row, i) => i === index ? { ...row, ...patch } : row)); }
  return <section className="card" aria-labelledby="contributors-title"><h2 id="contributors-title">{t.contributors}</h2>
    {material.contributors === undefined && <p className="notice">{t.contributorsMissing}</p>}
    <form className="action-form" onSubmit={async event => { event.preventDefault(); editing(); if (!tag || !valid) return;
      const body = { contributors: rows }; if (await mutation.run(JSON.stringify([material.id, tag, body]), header => browserApi().PUT("/materials/{id}/contributors", { params: { path: { id: material.id }, header: { ...header, "If-Match": tag } }, body }))) reload();
    }}><fieldset disabled={!editable || !tag || mutation.busy || mutation.status === 412}>
      {rows.map((row, i) => <div className="contributor-row" key={i}><label>{t.userId}<input required dir="ltr" value={row.user_id} onChange={e => update(i, { user_id: e.target.value })} /></label><label>{t.role}<select aria-label={t.role} value={row.role} onChange={e => update(i, { role: e.target.value as Contributor["role"] })}>{contributorRoles.map(role => <option value={role} key={role}>{t.roles[role]}</option>)}</select></label><label>{t.share}<input required type="number" min="0" max="100" step="0.01" value={Number.isNaN(row.share_percent) ? "" : row.share_percent} onChange={e => update(i, { share_percent: e.target.value === "" ? NaN : Number(e.target.value) })} /></label>{editable && <button className="secondary" type="button" onClick={() => { editing(); setRows(old => old.filter((_, index) => index !== i)); }}>{t.remove}</button>}</div>)}
      {!rows.length && <p className="muted">{t.noContributors}</p>}
      {editable && <><p className="notice">{t.shareHelp}</p><div className="actions"><button type="button" className="secondary" onClick={() => { editing(); setRows(old => [...old, { user_id: "", role: "photographer", share_percent: 0 }]); }}>{t.add}</button><button disabled={!valid}>{t.saveContributors}</button></div></>}
    </fieldset></form><ActionStatus status={mutation.status} locale={locale} /></section>;
}
function TransitionHistory({ locale, id }: { locale: Locale; id: string }) {
  const m = messages[locale], [items, setItems] = useState<TransitionRecord[] | null>(null), [failed, setFailed] = useState(false);
  useEffect(() => { const controller = new AbortController(); void browserApi().GET("/materials/{id}/transitions", { params: { path: { id } }, signal: controller.signal }).then(result => { const data = dataOrThrow(result); if (!controller.signal.aborted) setItems(data.items); }).catch(() => { if (!controller.signal.aborted) setFailed(true); }); return () => controller.abort(); }, [id]);
  return <section className="card"><h2>{m.review.history}</h2>{failed ? <p role="alert">{m.error}</p> : items === null ? <p>{m.loading}</p> : !items.length ? <p className="muted">{m.review.noHistory}</p> : <ol className="history-list">{items.map(item => <li key={item.id}>{tracks.includes(item.track) && <><strong>{m[item.track]}</strong><div className="actions"><StateBadge track={stateColumn[item.track]} value={item.from as Material[typeof stateColumn[typeof item.track]]} locale={locale} /><span>{m.review.to}</span><StateBadge track={stateColumn[item.track]} value={item.to as Material[typeof stateColumn[typeof item.track]]} locale={locale} /></div></>}{item.reason && <blockquote className="supervisor-note"><p>{m.review.note}: {item.reason}</p></blockquote>}<p>{formatDate(item.occurred_at, locale)}</p><p className="muted">{m.review.actor}: <bdi>{item.actor_id ?? m.notAvailable}</bdi></p></li>)}</ol>}</section>;
}
