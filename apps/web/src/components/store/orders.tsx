"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { browserApi, dataOrThrow, RequestError } from "@/lib/browser-api";
import { formatDate, messages, type Locale } from "@/lib/i18n";
import { hasRole } from "@/lib/review";
import { useMutation } from "@/lib/use-mutation";
import { formatMoney, localized, totals } from "@/lib/store-format";
import { orderReaders, orderWriters, type Order } from "@/lib/order-policy";
import { useUser } from "../session-boundary";
import { ActionStatus } from "../action-status";
import { CartSummary } from "./cart-summary";
import { useCart } from "./cart";

/** السلة: الطلب يُنشأ منها مرة واحدة بعملة واحدة، ومعه المجموع الذي رآه المشتري (العقد يرفض غير ذلك). */
export function CartPage({ locale }: { locale: Locale }) {
  const m = messages[locale], s = m.store, o = m.orders, me = useUser(), cart = useCart(), mutation = useMutation(), router = useRouter();
  if (!hasRole(me, ...orderWriters)) return <section className="center-state"><h1>{s.cart}</h1><p role="alert">{s.buyersOnly}</p></section>;
  const sums = totals(cart.items.map(i => i.price));
  async function place() {
    const body = { items: cart.items.map(i => ({ listing_id: i.listing_id, license_template_id: i.license_template_id })), expected_total: sums[0] };
    let created: Order | undefined;
    const ok = await mutation.run(JSON.stringify(body), async header => { const result = await browserApi().POST("/orders", { params: { header }, body }); created = result.data; return result; });
    if (ok && created) { cart.clear(); router.push(`/${locale}/store/orders/${created.id}`); }
  }
  return <><Link prefetch={false} className="back-link" href={`/${locale}/store`}>{s.back}</Link>
    <div className="page-heading"><div><h1>{s.cart}</h1><p className="muted">{o.cartLead}</p></div><Link prefetch={false} href={`/${locale}/store/orders`}>{o.title}</Link></div>
    <CartSummary locale={locale} lines={cart.items.map(i => ({ id: i.listing_id, title: i.title, license: i.license, price: i.price }))} onRemove={cart.remove} checkout={<>
      <ActionStatus status={mutation.status} locale={locale} />
      {mutation.status === 409 && <p className="notice error">{o.conflict}</p>}
      <button disabled={mutation.busy || sums.length !== 1} onClick={() => void place()}>{o.place}</button></>} />
  </>;
}

const statusTone = (status: Order["status"]) => status === "paid" ? "good" : status === "pending_payment" ? "" : "bad";

export function OrdersPage({ locale }: { locale: Locale }) {
  const m = messages[locale], o = m.orders, me = useUser();
  const [items, setItems] = useState<Order[] | null>(null), [error, setError] = useState(false), [attempt, setAttempt] = useState(0);
  const allowed = hasRole(me, ...orderReaders);
  useEffect(() => {
    if (!allowed) return;
    const controller = new AbortController();
    void browserApi().GET("/orders", { signal: controller.signal }).then(dataOrThrow).then(data => { if (!controller.signal.aborted) { setItems(data.items); setError(false); } }).catch(() => { if (!controller.signal.aborted) setError(true); });
    return () => controller.abort();
  }, [allowed, attempt]);
  if (!allowed) return <section className="center-state"><h1>{o.title}</h1><p role="alert">{o.denied}</p></section>;
  return <><Link prefetch={false} className="back-link" href={`/${locale}/store`}>{m.store.back}</Link>
    <div className="page-heading"><div><h1>{o.title}</h1><p className="muted">{o.lead}</p></div></div>
    {error ? <section className="center-state" role="alert"><p>{m.error}</p><button onClick={() => setAttempt(n => n + 1)}>{m.retry}</button></section>
      : !items ? <p className="center-state" role="status">{m.loading}</p> : !items.length ? <p className="empty">{o.empty}</p>
      : <div className="table-panel"><div className="table-scroll"><table><thead><tr>{[o.created, o.items, o.total, o.status, ""].map(label => <th scope="col" key={label}>{label}</th>)}</tr></thead>
        <tbody>{items.map(order => <tr key={order.id} data-testid="order-row"><td>{formatDate(order.created_at, locale)}</td><td>{order.items.map(i => localized(i.title, locale)).join("، ")}</td><td dir="ltr">{formatMoney(order.total, locale)}</td><td><span className={`badge ${statusTone(order.status)}`}>{o.statuses[order.status]}</span></td><td><Link prefetch={false} href={`/${locale}/store/orders/${order.id}`}>{o.open}</Link></td></tr>)}</tbody></table></div></div>}
  </>;
}

