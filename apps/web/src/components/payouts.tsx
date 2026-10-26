"use client";
import { useEffect, useState } from "react";
import { browserApi, dataOrThrow } from "@/lib/browser-api";
import { formatDate, messages, type Locale } from "@/lib/i18n";
import { hasRole } from "@/lib/review";
import { useMutation } from "@/lib/use-mutation";
import { formatMoney } from "@/lib/store-format";
import { currencies } from "@/lib/license-policy";
import { approvable, earningsLimits, payoutReasons, payoutStaff, payoutStates, policyInput, policyWriters, rejectable, type EarningsSummary, type PayoutPolicy, type PayoutPolicyInput, type PayoutRequest } from "@/lib/earnings-policy";
import { useUser } from "./session-boundary";
import { ActionStatus } from "./action-status";
import { Balances, payoutTone } from "./earnings";

type State = PayoutRequest["state"];
type Reason = (typeof payoutReasons)[number];

/** طلبات الصرف للمالية ومدير النظام: الاعتماد (مرة لكل معتمد، لا لصاحب الطلب) والرفض بسبب مرمّز، وأرصدة المساهم. */
export function PayoutsPage({ locale }: { locale: Locale }) {
  const m = messages[locale], t = m.payouts, e = m.earnings, me = useUser(), allowed = hasRole(me, ...payoutStaff), mutation = useMutation();
  const [state, setState] = useState<State | "">("requested"), [items, setItems] = useState<PayoutRequest[] | null>(null), [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState(false), [attempt, setAttempt] = useState(0), [reasons, setReasons] = useState<Record<string, Reason | "">>({});
  const [balances, setBalances] = useState<EarningsSummary | null>(null);
  useEffect(() => {
    if (!allowed) return;
    const controller = new AbortController();
    void browserApi().GET("/payout-requests", { params: { query: state ? { state } : {} }, signal: controller.signal }).then(dataOrThrow).then(data => { if (!controller.signal.aborted) { setItems(data.items); setCursor(data.next_cursor); setError(false); } }).catch(() => { if (!controller.signal.aborted) setError(true); });
    return () => controller.abort();
  }, [allowed, state, attempt]);
  if (!allowed || !me) return <section className="center-state"><h1>{t.title}</h1><p role="alert">{t.denied}</p></section>;

  async function more() {
    if (!cursor) return;
    try { const data = dataOrThrow(await browserApi().GET("/payout-requests", { params: { query: { ...(state ? { state } : {}), cursor } } })); setItems(list => [...(list ?? []), ...data.items]); setCursor(data.next_cursor); } catch { setError(true); }
  }
  async function approve(id: string) {
    const ok = await mutation.run(`approve:${id}`, header => browserApi().POST("/payout-requests/{payout_request_id}/approve", { params: { path: { payout_request_id: id }, header } }));
    if (ok) setAttempt(n => n + 1);
  }
  async function reject(id: string) {
    const reason = reasons[id]; if (!reason) return;
    const ok = await mutation.run(`reject:${id}:${reason}`, header => browserApi().POST("/payout-requests/{payout_request_id}/reject", { params: { path: { payout_request_id: id }, header }, body: { reason_code: reason } }));
    if (ok) setAttempt(n => n + 1);
  }
  async function showBalances(user: string) {
    setBalances(null);
    try { setBalances(dataOrThrow(await browserApi().GET("/users/{id}/earnings", { params: { path: { id: user } } }))); } catch { setError(true); }
  }

  return <><div className="page-heading"><div><h1>{t.title}</h1><p className="muted">{t.lead}</p><p className="notice">{e.sandbox}</p></div></div>
    <ActionStatus status={mutation.status} locale={locale} />{mutation.status === 409 && <p className="notice error">{t.conflict}</p>}
    <label>{e.state}<select value={state} onChange={ev => { setItems(null); setState(ev.target.value as State | ""); }}><option value="">{m.all}</option>{payoutStates.map(s => <option key={s} value={s}>{e.states[s]}</option>)}</select></label>
    {error ? <section className="center-state" role="alert"><p>{m.error}</p><button onClick={() => setAttempt(n => n + 1)}>{m.retry}</button></section>
      : !items ? <p className="center-state" role="status">{m.loading}</p> : !items.length ? <p className="empty">{t.empty}</p>
      : <><div className="table-panel"><div className="table-scroll"><table><thead><tr>{[e.requestedAt, t.contributor, e.amount, e.state, e.approvals, ""].map((label, i) => <th scope="col" key={i}>{label}</th>)}</tr></thead>
        <tbody>{items.map(p => <tr key={p.id} data-testid="payout-row"><td>{formatDate(p.requested_at, locale)}</td>
          <td><button className="quiet" onClick={() => void showBalances(p.user_id)}><bdi dir="ltr">{p.user_id.slice(0, 8)}</bdi> · {t.balances}</button></td>
          <td dir="ltr">{formatMoney(p.amount, locale)}</td><td><span className={`badge ${payoutTone(p.state)}`}>{e.states[p.state]}</span>{p.reason_code && <small className="muted"> {e.reasons[p.reason_code]}</small>}</td>
          <td>{p.approvals.length}/{p.approvals_required}{p.approvals_required === 2 && <small className="muted"> {t.dual}</small>}</td>
          <td><div className="actions">{approvable(p, me.user_id) && <button disabled={mutation.busy} onClick={() => void approve(p.id)}>{t.approve}</button>}
            {p.user_id === me.user_id && p.state === "requested" && <small className="muted">{t.ownRequest}</small>}
            {rejectable(p) && <><select aria-label={t.reason} value={reasons[p.id] ?? ""} onChange={ev => setReasons(r => ({ ...r, [p.id]: ev.target.value as Reason | "" }))}><option value="">{t.reason}</option>{payoutReasons.map(code => <option key={code} value={code}>{e.reasons[code]}</option>)}</select>
              <button className="danger" disabled={mutation.busy || !reasons[p.id]} onClick={() => void reject(p.id)}>{t.reject}</button></>}</div></td></tr>)}</tbody></table></div></div>
        {cursor && <button className="secondary" onClick={() => void more()}>{m.next}</button>}</>}
    {balances && <section className="card" aria-labelledby="contributor-balances"><h2 id="contributor-balances">{t.balancesOf} <bdi dir="ltr">{balances.user_id.slice(0, 8)}</bdi></h2>
      {balances.balances.length ? <Balances locale={locale} summary={balances} /> : <p className="muted">{e.noBalance}</p>}</section>}
    <PayoutPolicies locale={locale} />
  </>;
}

function PayoutPolicies({ locale }: { locale: Locale }) {
  const m = messages[locale], t = m.payouts, me = useUser(), writer = hasRole(me, ...policyWriters), mutation = useMutation();
  const [items, setItems] = useState<PayoutPolicy[] | null>(null), [error, setError] = useState(false), [attempt, setAttempt] = useState(0), [checkedAt, setCheckedAt] = useState(0);
  const [draft, setDraft] = useState<{ currency: (typeof currencies)[number]; minimum: string; dual: string; reserve: string; from: string } | null>(null), [invalid, setInvalid] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void browserApi().GET("/payout-policies", { signal: controller.signal }).then(dataOrThrow).then(data => { if (!controller.signal.aborted) { setItems(data.items); setCheckedAt(Date.now()); setError(false); } }).catch(() => { if (!controller.signal.aborted) setError(true); });
    return () => controller.abort();
  }, [attempt]);
  async function save() {
    if (!draft) return;
    const at = Date.parse(draft.from), minor = (v: string) => Math.round(Number(v) * 100);
    const input = policyInput({ currency: draft.currency, minimum: { amount_minor: minor(draft.minimum), currency: draft.currency }, dual_approval_above: { amount_minor: minor(draft.dual), currency: draft.currency }, reserve_bps: Math.round(Number(draft.reserve) * 100), effective_from: Number.isFinite(at) ? new Date(at).toISOString() : "" });
    if (!input || draft.minimum === "" || draft.dual === "" || draft.reserve === "") { setInvalid(true); return; }
    setInvalid(false);
    const body: PayoutPolicyInput = input;
    const ok = await mutation.run(JSON.stringify(body), header => browserApi().POST("/payout-policies", { params: { header }, body }));
    if (ok) { setDraft(null); setAttempt(n => n + 1); }
  }
  // السارية لكل عملة: أحدث effective_from لا يتجاوز لحظة القراءة.
  const current = new Set(currencies.map(c => (items ?? []).filter(p => p.currency === c && Date.parse(p.effective_from) <= checkedAt).sort((a, b) => Date.parse(b.effective_from) - Date.parse(a.effective_from))[0]?.id).filter(Boolean));
  return <section className="card" aria-labelledby="policies-title"><h2 id="policies-title">{t.policies}</h2><p className="muted">{t.policiesLead}</p>
    {error ? <p role="alert">{m.error}</p> : !items ? <p role="status">{m.loading}</p> : !items.length ? <p className="muted">{t.noPolicies}</p>
      : <div className="table-scroll"><table><thead><tr>{[t.currency, t.minimum, t.dualAbove, t.reserve, t.effectiveFrom, ""].map((label, i) => <th scope="col" key={i}>{label}</th>)}</tr></thead>
        <tbody>{items.map(p => <tr key={p.id} data-testid="policy-row"><td>{p.currency}</td><td dir="ltr">{formatMoney(p.minimum, locale)}</td><td dir="ltr">{formatMoney(p.dual_approval_above, locale)}</td><td>{p.reserve_bps / 100}%</td><td>{formatDate(p.effective_from, locale)}</td>
          <td><span className={`badge ${current.has(p.id) ? "good" : ""}`}>{current.has(p.id) ? t.current : Date.parse(p.effective_from) > checkedAt ? t.scheduled : t.superseded}</span></td></tr>)}</tbody></table></div>}
    {!writer ? <p className="muted">{t.policyReadOnly}</p> : !draft ? <button className="secondary" onClick={() => { mutation.clearStatus(); setInvalid(false); setDraft({ currency: "USD", minimum: "50", dual: "1000", reserve: "10", from: "" }); }}>{t.newPolicy}</button>
      : <form className="rule-form" noValidate onSubmit={ev => { ev.preventDefault(); void save(); }}><p className="notice">{t.appendOnly}</p>
        <div className="rule-row"><label>{t.currency}<select value={draft.currency} onChange={ev => setDraft({ ...draft, currency: ev.target.value as (typeof currencies)[number] })}>{currencies.map(c => <option key={c} value={c}>{c}</option>)}</select></label>
          <label>{t.minimum}<input type="number" min={0} step="0.01" dir="ltr" value={draft.minimum} onChange={ev => setDraft({ ...draft, minimum: ev.target.value })} /></label>
          <label>{t.dualAbove}<input type="number" min={0} step="0.01" dir="ltr" value={draft.dual} onChange={ev => setDraft({ ...draft, dual: ev.target.value })} /></label>
          <label>{t.reserve}<input type="number" min={0} max={earningsLimits.reserveMax / 100} step="0.01" dir="ltr" value={draft.reserve} onChange={ev => setDraft({ ...draft, reserve: ev.target.value })} /></label></div>
        <label>{t.effectiveFrom}<input type="datetime-local" dir="ltr" value={draft.from} onChange={ev => setDraft({ ...draft, from: ev.target.value })} /></label>
        {invalid && <p className="notice error" role="alert">{t.invalid}</p>}
        <ActionStatus status={mutation.status} locale={locale} />
        <div className="actions"><button disabled={mutation.busy}>{mutation.busy ? m.review.saving : t.savePolicy}</button><button type="button" className="secondary" disabled={mutation.busy} onClick={() => setDraft(null)}>{m.cancel}</button></div>
      </form>}
  </section>;
}
