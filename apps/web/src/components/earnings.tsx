"use client";
import { useEffect, useState } from "react";
import { browserApi, dataOrThrow } from "@/lib/browser-api";
import { formatDate, messages, type Locale } from "@/lib/i18n";
import { hasRole } from "@/lib/review";
import { useMutation } from "@/lib/use-mutation";
import { formatMoney } from "@/lib/store-format";
import { currencies } from "@/lib/license-policy";
import { cancellable, earnerRoles, payableStates, payoutCreate, type EarningsEntry, type EarningsSummary, type PayoutRequest } from "@/lib/earnings-policy";
import { useUser } from "./session-boundary";
import { ActionStatus } from "./action-status";

type Currency = (typeof currencies)[number];
type PayableState = (typeof payableStates)[number];
export const payoutTone = (state: PayoutRequest["state"]) => state === "paid" ? "good" : ["failed", "rejected", "cancelled"].includes(state) ? "bad" : "";

/** أرباح المراسل (ADR 0033): الأرصدة محسوبة من الدفتر، وطلب صرف تجريبي بلا بيانات حساب، والكشف بحصته وحدها. */
export function EarningsPage({ locale }: { locale: Locale }) {
  const m = messages[locale], t = m.earnings, me = useUser(), allowed = hasRole(me, ...earnerRoles), mutation = useMutation();
  const [summary, setSummary] = useState<EarningsSummary | null>(null), [payouts, setPayouts] = useState<PayoutRequest[] | null>(null), [error, setError] = useState(false), [attempt, setAttempt] = useState(0);
  const [currency, setCurrency] = useState<Currency>("USD"), [amount, setAmount] = useState(""), [invalid, setInvalid] = useState(false);
  useEffect(() => {
    if (!allowed) return;
    const controller = new AbortController(), signal = controller.signal;
    void Promise.all([browserApi().GET("/me/earnings", { signal }).then(dataOrThrow), browserApi().GET("/me/payout-requests", { signal }).then(dataOrThrow)])
      .then(([s, p]) => { if (!signal.aborted) { setSummary(s); setPayouts(p.items); setError(false); setCurrency(current => s.balances[0] && !s.balances.some(b => b.currency === current) ? s.balances[0].currency : current); } })
      .catch(() => { if (!signal.aborted) setError(true); });
    return () => controller.abort();
  }, [allowed, attempt]);
  if (!allowed) return <section className="center-state"><h1>{t.title}</h1><p role="alert">{t.denied}</p></section>;

  const balance = summary?.balances.find(b => b.currency === currency);
  async function request() {
    const minor = Math.round(Number(amount) * 100), input = payoutCreate({ amount: { amount_minor: minor, currency }, channel: "sandbox" });
    if (!input || !balance || minor < balance.minimum.amount_minor || minor > balance.requestable.amount_minor) { setInvalid(true); return; }
    setInvalid(false);
    const ok = await mutation.run(JSON.stringify(input), header => browserApi().POST("/me/payout-requests", { params: { header }, body: input }));
    if (ok) { setAmount(""); setAttempt(n => n + 1); }
  }
  async function cancel(id: string) {
    const ok = await mutation.run(`cancel:${id}`, header => browserApi().POST("/payout-requests/{payout_request_id}/cancel", { params: { path: { payout_request_id: id }, header } }));
    if (ok) setAttempt(n => n + 1);
  }

  return <><div className="page-heading"><div><h1>{t.title}</h1><p className="muted">{t.lead}</p></div></div>
    {error ? <section className="center-state" role="alert"><p>{m.error}</p><button onClick={() => setAttempt(n => n + 1)}>{m.retry}</button></section>
      : !summary || !payouts ? <p className="center-state" role="status">{m.loading}</p>
      : <>{!summary.balances.length ? <p className="empty">{t.noBalance}</p> : <Balances locale={locale} summary={summary} />}
        <section className="card" aria-labelledby="payout-title"><h2 id="payout-title">{t.requestTitle}</h2><p className="notice">{t.sandbox}</p>
          {!summary.balances.length ? <p className="muted">{t.nothingToRequest}</p> : <form className="rule-form" noValidate onSubmit={e => { e.preventDefault(); void request(); }}>
            <div className="rule-row"><label>{t.currency}<select value={currency} onChange={e => setCurrency(e.target.value as Currency)}>{summary.balances.map(b => <option key={b.currency} value={b.currency}>{b.currency}</option>)}</select></label>
              <label>{t.amount}<input type="number" min={0} step="0.01" dir="ltr" value={amount} onChange={e => setAmount(e.target.value)} /></label></div>
            {balance && <p className="muted" data-testid="payout-limits">{t.limits.replace("{min}", formatMoney(balance.minimum, locale)).replace("{max}", formatMoney(balance.requestable, locale))}</p>}
            {invalid && <p className="notice error" role="alert">{t.invalid}</p>}
            <ActionStatus status={mutation.status} locale={locale} />{mutation.status === 422 && <p className="notice error">{t.rejected}</p>}
            <div className="actions"><button disabled={mutation.busy || !amount}>{mutation.busy ? m.review.saving : t.request}</button></div>
          </form>}</section>
        <section className="card" aria-labelledby="my-payouts"><h2 id="my-payouts">{t.myRequests}</h2>
          {!payouts.length ? <p className="muted">{t.noRequests}</p> : <div className="table-scroll"><table><thead><tr>{[t.requestedAt, t.amount, t.state, t.approvals, ""].map((label, i) => <th scope="col" key={i}>{label}</th>)}</tr></thead>
            <tbody>{payouts.map(p => <tr key={p.id} data-testid="my-payout-row"><td>{formatDate(p.requested_at, locale)}</td><td dir="ltr">{formatMoney(p.amount, locale)}</td>
              <td><span className={`badge ${payoutTone(p.state)}`}>{t.states[p.state]}</span>{p.reason_code && <small className="muted"> {t.reasons[p.reason_code]}</small>}</td>
              <td>{p.approvals.length}/{p.approvals_required}</td><td>{cancellable(p) && <button className="secondary" disabled={mutation.busy} onClick={() => void cancel(p.id)}>{t.cancel}</button>}</td></tr>)}</tbody></table></div>}
        </section>
        <Entries locale={locale} attempt={attempt} /></>}
  </>;
}