/** الطلب: الدفع عند المزوّد التجريبي المستضاف، والعودة منه لا تؤكد الدفع؛ الصفحة تقرأ الطلب حتى `paid` من الإشعار الموقّع. */
export function OrderPage({ locale, id, returned }: { locale: Locale; id: string; returned: boolean }) {
  const m = messages[locale], o = m.orders, me = useUser(), mutation = useMutation(), buyer = hasRole(me, ...orderWriters);
  const [order, setOrder] = useState<Order | null>(null), [checkedAt, setCheckedAt] = useState(0), [status, setStatus] = useState(0), [attempt, setAttempt] = useState(0), polls = useRef(0);
  useEffect(() => {
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    async function load() {
      try {
        const data = dataOrThrow(await browserApi().GET("/orders/{order_id}", { params: { path: { order_id: id } }, signal: controller.signal }));
        if (controller.signal.aborted) return;
        setOrder(data); setCheckedAt(Date.now()); setStatus(0);
        // بعد العودة من المزوّد: قراءة كل 3 ثوانٍ حتى يتغير الطلب، دقيقتين على الأكثر.
        if (returned && data.status === "pending_payment" && polls.current++ < 40) timer = setTimeout(load, 3000);
      } catch (e) { if (!controller.signal.aborted) setStatus(e instanceof RequestError ? e.status : 503); }
    }
    void load(); return () => { controller.abort(); clearTimeout(timer); };
  }, [id, returned, attempt]);
  async function pay() {
    let url: string | undefined;
    const ok = await mutation.run(`checkout:${id}`, async header => { const result = await browserApi().POST("/orders/{order_id}/checkout", { params: { path: { order_id: id }, header } }); url = result.data?.checkout_url; return result; });
    if (ok && url) window.location.assign(url);
  }
  async function cancel() {
    const ok = await mutation.run(`cancel:${id}`, header => browserApi().POST("/orders/{order_id}/cancel", { params: { path: { order_id: id }, header } }));
    if (ok) setAttempt(n => n + 1);
  }
  const back = <Link prefetch={false} className="back-link" href={`/${locale}/store/orders`}>{o.title}</Link>;
  if (status) return <>{back}<p className="center-state" role="alert">{status === 404 ? o.notFound : m.error}</p></>;
  if (!order) return <>{back}<p className="center-state" role="status">{m.loading}</p></>;
  const pending = order.status === "pending_payment", expired = pending && Date.parse(order.expires_at) <= checkedAt;
  return <>{back}
    <div className="page-heading"><div><p className="eyebrow">{o.order}</p><h1 dir="ltr">{formatMoney(order.total, locale)}</h1><p><span className={`badge ${statusTone(order.status)}`} data-testid="order-status">{o.statuses[order.status]}</span>{order.cancel_reason && <small className="muted"> {o.reasons[order.cancel_reason]}</small>}</p></div></div>
    {returned && pending && <p className="notice" role="status" data-testid="awaiting">{o.awaiting}</p>}
    {order.status === "paid" && <p className="notice" role="status">{o.paidHelp}</p>}
    <section className="card cart-summary"><ul>{order.items.map(i => <li key={i.id} data-testid="order-item"><span><strong>{localized(i.title, locale)}</strong><small className="muted">{localized(i.license_name, locale)}</small></span><span dir="ltr">{formatMoney(i.price, locale)}</span></li>)}</ul>
      <dl className="metadata">{[[o.created, formatDate(order.created_at, locale)], [pending ? o.payBy : o.paidAt, formatDate(pending ? order.expires_at : order.paid_at, locale)]].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl></section>
    {buyer && pending && <section className="card"><p className="muted">{o.sandbox}</p><ActionStatus status={mutation.status} locale={locale} />{mutation.status === 409 && <p className="notice error">{o.conflict}</p>}{mutation.status === 502 && <p className="notice error">{o.providerBlocked}</p>}
      <div className="actions"><button disabled={mutation.busy || expired} onClick={() => void pay()}>{o.pay}</button><button className="secondary" disabled={mutation.busy} onClick={() => void cancel()}>{o.cancel}</button></div>{expired && <p className="muted">{o.expiredHelp}</p>}</section>}
  </>;
}
