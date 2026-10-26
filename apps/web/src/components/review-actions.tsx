"use client";
import { useRef, useState } from "react";
import { browserApi } from "@/lib/browser-api";
import { formatDate, messages, type Locale } from "@/lib/i18n";
import type { Contributor, Material } from "@/lib/types";
import { contributorRoles, hasRole, tracks, transitionOptions, validContributors } from "@/lib/review";
import { useMutation } from "@/lib/use-mutation";
import { useUser } from "./session-boundary";
import { ActionStatus } from "./action-status";
import { TransitionDialog } from "./transition-dialog";

type Props = { locale: Locale; material: Material; tag: string | null; editing: () => void; reload: () => void; notify?: (label: string) => void };
export function ReviewActions(props: Props) {
  const { locale, material, tag, editing, reload, notify } = props, m = messages[locale], t = m.review, me = useUser();
  const available = tracks.filter(track => transitionOptions(material, me, track).length);
  const reservation = useMutation(), [open, setOpen] = useState(false), opener = useRef<HTMLButtonElement>(null);
  const mayReserve = hasRole(me, "producer", "editor_in_chief") && ["accepted", "in_production"].includes(material.editorial_state) && material.reserved_by === null;
  const mayRelease = !!material.reserved_by && (hasRole(me, "supervisor", "editor_in_chief", "system_admin") || hasRole(me, "producer") && material.reserved_by === me.user_id);
  const close = () => { setOpen(false); opener.current?.focus(); };
  return <>
    <section className="card" aria-labelledby="review-title"><div className="page-heading"><h2 id="review-title">{t.title}</h2><button className="secondary" disabled={reservation.busy} onClick={reload}>{t.reload}</button></div>
      <p className="muted">{t.lead}</p>{!tag && <p className="notice">{t.versionMissing}</p>}
      <div className="actions">{available.length ? <button ref={opener} disabled={!tag} onClick={() => { editing(); setOpen(true); }}>{t.open}</button> : <p className="notice">{t.noTransitions}</p>}
        {mayReserve && <button className="secondary" disabled={!tag || reservation.busy || reservation.status === 412} onClick={async () => { editing(); if (tag && await reservation.run(JSON.stringify([material.id, "reserve", tag]), header => browserApi().POST("/materials/{id}/reservation", { params: { path: { id: material.id }, header: { ...header, "If-Match": tag } } }))) reload(); }}>{t.reserve}</button>}
        {mayRelease && <button className="secondary" disabled={reservation.busy} onClick={async () => { editing(); if (await reservation.run(`${material.id}:release`, header => browserApi().DELETE("/materials/{id}/reservation", { params: { path: { id: material.id }, header } }))) reload(); }}>{material.reserved_by === me.user_id ? t.releaseMine : t.release}</button>}</div>
      <p className="muted reservation-state">{t.reservation}: <span>{material.reserved_by === undefined ? m.notAvailable : material.reserved_by === null ? t.unreserved : material.reserved_by === me.user_id ? t.yourReservation : t.reserved}</span>{material.reserved_at && <> · {formatDate(material.reserved_at, locale)}</>}</p>
      <ActionStatus status={reservation.status} locale={locale} />
    </section>
    {open && <TransitionDialog locale={locale} material={material} tag={tag} editing={editing} reload={() => { setOpen(false); reload(); }} onClose={close} onDone={label => { setOpen(false); notify?.(label); }} />}
    <Contributors {...props} />
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
