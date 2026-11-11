"use client";
import { EmptyState, NoAccess } from "./empty-state";
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
import { Icon, type IconName } from "./icon";

type Currency = (typeof currencies)[number];
type PayableState = (typeof payableStates)[number];
export const payoutTone = (state: PayoutRequest["state"]) => state === "paid" ? "good" : ["failed", "rejected", "cancelled"].includes(state) ? "bad" : "";
/** كلمة الحالة بأيقونة ونغمة (لا لون وحده): المصروف ok، والفاشل والمرفوض والملغى danger، وما بينها قيد السير. */
export function payoutWord(state: PayoutRequest["state"]): { tone: "ok" | "danger" | "brand" | "muted"; icon: IconName } {
  return state === "paid" ? { tone: "ok", icon: "check" } : state === "cancelled" ? { tone: "muted", icon: "x" } : ["failed", "rejected"].includes(state) ? { tone: "danger", icon: "alert" } : { tone: "brand", icon: "clock" };
}

/**
 * لافتة المال الثابتة (ADR 0103): نصّ المتجر نفسه (`store.cartPage.sandbox`) ونصّ لوحة المال في الإدارة نفسه (`money.sandbox`، A4 في ADR 0102)،
 * لا صياغة ثالثة. لا تُخفى ولا تُغلق ما دام المزوّد تجريبيًا (قرار المالك 2026-10-21).
 */
export function SandboxBanner({ locale }: { locale: Locale }) {
  const m = messages[locale];
  return <div className="notice attention sandbox-banner" role="note" data-testid="sandbox-banner"><strong>{m.store.cartPage.sandbox}</strong><p>{m.money.sandbox}</p></div>;
}

/** «أرباحي» (ADR 0033، وv2 في ADR 0103): الأرصدة من الدفتر مؤشّراتٍ، وطلب صرف تجريبي بلا بيانات حساب، وطلباتي والكشف بحصّة المراسل وحدها. */
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
  if (!allowed) return <NoAccess locale={locale} me={me} title={t.title} denied={t.denied} />;

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

  return <>
    <div className="page-head"><div><h1>{t.title}</h1><p className="muted">{t.lead}</p></div></div>
    <SandboxBanner locale={locale} />
    {error ? <EmptyState icon="offline" role="alert" title={t.errorTitle} actions={<button type="button" onClick={() => setAttempt(n => n + 1)}>{m.retry}</button>}><p>{t.errorBody}</p></EmptyState>
      : !summary || !payouts ? <><p className="visually-hidden" role="status">{m.loading}</p><div className="kpis" aria-hidden="true">{[0, 1, 2, 3].map(i => <article key={i} className="kpi"><span className="skeleton num" /><span className="skeleton line" /></article>)}</div><span className="skeleton card" aria-hidden="true" /></>
      : <>{!summary.balances.length ? <EmptyState icon="money" testId="earnings-empty" title={t.noBalance}><p>{t.noBalanceBody}</p></EmptyState> : <Balances locale={locale} summary={summary} />}
        <p className="caption earnings-formula">{t.formula}</p>
        <div className="earnings-columns">
          <section className="card" aria-labelledby="payout-title"><h2 id="payout-title">{t.requestTitle}</h2><p className="caption">{t.sandbox}</p>
            {!summary.balances.length ? <p className="muted">{t.nothingToRequest}</p> : <form className="payout-form" noValidate onSubmit={e => { e.preventDefault(); void request(); }}>
              <div className="rule-row"><label>{t.currency}<select value={currency} onChange={e => setCurrency(e.target.value as Currency)}>{summary.balances.map(b => <option key={b.currency} value={b.currency}>{b.currency}</option>)}</select></label>
                <label>{t.amount}<input type="number" min={0} step="0.01" dir="ltr" inputMode="decimal" value={amount} aria-invalid={invalid || undefined} aria-describedby="payout-limits" onChange={e => setAmount(e.target.value)} /></label></div>
              {balance && <p className="muted" id="payout-limits" data-testid="payout-limits">{t.limits.replace("{min}", formatMoney(balance.minimum, locale)).replace("{max}", formatMoney(balance.requestable, locale))}</p>}
              {invalid && <p className="notice error" role="alert">{t.invalid}</p>}
              <ActionStatus status={mutation.status} locale={locale} />{mutation.status === 422 && <p className="notice error">{t.rejected}</p>}
              <div className="actions"><button disabled={mutation.busy || !amount}>{mutation.busy ? m.review.saving : t.request}</button></div>
            </form>}</section>
          <section className="card" aria-labelledby="my-payouts"><h2 id="my-payouts">{t.myRequests}</h2>
            {!payouts.length ? <p className="muted">{t.noRequests}</p> : <div className="list-table"><table><thead><tr>{[t.requestedAt, t.amount, t.state, t.approvals, t.actions].map(label => <th scope="col" key={label} className={label === t.amount ? "num" : undefined}>{label}</th>)}</tr></thead>
              <tbody>{payouts.map(p => { const word = payoutWord(p.state); return <tr key={p.id} data-testid="my-payout-row"><td data-label={t.requestedAt}>{formatDate(p.requested_at, locale)}</td><td data-label={t.amount} className="num"><bdi dir="ltr" className="ref">{formatMoney(p.amount, locale)}</bdi></td>
                <td data-label={t.state}><span className={`badge state ${word.tone}`}><Icon name={word.icon} size={14} />{t.states[p.state]}</span>{p.reason_code && <small className="muted"> {t.reasons[p.reason_code]}</small>}</td>
                <td data-label={t.approvals}><bdi dir="ltr" className="ref">{p.approvals.length}/{p.approvals_required}</bdi></td><td data-label={t.actions} className="cell-action">{cancellable(p) ? <button className="secondary small" disabled={mutation.busy} onClick={() => void cancel(p.id)}>{t.cancel}</button> : <span className="muted" aria-hidden="true">{m.notAvailable}</span>}</td></tr>; })}</tbody></table></div>}
          </section>
        </div>
        <Entries locale={locale} attempt={attempt} /></>}
  </>;
}

