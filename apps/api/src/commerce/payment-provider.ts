import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { type Currency, isCurrency, type Money, money } from './money';

/**
 * واجهة مزوّد الدفع (ADR 0032): الدفع مستضاف لدى المزوّد فلا تمر بيانات بطاقة بخوادمنا، والحقيقة من إشعار موقَّع أو من
 * status()، لا من صفحة العودة. المحوّل الحقيقي يُضاف بعد تجربة الصرف دون مس بقية النظام. لا مال حقيقي في هذه الدورة.
 */
export type ProviderEventType = 'payment.succeeded' | 'payment.failed' | 'refund.succeeded' | 'dispute.opened';
export interface ProviderEvent {
  eventId: string;
  type: ProviderEventType;
  providerRef: string;
  amount: Money;
  occurredAt: Date;
}
export type ProviderPaymentStatus = 'pending' | 'succeeded' | 'failed' | 'refunded';

export interface PaymentProvider {
  readonly name: string;
  createCheckout(input: { orderId: string; amount: Money; returnUrl: string; idempotencyKey: string }): Promise<{ checkoutUrl: string; providerRef: string; expiresAt: Date }>;
  /** يرمي WebhookSignatureError عند توقيع أو وقت غير صالحين، قبل تحليل الجسم. */
  verifyWebhook(rawBody: Buffer, headers: Record<string, string | undefined>, now?: Date): ProviderEvent;
  refund(input: { providerRef: string; amount: Money; idempotencyKey: string }): Promise<{ refundRef: string }>;
  status(providerRef: string): Promise<ProviderPaymentStatus>;
}

export const PAYMENT_PROVIDER = Symbol('PAYMENT_PROVIDER');

export class WebhookSignatureError extends Error {
  override name = 'WebhookSignatureError';
}

const SKEW_MS = 5 * 60 * 1000;
const EVENT_TYPES: ReadonlySet<string> = new Set<ProviderEventType>(['payment.succeeded', 'payment.failed', 'refund.succeeded', 'dispute.opened']);

/** توقيع الإشعار: HMAC-SHA256 على `timestamp.body` بالسر، بترميز hex؛ الترويسة `X-Signature: v1=<hex>`. */
export function signWebhook(secret: string, timestamp: number, rawBody: Buffer): string {
  return createHmac('sha256', secret).update(`${timestamp}.`).update(rawBody).digest('hex');
}

/**
 * التحقق من الإشعار قبل التحليل (ADR 0032 §2): الترويستان X-Timestamp (ثوانٍ) وX-Signature، بمقارنة ثابتة الزمن، ونافذة
 * ±5 دقائق. ثم يُحلَّل الجسم إلى ProviderEvent بحقوله وحدها؛ أي حقل ناقص أو غريب الشكل يُرفض بالخطأ نفسه.
 */
export function verifySignedWebhook(secret: string, rawBody: Buffer, headers: Record<string, string | undefined>, now = new Date()): ProviderEvent {
  const ts = headers['x-timestamp'];
  const sig = /^v1=([0-9a-f]{64})$/.exec(headers['x-signature'] ?? '')?.[1];
  if (!ts || !/^\d{10}$/.test(ts) || !sig) throw new WebhookSignatureError('missing or malformed signature headers');
  if (Math.abs(now.getTime() - Number(ts) * 1000) > SKEW_MS) throw new WebhookSignatureError('timestamp outside the allowed window');
  const expected = Buffer.from(signWebhook(secret, Number(ts), rawBody), 'hex');
  if (!timingSafeEqual(expected, Buffer.from(sig, 'hex'))) throw new WebhookSignatureError('signature mismatch');
  return parseEvent(rawBody);
}

function parseEvent(rawBody: Buffer): ProviderEvent {
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(rawBody.toString('utf8')) as Record<string, unknown>;
  } catch {
    throw new WebhookSignatureError('body is not JSON');
  }
  const amount = body.amount as { amount_minor?: unknown; currency?: unknown } | undefined;
  const occurred = typeof body.occurred_at === 'string' ? new Date(body.occurred_at) : null;
  if (
    typeof body.event_id !== 'string' ||
    !/^[A-Za-z0-9_.:-]{1,128}$/.test(body.event_id) ||
    typeof body.type !== 'string' ||
    !EVENT_TYPES.has(body.type) ||
    typeof body.provider_ref !== 'string' ||
    body.provider_ref.length < 1 ||
    body.provider_ref.length > 128 ||
    !amount ||
    typeof amount.amount_minor !== 'number' ||
    !Number.isSafeInteger(amount.amount_minor) ||
    amount.amount_minor <= 0 ||
    !isCurrency(amount.currency) ||
    !occurred ||
    Number.isNaN(occurred.getTime())
  ) {
    throw new WebhookSignatureError('event fields are invalid');
  }
  return {
    eventId: body.event_id,
    type: body.type as ProviderEventType,
    providerRef: body.provider_ref,
    amount: money(amount.amount_minor, amount.currency as Currency),
    occurredAt: occurred,
  };
}

