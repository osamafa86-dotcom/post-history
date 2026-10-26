import { createHmac, timingSafeEqual } from 'node:crypto';
import { type Currency, isCurrency, type Money, money } from './money';
import { type PaymentProvider, type ProviderEvent, type ProviderPaymentStatus, WebhookSignatureError } from './payment-provider';

/**
 * محوّل Stripe في وضع الاختبار (ADR 0032، مزوّد ثانٍ): صفحة Checkout المستضافة، والتحقق من `Stripe-Signature` قبل التحليل،
 * وترجمة أحداث Stripe إلى ProviderEvent، والاسترداد. المفتاح `sk_test_` وحده (قيد الإعداد)، فلا مال حقيقي. المفاتيح من
 * البيئة وحدها ولا تُسجَّل. النداءات بمفتاح منع تكرار Stripe (`Idempotency-Key`) من مفاتيحنا.
 */
export class StripeTestProvider implements PaymentProvider {
  readonly name = 'stripe';

  constructor(
    private readonly secretKey: string,
    private readonly webhookSecret: string,
    private readonly apiBase = 'https://api.stripe.com',
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async createCheckout(input: { orderId: string; amount: Money; returnUrl: string; idempotencyKey: string }): Promise<{ checkoutUrl: string; providerRef: string; expiresAt: Date }> {
    // أقصر مهلة يقبلها Stripe 30 دقيقة؛ المهلة الأقصر للطلب نفسه يفرضها الخادم
    const expiresAt = new Date(Date.now() + 31 * 60 * 1000);
    const back = input.returnUrl || undefined;
    const s = await this.call<StripeSession>('POST', '/v1/checkout/sessions', input.idempotencyKey, {
      mode: 'payment',
      client_reference_id: input.orderId,
      'metadata[order_id]': input.orderId,
      'payment_intent_data[metadata][order_id]': input.orderId,
      'line_items[0][quantity]': '1',
      'line_items[0][price_data][currency]': input.amount.currency.toLowerCase(),
      'line_items[0][price_data][unit_amount]': input.amount.amountMinor.toString(),
      // اسم البند بمعرّف الطلب وحده: لا عنوان مادة ولا اسم مشترٍ عند المزوّد
      'line_items[0][price_data][product_data][name]': `Order ${input.orderId}`,
      expires_at: String(Math.floor(expiresAt.getTime() / 1000)),
      ...(back ? { success_url: withOutcome(back, 'succeeded'), cancel_url: withOutcome(back, 'failed') } : {}),
    });
    if (!s.id || !s.url) throw new Error('stripe: checkout session without id or url');
    return { checkoutUrl: s.url, providerRef: s.id, expiresAt: new Date((s.expires_at ?? Math.floor(expiresAt.getTime() / 1000)) * 1000) };
  }

  verifyWebhook(rawBody: Buffer, headers: Record<string, string | undefined>, now = new Date()): ProviderEvent {
    verifyStripeSignature(this.webhookSecret, rawBody, headers['stripe-signature'], now);
    return translateStripeEvent(rawBody);
  }

  async refund(input: { providerRef: string; amount: Money; idempotencyKey: string }): Promise<{ refundRef: string }> {
    const s = await this.call<StripeSession>('GET', `/v1/checkout/sessions/${encodeURIComponent(input.providerRef)}`);
    if (!s.payment_intent) throw new Error('stripe: the session has no payment to refund');
    const r = await this.call<{ id?: string }>('POST', '/v1/refunds', input.idempotencyKey, {
      payment_intent: typeof s.payment_intent === 'string' ? s.payment_intent : s.payment_intent.id,
      amount: input.amount.amountMinor.toString(),
    });
    if (!r.id) throw new Error('stripe: refund without id');
    return { refundRef: r.id };
  }

  async status(providerRef: string): Promise<ProviderPaymentStatus> {
    const s = await this.call<StripeSession>('GET', `/v1/checkout/sessions/${encodeURIComponent(providerRef)}`);
    if (s.payment_status === 'paid') return 'succeeded';
    if (s.status === 'expired') return 'failed';
    return 'pending';
  }

  private async call<T>(method: 'GET' | 'POST', path: string, idempotencyKey?: string, form?: Record<string, string>): Promise<T> {
    const res = await this.fetchImpl(`${this.apiBase.replace(/\/$/, '')}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.secretKey}`,
        ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
        ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
      },
      ...(form ? { body: new URLSearchParams(form).toString() } : {}),
    });
    const body = (await res.json().catch(() => ({}))) as T & { error?: { type?: string; code?: string } };
    // نوع الخطأ ورمزه وحدهما؛ لا رسالة Stripe (قد تحمل بيانات) ولا المفتاح
    if (!res.ok) throw new Error(`stripe: ${res.status} ${body.error?.type ?? 'error'}${body.error?.code ? ` ${body.error.code}` : ''}`);
    return body;
  }
}

interface StripeSession {
  id?: string;
  url?: string;
  expires_at?: number;
  status?: string;
  payment_status?: string;
  payment_intent?: string | { id: string } | null;
}

/** الحدث الموقّع الصحيح الذي لا يخص الدفع عندنا: يُقبل بـ 200 بلا أثر ولا يُخزَّن. */
export class IgnoredWebhookEvent extends Error {
  override name = 'IgnoredWebhookEvent';
}