export function Balances({ locale, summary }: { locale: Locale; summary: EarningsSummary }) {
  const t = messages[locale].earnings;
  return <div className="balance-grid">{summary.balances.map(b => <section key={b.currency} className="card" data-testid="balance" aria-label={b.currency}><h2>{b.currency}</h2>
    <dl className="metadata">{([["available", b.available], ["requestable", b.requestable], ["reserve", b.reserve], ["pending", b.pending], ["in_payout", b.in_payout], ["paid", b.paid], ["minimum", b.minimum]] as const).map(([key, value]) =>
      <div key={key}><dt>{t.balance[key]}</dt><dd dir="ltr">{formatMoney(value, locale)}</dd></div>)}</dl></section>)}
    <p className="muted">{t.asOf} {formatDate(summary.as_of, locale)}</p></div>;
}

function Entries({ locale, attempt }: { locale: Locale; attempt: number }) {
  const m = messages[locale], t = m.earnings;
  const [items, setItems] = useState<EarningsEntry[] | null>(null), [cursor, setCursor] = useState<string | null>(null), [error, setError] = useState(false);
  const [currency, setCurrency] = useState<Currency | "">(""), [state, setState] = useState<PayableState | "">("");
  const filters = { ...(currency ? { currency } : {}), ...(state ? { state } : {}) };
  useEffect(() => {
    const controller = new AbortController();
    void browserApi().GET("/me/earnings/entries", { params: { query: { ...(currency ? { currency } : {}), ...(state ? { state } : {}) } }, signal: controller.signal }).then(dataOrThrow).then(data => { if (!controller.signal.aborted) { setItems(data.items); setCursor(data.next_cursor); setError(false); } }).catch(() => { if (!controller.signal.aborted) setError(true); });
    return () => controller.abort();
  }, [currency, state, attempt]);
  async function more() {
    if (!cursor) return;
    try { const data = dataOrThrow(await browserApi().GET("/me/earnings/entries", { params: { query: { ...filters, cursor } } })); setItems(list => [...(list ?? []), ...data.items]); setCursor(data.next_cursor); } catch { setError(true); }
  }
  return <section className="card" aria-labelledby="entries-title"><h2 id="entries-title">{t.entries}</h2><p className="muted">{t.entriesLead}</p>
    <div className="rule-row"><label>{t.currency}<select value={currency} onChange={e => { setItems(null); setCurrency(e.target.value as Currency | ""); }}><option value="">{m.all}</option>{currencies.map(c => <option key={c} value={c}>{c}</option>)}</select></label>
      <label>{t.state}<select value={state} onChange={e => { setItems(null); setState(e.target.value as PayableState | ""); }}><option value="">{m.all}</option>{payableStates.map(s => <option key={s} value={s}>{t.payable[s]}</option>)}</select></label></div>
    {error ? <p role="alert">{m.error}</p> : !items ? <p role="status">{m.loading}</p> : !items.length ? <p className="muted">{t.noEntries}</p>
      : <><div className="table-scroll"><table><thead><tr>{[t.occurredAt, t.kind, t.state, t.amount].map(label => <th scope="col" key={label}>{label}</th>)}</tr></thead>
        <tbody>{items.map(e => <tr key={e.id} data-testid="entry-row"><td>{formatDate(e.occurred_at, locale)}</td><td>{t.kinds[e.kind]}</td><td>{t.payable[e.state]}</td><td dir="ltr">{formatMoney(e.amount, locale)}</td></tr>)}</tbody></table></div>
        {cursor && <button className="secondary" onClick={() => void more()}>{m.next}</button>}</>}
  </section>;
}