/**
 * المزوّد التجريبي (ADR 0032): صفحة دفع داخلية لا تطلب بطاقة، وإشعار موقَّع بـ SANDBOX_WEBHOOK_SECRET إلى نقطة الإشعار
 * نفسها. لا يعمل في الإنتاج (فحص الإعداد عند الإقلاع). الحالة في الذاكرة، تكفي للاختبار والتسوية في بيئة واحدة.
 */
export class SandboxPaymentProvider implements PaymentProvider {
  readonly name = 'sandbox';
  private readonly payments = new Map<string, { status: ProviderPaymentStatus; amount: Money; checkoutKey: string; returnUrl: string }>();
  private readonly refunds = new Map<string, { refundRef: string; amount: Money }>();

  constructor(
    private readonly secret: string,
    private readonly baseUrl: string,
  ) {}

  async createCheckout(input: { orderId: string; amount: Money; returnUrl: string; idempotencyKey: string }): Promise<{ checkoutUrl: string; providerRef: string; expiresAt: Date }> {
    const existing = [...this.payments.entries()].find(([, p]) => p.checkoutKey === input.idempotencyKey);
    const providerRef = existing?.[0] ?? `sbx_${randomBytes(16).toString('hex')}`;
    if (!existing) this.payments.set(providerRef, { status: 'pending', amount: input.amount, checkoutKey: input.idempotencyKey, returnUrl: input.returnUrl });
    return { checkoutUrl: `${this.baseUrl.replace(/\/$/, '')}/sandbox/checkout/${providerRef}`, providerRef, expiresAt: new Date(Date.now() + 30 * 60 * 1000) };
  }

  verifyWebhook(rawBody: Buffer, headers: Record<string, string | undefined>, now?: Date): ProviderEvent {
    return verifySignedWebhook(this.secret, rawBody, headers, now);
  }

  async refund(input: { providerRef: string; amount: Money; idempotencyKey: string }): Promise<{ refundRef: string }> {
    const known = this.refunds.get(input.idempotencyKey);
    if (known) return { refundRef: known.refundRef };
    const payment = this.payments.get(input.providerRef);
    if (!payment || payment.status !== 'succeeded') throw new Error('sandbox: nothing to refund');
    const refundRef = `sbr_${randomBytes(16).toString('hex')}`;
    this.refunds.set(input.idempotencyKey, { refundRef, amount: input.amount });
    return { refundRef };
  }

  async status(providerRef: string): Promise<ProviderPaymentStatus> {
    return this.payments.get(providerRef)?.status ?? 'failed';
  }

  /** صفحة العودة للجلسة (من إعداد الخادم وحده)، أو undefined بلا عودة أو للمرجع المجهول. */
  returnUrlOf(providerRef: string): string | undefined {
    return this.payments.get(providerRef)?.returnUrl || undefined;
  }

  /** مبلغ الجلسة لصفحة الدفع، أو undefined للمرجع المجهول. */
  amountOf(providerRef: string): Money | undefined {
    return this.payments.get(providerRef)?.amount;
  }

  /** تأكيد استرداد تجريبي: الإشعار الموقَّع `refund.succeeded` بمرجع الاسترداد ومبلغه، أو undefined للمرجع المجهول. */
  settleRefund(refundRef: string, now = new Date()): { body: Buffer; headers: Record<string, string> } | undefined {
    const refund = [...this.refunds.values()].find((r) => r.refundRef === refundRef);
    if (!refund) return undefined;
    return this.signed({ type: 'refund.succeeded', providerRef: refundRef, amount: refund.amount }, now);
  }

  /** ما تفعله صفحة الدفع التجريبية عند الضغط على نتيجة: تسجّل الحالة وتبني الإشعار الموقَّع (جسمه وترويستيه). */
  settle(providerRef: string, outcome: 'succeeded' | 'failed', now = new Date()): { body: Buffer; headers: Record<string, string> } {
    const payment = this.payments.get(providerRef);
    if (!payment) throw new Error('sandbox: unknown payment');
    if (payment.status === 'pending' || outcome === 'succeeded') payment.status = outcome;
    return this.signed({ type: outcome === 'succeeded' ? 'payment.succeeded' : 'payment.failed', providerRef, amount: payment.amount }, now);
  }

  private signed(e: { type: ProviderEventType; providerRef: string; amount: Money }, now: Date): { body: Buffer; headers: Record<string, string> } {
    const body = Buffer.from(
      JSON.stringify({
        event_id: `sbe_${randomBytes(12).toString('hex')}`,
        type: e.type,
        provider_ref: e.providerRef,
        amount: { amount_minor: Number(e.amount.amountMinor), currency: e.amount.currency },
        occurred_at: now.toISOString(),
      }),
    );
    const ts = Math.floor(now.getTime() / 1000);
    return { body, headers: { 'x-timestamp': String(ts), 'x-signature': `v1=${signWebhook(this.secret, ts, body)}` } };
  }
}
