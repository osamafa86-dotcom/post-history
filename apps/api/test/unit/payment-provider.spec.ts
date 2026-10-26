import { randomBytes } from 'node:crypto';
import { loadConfig } from '../../src/config/config';
import { money } from '../../src/commerce/money';
import { SandboxPaymentProvider, signWebhook, verifySignedWebhook, WebhookSignatureError } from '../../src/commerce/payment-provider';

const secret = randomBytes(32).toString('hex');
const now = new Date('2026-10-26T10:00:00Z');
const ts = Math.floor(now.getTime() / 1000);
const event = (over: Record<string, unknown> = {}) =>
  Buffer.from(
    JSON.stringify({ event_id: 'evt_1', type: 'payment.succeeded', provider_ref: 'sbx_1', amount: { amount_minor: 15000, currency: 'USD' }, occurred_at: now.toISOString(), ...over }),
  );
const signed = (body: Buffer, at = ts, key = secret) => ({ 'x-timestamp': String(at), 'x-signature': `v1=${signWebhook(key, at, body)}` });

// الإشعار الموقَّع (ADR 0032 §2): HMAC على timestamp.body، ونافذة ±5 دقائق، والتحقق قبل التحليل
describe('signed provider webhook', () => {
  it('accepts a correctly signed event in the window and returns its fields only', () => {
    const body = event();
    expect(verifySignedWebhook(secret, body, signed(body), now)).toEqual({
      eventId: 'evt_1',
      type: 'payment.succeeded',
      providerRef: 'sbx_1',
      amount: money(15000, 'USD'),
      occurredAt: now,
    });
  });

  it('refuses a wrong key, a tampered body, missing headers, and a timestamp outside ±5 minutes', () => {
    const body = event();
    const cases: Array<[Buffer, Record<string, string | undefined>]> = [
      [body, signed(body, ts, randomBytes(32).toString('hex'))],
      [event({ amount: { amount_minor: 1, currency: 'USD' } }), signed(body)],
      [body, {}],
      [body, { 'x-timestamp': String(ts), 'x-signature': 'zz' }],
      [body, { 'x-timestamp': String(ts), 'x-signature': signWebhook(secret, ts, body) }],
      [body, signed(body, ts - 301)],
      [body, signed(body, ts + 301)],
    ];
    for (const [b, h] of cases) expect(() => verifySignedWebhook(secret, b, h, now)).toThrow(WebhookSignatureError);
    expect(() => verifySignedWebhook(secret, body, signed(body, ts - 299), now)).not.toThrow();
  });

  it('refuses a signed body whose fields are invalid: unknown type, non-integer or zero amount, unknown currency, bad date', () => {
    for (const over of [{ type: 'payment.maybe' }, { amount: { amount_minor: 1.5, currency: 'USD' } }, { amount: { amount_minor: 0, currency: 'USD' } }, { amount: { amount_minor: 1, currency: 'EUR' } }, { occurred_at: 'soon' }, { event_id: 'a b' }]) {
      const body = event(over);
      expect(() => verifySignedWebhook(secret, body, signed(body), now)).toThrow(WebhookSignatureError);
    }
    const notJson = Buffer.from('not json');
    expect(() => verifySignedWebhook(secret, notJson, signed(notJson), now)).toThrow(WebhookSignatureError);
  });
});

describe('sandbox payment provider', () => {
  it('checkout is idempotent per key; settle signs an event the same provider verifies; refund only after success, once per key', async () => {
    const p = new SandboxPaymentProvider(secret, 'http://api.test/');
    const a = await p.createCheckout({ orderId: 'o1', amount: money(500, 'ILS'), returnUrl: 'http://x', idempotencyKey: 'k1' });
    const b = await p.createCheckout({ orderId: 'o1', amount: money(500, 'ILS'), returnUrl: 'http://x', idempotencyKey: 'k1' });
    expect(b.providerRef).toBe(a.providerRef);
    expect(a.checkoutUrl).toBe(`http://api.test/sandbox/checkout/${a.providerRef}`);
    await expect(p.refund({ providerRef: a.providerRef, amount: money(500, 'ILS'), idempotencyKey: 'r1' })).rejects.toThrow();
    const { body, headers } = p.settle(a.providerRef, 'succeeded', now);
    expect(p.verifyWebhook(body, headers, now)).toMatchObject({ type: 'payment.succeeded', providerRef: a.providerRef, amount: money(500, 'ILS') });
    expect(await p.status(a.providerRef)).toBe('succeeded');
    const r1 = await p.refund({ providerRef: a.providerRef, amount: money(500, 'ILS'), idempotencyKey: 'r1' });
    expect(await p.refund({ providerRef: a.providerRef, amount: money(500, 'ILS'), idempotencyKey: 'r1' })).toEqual(r1);
  });

  it('configuration: sandbox needs its webhook secret and never boots in production', () => {
    const base = { DATABASE_URL: 'postgres://x', JWT_SECRET: 'j'.repeat(40), FIELD_ENCRYPTION_KEY: Buffer.alloc(32).toString('base64'), TUSD_HOOK_SECRET: 't'.repeat(40), S3_BUCKET_UPLOADS: 'uploads' };
    expect(() => loadConfig({ ...base, NODE_ENV: 'test', PAYMENT_PROVIDER: 'sandbox' })).toThrow(/SANDBOX_WEBHOOK_SECRET/);
    expect(loadConfig({ ...base, NODE_ENV: 'test', PAYMENT_PROVIDER: 'sandbox', SANDBOX_WEBHOOK_SECRET: secret }).PAYMENT_PROVIDER).toBe('sandbox');
    expect(() => loadConfig({ ...base, NODE_ENV: 'production', REDIS_URL: 'redis://x', UPLOAD_VERIFIER: 'external', MEDIA_WORKER_TOKEN: 'm'.repeat(40), PAYMENT_PROVIDER: 'sandbox', SANDBOX_WEBHOOK_SECRET: secret })).toThrow(
      /PAYMENT_PROVIDER/,
    );
  });
});
