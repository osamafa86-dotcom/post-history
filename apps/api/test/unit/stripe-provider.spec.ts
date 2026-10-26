import { randomBytes } from 'node:crypto';
import { loadConfig } from '../../src/config/config';
import { money } from '../../src/commerce/money';
import { WebhookSignatureError } from '../../src/commerce/payment-provider';
import { IgnoredWebhookEvent, LiveModeEvent, StripeTestProvider, stripeSignatureHeader, translateStripeEvent, verifyStripeSignature } from '../../src/commerce/stripe-provider';

const WHSEC = `whsec_${randomBytes(16).toString('hex')}`;
// مفاتيح وهمية تُبنى عند التشغيل، فلا نص بشكل مفتاح Stripe في المستودع
const fakeKey = (mode: 'test' | 'live') => ['sk', mode, randomBytes(12).toString('hex')].join('_');
const KEY = fakeKey('test');
const now = new Date('2026-10-26T12:00:00Z');
const evt = (type: string, object: Record<string, unknown>, id = 'evt_test_1') => Buffer.from(JSON.stringify({ id, type, livemode: false, created: Math.floor(now.getTime() / 1000), data: { object } }));

/** ردود Stripe المسجّلة بشكلها، ونداءات المحوّل محفوظة للفحص */
function recorded(responses: Record<string, unknown>) {
  const calls: Array<{ method: string; url: string; headers: Record<string, string>; body?: string }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ method: init.method!, url, headers: init.headers as Record<string, string>, body: init.body as string | undefined });
    const key = `${init.method} ${new URL(url).pathname}`;
    const body = responses[key];
    return new Response(JSON.stringify(body ?? { error: { type: 'invalid_request_error', code: 'resource_missing', message: 'secret detail' } }), { status: body ? 200 : 404 });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

