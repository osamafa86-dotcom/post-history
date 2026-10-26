"use client";
import { useEffect, useState } from "react";
import { browserApi, dataOrThrow } from "@/lib/browser-api";
import { formatDate, messages, type Locale } from "@/lib/i18n";
import { hasRole } from "@/lib/review";
import { useMutation } from "@/lib/use-mutation";
import { formatMoney, localized } from "@/lib/store-format";
import type { Order } from "@/lib/order-policy";
import { refundable, refundReaders, refundReasons, refundWriters, type Refund, type RefundCreate } from "@/lib/refund-policy";
import { useUser } from "../session-boundary";
import { ActionStatus } from "../action-status";

const tone = (status: Refund["status"]) => status === "succeeded" ? "good" : status === "failed" ? "bad" : "";

/** استردادات الطلب ببنودها: المالية تختار البنود وسببًا مرمّزًا، ولا مبلغ حر؛ النجاح يصل من الإشعار الموقّع. */
export function RefundsPanel({ locale, order, onChange }: { locale: Locale; order: Order; onChange: () => void }) {
  const m = messages[locale], r = m.refunds, me = useUser(), readable = hasRole(me, ...refundReaders), writer = hasRole(me, ...refundWriters), mutation = useMutation();
  const [items, setItems] = useState<Refund[] | null>(null), [error, setError] = useState(false), [attempt, setAttempt] = useState(0);
  const [selected, setSelected] = useState<string[]>([]), [reason, setReason] = useState<RefundCreate["reason_code"] | "">("");
  useEffect(() => {
    if (!readable) return;
    const controller = new AbortController();
    void browserApi().GET("/orders/{order_id}/refunds", { params: { path: { order_id: order.id } }, signal: controller.signal }).then(dataOrThrow).then(data => { if (!controller.signal.aborted) { setItems(data.items); setError(false); } }).catch(() => { if (!controller.signal.aborted) setError(true); });
    return () => controller.abort();
  }, [order.id, order.status, readable, attempt]);
  if (!readable) return null;

  const title = (id: string) => { const item = order.items.find(i => i.id === id); return item ? localized(item.title, locale) : id; };
  const open = items ? refundable(order, items) : [], chosen = open.filter(i => selected.includes(i.id));
  const amount = { amount_minor: chosen.reduce((sum, i) => sum + i.price.amount_minor, 0), currency: order.total.currency };
  async function submit() {
    if (!chosen.length || !reason) return;
    const body: RefundCreate = { order_item_ids: chosen.map(i => i.id), reason_code: reason };
    const ok = await mutation.run(JSON.stringify([order.id, body]), header => browserApi().POST("/orders/{order_id}/refunds", { params: { path: { order_id: order.id }, header }, body }));
    if (ok) { setSelected([]); setReason(""); setAttempt(n => n + 1); onChange(); }
  }

  return <section className="card" aria-labelledby="refunds-title"><h2 id="refunds-title">{r.title}</h2>
    {error ? <><p role="alert">{m.error}</p><button className="secondary" onClick={() => setAttempt(n => n + 1)}>{m.retry}</button></>
      : !items ? <p role="status">{m.loading}</p>
      : <>{!items.length ? <p className="muted">{r.empty}</p> : <div className="table-scroll"><table><thead><tr>{[r.created, r.items, r.amount, r.reason, r.status].map(label => <th scope="col" key={label}>{label}</th>)}</tr></thead>
          <tbody>{items.map(refund => <tr key={refund.id} data-testid="refund-row"><td>{formatDate(refund.created_at, locale)}</td><td>{refund.order_item_ids.map(title).join("، ")}</td><td dir="ltr">{formatMoney(refund.amount, locale)}</td><td>{r.reasons[refund.reason_code]}</td><td><span className={`badge ${tone(refund.status)}`}>{r.statuses[refund.status]}</span></td></tr>)}</tbody></table></div>}
        {items.some(i => i.status === "pending") && <p className="muted">{r.pendingHelp}</p>}
        {writer && (open.length ? <form className="rule-form" noValidate onSubmit={e => { e.preventDefault(); void submit(); }}>
          <fieldset className="check-group"><legend>{r.choose}</legend>{open.map(item => <label key={item.id} className="check"><input type="checkbox" checked={selected.includes(item.id)} onChange={() => setSelected(list => list.includes(item.id) ? list.filter(id => id !== item.id) : [...list, item.id])} />{localized(item.title, locale)} <small className="muted">{localized(item.license_name, locale)} · <bdi dir="ltr">{formatMoney(item.price, locale)}</bdi></small></label>)}</fieldset>
          <label>{r.reason}<select value={reason} onChange={e => setReason(e.target.value as RefundCreate["reason_code"] | "")}><option value="">{m.choose}</option>{refundReasons.map(code => <option key={code} value={code}>{r.reasons[code]}</option>)}</select></label>
          <p data-testid="refund-amount">{r.total} <bdi dir="ltr">{formatMoney(amount, locale)}</bdi></p>
          <p className="notice">{r.effect}</p>
          <ActionStatus status={mutation.status} locale={locale} />{mutation.status === 409 && <p className="notice error">{r.conflict}</p>}
          <div className="actions"><button disabled={mutation.busy || !chosen.length || !reason}>{mutation.busy ? m.review.saving : r.submit}</button></div>
        </form> : <p className="muted">{order.status === "paid" ? r.nothingLeft : r.paidOnly}</p>)}</>}
  </section>;
}
