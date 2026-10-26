"use client";
import { useEffect, useState } from "react";
import { browserApi, dataOrThrow } from "@/lib/browser-api";
import { formatDate, messages, type Locale } from "@/lib/i18n";
import { hasRole } from "@/lib/review";
import { useMutation } from "@/lib/use-mutation";
import { conflictRoles, conflictStates, nextStates, type InviteConflict, type InviteConflictResolve } from "@/lib/invite-conflict-policy";
import { useUser } from "./session-boundary";
import { ActionStatus } from "./action-status";

type State = InviteConflict["state"];
type Pending = { conflict: InviteConflict; state: InviteConflictResolve["state"] };

/** طابور تعارض الدعوات لمدير النظام: الحسم بالحالة وحدها وبرمز TOTP حاضر، ولا نص حر. الرمز في الذاكرة حتى الإرسال ثم يُمحى. */
export function InviteConflicts({ locale }: { locale: Locale }) {
  const m = messages[locale], t = m.conflicts, me = useUser(), allowed = hasRole(me, ...conflictRoles), mutation = useMutation();
  const [state, setState] = useState<State | "">("pending"), [items, setItems] = useState<InviteConflict[] | null>(null), [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState(false), [attempt, setAttempt] = useState(0), [pending, setPending] = useState<Pending | null>(null), [code, setCode] = useState("");
  useEffect(() => {
    if (!allowed) return;
    const controller = new AbortController();
    void browserApi().GET("/buyer-invite-conflicts", { params: { query: state ? { state } : {} }, signal: controller.signal }).then(dataOrThrow).then(data => { if (!controller.signal.aborted) { setItems(data.items); setCursor(data.next_cursor); setError(false); } }).catch(() => { if (!controller.signal.aborted) setError(true); });
    return () => controller.abort();
  }, [allowed, state, attempt]);
  if (!allowed) return <section className="center-state"><h1>{t.title}</h1><p role="alert">{t.denied}</p></section>;

  async function more() {
    if (!cursor) return;
    try {
      const data = dataOrThrow(await browserApi().GET("/buyer-invite-conflicts", { params: { query: { ...(state ? { state } : {}), cursor } } }));
      setItems(list => [...(list ?? []), ...data.items]); setCursor(data.next_cursor);
    } catch { setError(true); }
  }
  async function resolve() {
    if (!pending || !/^[0-9]{6}$/.test(code)) return;
    const body: InviteConflictResolve = { state: pending.state, totp_code: code }, id = pending.conflict.id;
    const ok = await mutation.run(`${id}:${pending.state}`, header => browserApi().POST("/buyer-invite-conflicts/{conflict_id}/resolve", { params: { path: { conflict_id: id }, header }, body }));
    setCode("");
    if (ok) { setPending(null); setAttempt(n => n + 1); }
  }
  const close = () => { setPending(null); setCode(""); mutation.clearStatus(); };

  return <><div className="page-heading"><div><h1>{t.title}</h1><p className="muted">{t.lead}</p></div></div>
    {!pending && <ActionStatus status={mutation.status} locale={locale} />}
    <label>{t.state}<select value={state} onChange={e => { setItems(null); setState(e.target.value as State | ""); }}><option value="">{m.all}</option>{conflictStates.map(s => <option key={s} value={s}>{t.states[s]}</option>)}</select></label>
    {error ? <section className="center-state" role="alert"><p>{m.error}</p><button onClick={() => setAttempt(n => n + 1)}>{m.retry}</button></section>
      : !items ? <p className="center-state" role="status">{m.loading}</p>
      : !items.length ? <p className="empty">{t.empty}</p>
      : <><div className="table-panel"><div className="table-scroll"><table><thead><tr>{[t.email, t.organization, t.role, t.state, t.created, t.expires, ""].map((label, i) => <th scope="col" key={i}>{label}</th>)}</tr></thead>
        <tbody>{items.map(item => <tr key={item.id} data-testid="conflict-row"><td><bdi dir="ltr">{item.email}</bdi></td><td><bdi dir="ltr">{item.organization_id}</bdi></td><td>{m.buyers.roles[item.role]}</td>
          <td><span className={`badge ${item.state === "pending" ? "" : item.state === "dismissed" ? "good" : "bad"}`}>{t.states[item.state]}</span>{item.resolved_at && <small className="muted"> {formatDate(item.resolved_at, locale)}</small>}</td>
          <td>{formatDate(item.created_at, locale)}</td><td>{formatDate(item.invite_expires_at, locale)}</td>
          <td><div className="actions">{nextStates(item.state).map(next => <button key={next} className={next === "dismissed" ? "danger" : "secondary"} onClick={() => { mutation.clearStatus(); setCode(""); setPending({ conflict: item, state: next }); }}>{t.actions[next]}</button>)}</div></td></tr>)}</tbody></table></div></div>
        {cursor && <button className="secondary" onClick={() => void more()}>{m.next}</button>}</>}
    {pending && <dialog className="modal" ref={node => { if (node && !node.open) node.showModal(); }} onCancel={close} aria-labelledby="conflict-title">
      <form noValidate onSubmit={e => { e.preventDefault(); void resolve(); }}>
        <h2 id="conflict-title">{t.actions[pending.state]}</h2>
        <p><bdi dir="ltr">{pending.conflict.email}</bdi></p><p className="muted">{t.effects[pending.state]}</p>
        <label>{m.totp}<input autoFocus inputMode="numeric" dir="ltr" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} value={code} onChange={e => setCode(e.target.value.replace(/\D/g, ""))} /></label>
        {mutation.status === 422 && <p className="notice error" role="alert">{t.totpRejected}</p>}
        {mutation.status === 409 && <p className="notice error" role="alert">{t.conflict}</p>}
        {![0, 409, 422].includes(mutation.status) && <ActionStatus status={mutation.status} locale={locale} />}
        <div className="actions"><button type="button" className="secondary" disabled={mutation.busy} onClick={close}>{m.cancel}</button><button className={pending.state === "dismissed" ? "danger" : ""} disabled={mutation.busy || code.length !== 6}>{mutation.busy ? m.review.saving : m.confirm}</button></div>
      </form>
    </dialog>}
  </>;
}