const SKEW_SECONDS = 5 * 60;

/**
 * `Stripe-Signature: t=<ثوانٍ>,v1=<hex>[,v1=…]`: HMAC-SHA256 على `t.body` بسر الويبهوك، بمقارنة ثابتة الزمن مع أي v1
 * (Stripe يرسل أكثر من واحد عند تدوير السر)، ونافذة ±5 دقائق. قبل أي تحليل للجسم.
 */
export function verifyStripeSignature(secret: string, rawBody: Buffer, header: string | undefined, now = new Date()): void {
  const parts = (header ?? '').split(',').map((p) => p.trim().split('='));
  const t = parts.find(([k]) => k === 't')?.[1];
  const sigs = parts.filter(([k, v]) => k === 'v1' && /^[0-9a-f]{64}$/.test(v ?? '')).map(([, v]) => Buffer.from(v!, 'hex'));
  if (!t || !/^\d{1,12}$/.test(t) || sigs.length === 0) throw new WebhookSignatureError('missing or malformed Stripe-Signature');
  if (Math.abs(now.getTime() / 1000 - Number(t)) > SKEW_SECONDS) throw new WebhookSignatureError('timestamp outside the allowed window');
  const expected = createHmac('sha256', secret).update(`${t}.`).update(rawBody).digest();
  if (!sigs.some((s) => timingSafeEqual(s, expected))) throw new WebhookSignatureError('signature mismatch');
}

/** للاختبار وstripe-mock: يوقّع الجسم كما يوقّعه Stripe. */
export function stripeSignatureHeader(secret: string, rawBody: Buffer, now = new Date()): string {
  const t = Math.floor(now.getTime() / 1000);
  return `t=${t},v1=${createHmac('sha256', secret).update(`${t}.`).update(rawBody).digest('hex')}`;
}

/**
 * ترجمة حدث Stripe إلى إشعارنا (معرّف الحدث `evt_…` للتكرار):
 * - `checkout.session.completed` المدفوع و`checkout.session.async_payment_succeeded` ← `payment.succeeded` بمعرّف الجلسة.
 * - `checkout.session.async_payment_failed` و`checkout.session.expired` ← `payment.failed`.
 * - `refund.created`/`refund.updated` بحالة `succeeded` ← `refund.succeeded` بمعرّف الاسترداد.
 * - `charge.dispute.created` ← `dispute.opened` بمعرّف الدفعة (للمراجعة).
 * ما عداها، أو `completed` غير المدفوع بعد، IgnoredWebhookEvent.
 */
export function translateStripeEvent(rawBody: Buffer): ProviderEvent {
  let e: { id?: unknown; type?: unknown; created?: unknown; data?: { object?: Record<string, unknown> } };
  try {
    e = JSON.parse(rawBody.toString('utf8'));
  } catch {
    throw new WebhookSignatureError('body is not JSON');
  }
  const o = e.data?.object ?? {};
  if (typeof e.id !== 'string' || !/^evt_[A-Za-z0-9_]{1,120}$/.test(e.id) || typeof e.type !== 'string' || typeof e.created !== 'number') {
    throw new WebhookSignatureError('event fields are invalid');
  }
  const at = new Date(e.created * 1000);
  const amountOf = (minor: unknown, currency: unknown): Money => {
    const c = typeof currency === 'string' ? currency.toUpperCase() : '';
    if (typeof minor !== 'number' || !Number.isSafeInteger(minor) || minor <= 0 || !isCurrency(c)) throw new WebhookSignatureError('event amount is invalid');
    return money(BigInt(minor), c as Currency);
  };
  const ref = (v: unknown) => {
    if (typeof v !== 'string' || v.length < 1 || v.length > 128) throw new WebhookSignatureError('event reference is invalid');
    return v;
  };
  switch (e.type) {
    case 'checkout.session.completed':
      if (o.payment_status !== 'paid') throw new IgnoredWebhookEvent('session completed before payment');
      return { eventId: e.id, type: 'payment.succeeded', providerRef: ref(o.id), amount: amountOf(o.amount_total, o.currency), occurredAt: at };
    case 'checkout.session.async_payment_succeeded':
      return { eventId: e.id, type: 'payment.succeeded', providerRef: ref(o.id), amount: amountOf(o.amount_total, o.currency), occurredAt: at };
    case 'checkout.session.async_payment_failed':
    case 'checkout.session.expired':
      return { eventId: e.id, type: 'payment.failed', providerRef: ref(o.id), amount: amountOf(o.amount_total, o.currency), occurredAt: at };
    case 'refund.created':
    case 'refund.updated':
      if (o.status !== 'succeeded') throw new IgnoredWebhookEvent('refund not succeeded yet');
      return { eventId: e.id, type: 'refund.succeeded', providerRef: ref(o.id), amount: amountOf(o.amount, o.currency), occurredAt: at };
    case 'charge.dispute.created':
      return { eventId: e.id, type: 'dispute.opened', providerRef: ref(o.charge), amount: amountOf(o.amount, o.currency), occurredAt: at };
    default:
      throw new IgnoredWebhookEvent(`event type not used: ${e.type}`);
  }
}

function withOutcome(url: string, outcome: string): string {
  const u = new URL(url);
  u.searchParams.set('outcome', outcome);
  return u.toString();
}