/** الأرصدة لكل عملة: أربعة مؤشّرات بأرقام Rubik (المتاح، والقابل للطلب، والمعلّق، والمصروف)، والبقية سطر تحتها. */
export function Balances({ locale, summary }: { locale: Locale; summary: EarningsSummary }) {
  const t = messages[locale].earnings;
  return <div className="balance-list">{summary.balances.map(b => <section key={b.currency} data-testid="balance" aria-label={b.currency} className="balance-block">
    {summary.balances.length > 1 && <h2>{b.currency}</h2>}
    <div className="kpis">{(["available", "requestable", "pending", "paid"] as const).map(key => <article key={key} className="kpi"><strong><bdi dir="ltr">{formatMoney(b[key], locale)}</bdi></strong><span>{t.balance[key]}</span></article>)}</div>
    <dl className="balance-more">{(["reserve", "in_payout", "minimum"] as const).map(key => <div key={key}><dt>{t.balance[key]}</dt><dd><bdi dir="ltr" className="ref">{formatMoney(b[key], locale)}</bdi></dd></div>)}</dl>
  </section>)}
    <p className="caption">{t.asOf} {formatDate(summary.as_of, locale)}</p></div>;
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
    {error ? <p className="notice error" role="alert">{m.error}</p> : !items ? <><p className="visually-hidden" role="status">{m.loading}</p><span className="skeleton block" aria-hidden="true" /><span className="skeleton block" aria-hidden="true" /></> : !items.length ? <p className="muted">{t.noEntries}</p>
      : <><div className="list-table"><table><thead><tr>{[t.occurredAt, t.kind, t.state, t.amount].map(label => <th scope="col" key={label} className={label === t.amount ? "num" : undefined}>{label}</th>)}</tr></thead>
        <tbody>{items.map(e => <tr key={e.id} data-testid="entry-row"><td data-label={t.occurredAt}>{formatDate(e.occurred_at, locale)}</td><td data-label={t.kind}>{t.kinds[e.kind]}</td><td data-label={t.state}>{t.payable[e.state]}</td><td data-label={t.amount} className="num"><bdi dir="ltr" className="ref">{formatMoney(e.amount, locale)}</bdi></td></tr>)}</tbody></table></div>
        {cursor && <div className="pagination"><button className="secondary" onClick={() => void more()}>{m.next}</button></div>}</>}
  </section>;
}