describe('Stripe test-mode adapter', () => {
  it('creates a hosted Checkout Session with the order id only, the amount in minor units and our idempotency key', async () => {
    const { calls, fetchImpl } = recorded({ 'POST /v1/checkout/sessions': { id: 'cs_test_1', url: 'https://checkout.stripe.com/c/pay/cs_test_1', expires_at: 1793011200 } });
    const p = new StripeTestProvider(KEY, WHSEC, 'https://stripe.test', fetchImpl);
    const s = await p.createCheckout({ orderId: 'o-1', amount: money(12345n, 'ILS'), returnUrl: 'https://web.example/ar/orders/o-1', idempotencyKey: 'checkout:o-1' });
    expect(s).toEqual({ checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_test_1', providerRef: 'cs_test_1', expiresAt: new Date(1793011200 * 1000) });
    const form = new URLSearchParams(calls[0]!.body);
    expect(calls[0]!.headers).toMatchObject({ Authorization: `Bearer ${KEY}`, 'Idempotency-Key': 'checkout:o-1' });
    expect(Object.fromEntries(form)).toMatchObject({
      mode: 'payment',
      client_reference_id: 'o-1',
      'line_items[0][price_data][currency]': 'ils',
      'line_items[0][price_data][unit_amount]': '12345',
      'line_items[0][price_data][product_data][name]': 'Order o-1',
      success_url: 'https://web.example/ar/orders/o-1?outcome=succeeded',
      cancel_url: 'https://web.example/ar/orders/o-1?outcome=failed',
    });
  });

  it('refunds through the session payment intent; an error carries the Stripe type and code, never its message or the key', async () => {
    const { calls, fetchImpl } = recorded({ 'GET /v1/checkout/sessions/cs_test_1': { id: 'cs_test_1', payment_intent: 'pi_1', payment_status: 'paid' }, 'POST /v1/refunds': { id: 're_1' } });
    const p = new StripeTestProvider(KEY, WHSEC, 'https://stripe.test', fetchImpl);
    expect(await p.refund({ providerRef: 'cs_test_1', amount: money(500n, 'USD'), idempotencyKey: 'refund:r1' })).toEqual({ refundRef: 're_1' });
    expect(Object.fromEntries(new URLSearchParams(calls[1]!.body))).toEqual({ payment_intent: 'pi_1', amount: '500' });
    expect(calls[1]!.headers['Idempotency-Key']).toBe('refund:r1');
    expect(await p.status('cs_test_1')).toBe('succeeded');
    const err = await p.status('cs_unknown').catch((e: Error) => e);
    expect((err as Error).message).toBe('stripe: 404 invalid_request_error resource_missing');
    expect((err as Error).message).not.toContain(KEY);
  });

  it('verifies Stripe-Signature before parsing: any v1, ±5 minutes, constant-time', () => {
    const body = evt('checkout.session.completed', { id: 'cs_test_1', payment_status: 'paid', amount_total: 100, currency: 'usd' });
    const good = stripeSignatureHeader(WHSEC, body, now);
    expect(() => verifyStripeSignature(WHSEC, body, good, now)).not.toThrow();
    // سر مدوَّر: توقيعان، أحدهما صحيح
    expect(() => verifyStripeSignature(WHSEC, body, `${good},v1=${'0'.repeat(64)}`, now)).not.toThrow();
    for (const bad of [undefined, '', 't=1', good.replace(/v1=./, 'v1=0'), stripeSignatureHeader(`whsec_${randomBytes(16).toString('hex')}`, body, now)]) {
      expect(() => verifyStripeSignature(WHSEC, body, bad, now)).toThrow(WebhookSignatureError);
    }
    expect(() => verifyStripeSignature(WHSEC, body, good, new Date(now.getTime() + 6 * 60_000))).toThrow(/window/);
    expect(() => verifyStripeSignature(WHSEC, Buffer.concat([body, Buffer.from(' ')]), good, now)).toThrow(/mismatch/);
  });

  it('translates the payment, refund and dispute events, and ignores the rest', () => {
    expect(translateStripeEvent(evt('checkout.session.completed', { id: 'cs_1', payment_status: 'paid', amount_total: 10000, currency: 'usd' }))).toEqual({
      eventId: 'evt_test_1', type: 'payment.succeeded', providerRef: 'cs_1', amount: money(10000n, 'USD'), occurredAt: now,
    });
    expect(translateStripeEvent(evt('checkout.session.expired', { id: 'cs_1', amount_total: 10000, currency: 'usd' })).type).toBe('payment.failed');
    expect(translateStripeEvent(evt('checkout.session.async_payment_failed', { id: 'cs_1', amount_total: 10000, currency: 'ils' })).amount).toEqual(money(10000n, 'ILS'));
    expect(translateStripeEvent(evt('refund.updated', { id: 're_1', status: 'succeeded', amount: 500, currency: 'usd' }))).toMatchObject({ type: 'refund.succeeded', providerRef: 're_1' });
    expect(translateStripeEvent(evt('charge.dispute.created', { id: 'dp_1', charge: 'ch_1', amount: 500, currency: 'usd' }))).toMatchObject({ type: 'dispute.opened', providerRef: 'ch_1' });
    expect(() => translateStripeEvent(evt('checkout.session.completed', { id: 'cs_1', payment_status: 'unpaid', amount_total: 1, currency: 'usd' }))).toThrow(IgnoredWebhookEvent);
    expect(() => translateStripeEvent(evt('refund.created', { id: 're_1', status: 'pending', amount: 1, currency: 'usd' }))).toThrow(IgnoredWebhookEvent);
    expect(() => translateStripeEvent(evt('customer.created', { id: 'cus_1' }))).toThrow(IgnoredWebhookEvent);
    // الحدث الحي يُرفض قبل الترجمة، والحدث بلا livemode غير صالح
    const live = Buffer.from(JSON.stringify({ id: 'evt_live', type: 'checkout.session.completed', livemode: true, created: 1, data: { object: { id: 'cs_1', payment_status: 'paid', amount_total: 1, currency: 'usd' } } }));
    expect(() => translateStripeEvent(live)).toThrow(LiveModeEvent);
    const bare = Buffer.from(JSON.stringify({ id: 'evt_x', type: 'customer.created', created: 1, data: { object: {} } }));
    expect(() => translateStripeEvent(bare)).toThrow(WebhookSignatureError);
    expect(() => translateStripeEvent(evt('checkout.session.completed', { id: 'cs_1', payment_status: 'paid', amount_total: 1, currency: 'eur' }))).toThrow(WebhookSignatureError);
    expect(() => translateStripeEvent(evt('checkout.session.completed', { id: 'cs_1', payment_status: 'paid', amount_total: 1, currency: 'usd' }, 'not-an-event'))).toThrow(WebhookSignatureError);
  });

  it('configuration: test-mode keys only, both required, never with DEPLOY_STAGE=production', () => {
    const base = { DATABASE_URL: 'postgres://x', JWT_SECRET: 'j'.repeat(40), FIELD_ENCRYPTION_KEY: Buffer.alloc(32).toString('base64'), TUSD_HOOK_SECRET: 't'.repeat(40), S3_BUCKET_UPLOADS: 'uploads', NODE_ENV: 'test' };
    const stripe = { PAYMENT_PROVIDER: 'stripe', STRIPE_TEST_SECRET_KEY: KEY, STRIPE_WEBHOOK_SECRET: WHSEC };
    expect(loadConfig({ ...base, ...stripe }).PAYMENT_PROVIDER).toBe('stripe');
    expect(() => loadConfig({ ...base, ...stripe, STRIPE_TEST_SECRET_KEY: fakeKey('live') })).toThrow(/STRIPE_TEST_SECRET_KEY/);
    expect(() => loadConfig({ ...base, ...stripe, STRIPE_TEST_SECRET_KEY: undefined })).toThrow(/STRIPE_TEST_SECRET_KEY/);
    expect(() => loadConfig({ ...base, ...stripe, STRIPE_WEBHOOK_SECRET: undefined })).toThrow(/STRIPE_WEBHOOK_SECRET/);
    expect(() => loadConfig({ ...base, ...stripe, DEPLOY_STAGE: 'production' })).toThrow(/PAYMENT_PROVIDER/);
    // في الإنتاج لا يُقبل عنوان غير Stripe نفسه، وفي الاختبار يُقبل خادم المحاكاة
    expect(loadConfig({ ...base, ...stripe, STRIPE_API_BASE: 'http://localhost:12111' }).STRIPE_API_BASE).toBe('http://localhost:12111');
    expect(() => loadConfig({ ...base, ...stripe, NODE_ENV: 'production', STRIPE_API_BASE: 'https://stripe.example.test' })).toThrow(/STRIPE_API_BASE/);
    expect(() => loadConfig({ ...base, ...stripe, NODE_ENV: 'production' })).not.toThrow(/STRIPE_API_BASE/);
    expect(() => loadConfig({ ...base, ...stripe, NODE_ENV: 'production', STRIPE_API_BASE: 'https://api.stripe.com/' })).not.toThrow(/STRIPE_API_BASE/);
    // رسالة الإعداد بأسماء المتغيرات وحدها، لا القيم
    expect(() => loadConfig({ ...base, ...stripe, STRIPE_TEST_SECRET_KEY: fakeKey('live') })).not.toThrow(/sk_/);
  });

  it('a Stripe that never answers fails within the timeout as stripe: timeout', async () => {
    const hang = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => init.signal!.addEventListener('abort', () => reject(init.signal!.reason)))) as unknown as typeof fetch;
    const p = new StripeTestProvider(KEY, WHSEC, 'https://stripe.test', hang, 50);
    const started = Date.now();
    await expect(p.createCheckout({ orderId: 'o1', amount: money(100n, 'USD'), returnUrl: '', idempotencyKey: 'k' })).rejects.toThrow('stripe: timeout');
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});
