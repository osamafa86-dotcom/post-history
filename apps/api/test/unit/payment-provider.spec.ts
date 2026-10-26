import { randomBytes } from 'node:crypto';
import { loadConfig, sandboxBootWarning } from '../../src/config/config';
import { money } from '../../src/commerce/money';
import { SandboxCheckoutController } from '../../src/commerce/orders.controller';
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

  describe('configuration (ADR 0032)', () => {
    const base = { DATABASE_URL: 'postgres://x', JWT_SECRET: 'j'.repeat(40), FIELD_ENCRYPTION_KEY: Buffer.alloc(32).toString('base64'), TUSD_HOOK_SECRET: 't'.repeat(40), S3_BUCKET_UPLOADS: 'uploads' };
    const prod = { ...base, NODE_ENV: 'production', REDIS_URL: 'redis://x', UPLOAD_VERIFIER: 'external', MEDIA_WORKER_TOKEN: 'm'.repeat(40) };
    const sandbox = { PAYMENT_PROVIDER: 'sandbox', SANDBOX_WEBHOOK_SECRET: secret };

    it('sandbox needs its webhook secret, and boots outside production', () => {
      expect(() => loadConfig({ ...base, NODE_ENV: 'test', PAYMENT_PROVIDER: 'sandbox' })).toThrow(/SANDBOX_WEBHOOK_SECRET/);
      expect(loadConfig({ ...base, NODE_ENV: 'test', ...sandbox }).PAYMENT_PROVIDER).toBe('sandbox');
    });

    it('in NODE_ENV=production it boots only with DEPLOY_STAGE=trial and PAYMENT_SANDBOX_ALLOWED=1 together', () => {
      expect(() => loadConfig({ ...prod, ...sandbox })).toThrow(/PAYMENT_PROVIDER/);
      expect(() => loadConfig({ ...prod, ...sandbox, DEPLOY_STAGE: 'trial' })).toThrow(/PAYMENT_PROVIDER/);
      expect(() => loadConfig({ ...prod, ...sandbox, PAYMENT_SANDBOX_ALLOWED: '1' })).toThrow(/PAYMENT_PROVIDER/);
      expect(() => loadConfig({ ...prod, ...sandbox, DEPLOY_STAGE: 'local', PAYMENT_SANDBOX_ALLOWED: '1' })).toThrow(/PAYMENT_PROVIDER/);
      expect(loadConfig({ ...prod, ...sandbox, DEPLOY_STAGE: 'trial', PAYMENT_SANDBOX_ALLOWED: '1' }).PAYMENT_PROVIDER).toBe('sandbox');
    });

    it('DEPLOY_STAGE=production refuses sandbox always, whatever NODE_ENV and the flag', () => {
      expect(() => loadConfig({ ...prod, ...sandbox, DEPLOY_STAGE: 'production', PAYMENT_SANDBOX_ALLOWED: '1' })).toThrow(/PAYMENT_PROVIDER/);
      expect(() => loadConfig({ ...base, NODE_ENV: 'development', ...sandbox, DEPLOY_STAGE: 'production', PAYMENT_SANDBOX_ALLOWED: '1' })).toThrow(/PAYMENT_PROVIDER/);
      expect(loadConfig({ ...prod, DEPLOY_STAGE: 'production' }).PAYMENT_PROVIDER).toBe('none');
    });

    it('every boot with sandbox writes a warning line; none without it', () => {
      expect(sandboxBootWarning({ PAYMENT_PROVIDER: 'sandbox', NODE_ENV: 'production', DEPLOY_STAGE: 'trial' })).toMatch(/sandbox payment provider is active.*DEPLOY_STAGE=trial/);
      expect(sandboxBootWarning({ PAYMENT_PROVIDER: 'none', NODE_ENV: 'production', DEPLOY_STAGE: 'production' })).toBeNull();
    });
  });
});

describe('sandbox checkout page in the trial (NODE_ENV=production behind the two flags)', () => {
  const page = async (provider: SandboxPaymentProvider | null, ref: string) => {
    const sent: string[] = [];
    const res = { setHeader: () => undefined, type: () => ({ send: (html: string) => sent.push(html) }) };
    new SandboxCheckoutController({} as never, provider as never).page(ref, res as never);
    return sent[0];
  };

  it('serves the page and the outcomes: the field-trial host runs with NODE_ENV=production, and the page was a 404 there', async () => {
    const prod = { DATABASE_URL: 'postgres://x', JWT_SECRET: 'j'.repeat(40), FIELD_ENCRYPTION_KEY: Buffer.alloc(32).toString('base64'), TUSD_HOOK_SECRET: 't'.repeat(40), S3_BUCKET_UPLOADS: 'uploads',
      NODE_ENV: 'production', REDIS_URL: 'redis://x', UPLOAD_VERIFIER: 'external', MEDIA_WORKER_TOKEN: 'm'.repeat(40),
      PAYMENT_PROVIDER: 'sandbox', SANDBOX_WEBHOOK_SECRET: secret, DEPLOY_STAGE: 'trial', PAYMENT_SANDBOX_ALLOWED: '1' };
    const config = loadConfig(prod);
    expect(config.NODE_ENV).toBe('production');
    const provider = new SandboxPaymentProvider(config.SANDBOX_WEBHOOK_SECRET!, config.SANDBOX_CHECKOUT_BASE_URL);
    const { providerRef } = await provider.createCheckout({ orderId: 'o1', amount: money(12345, 'USD'), returnUrl: 'http://x', idempotencyKey: 'k1' });
    expect(await page(provider, providerRef)).toContain('123.45 USD');
  });

  it('is still a 404 without the sandbox provider, and for an unknown reference', async () => {
    const provider = new SandboxPaymentProvider(secret, 'http://api.test');
    await expect(page(null, 'sbx_x')).rejects.toThrow(/Not Found/);
    await expect(page(provider, 'sbx_unknown')).rejects.toThrow();
  });
});

describe('sandbox return page and license download settings', () => {
  const base = { DATABASE_URL: 'postgres://x', JWT_SECRET: 'j'.repeat(40), FIELD_ENCRYPTION_KEY: Buffer.alloc(32).toString('base64'), TUSD_HOOK_SECRET: 't'.repeat(40), S3_BUCKET_UPLOADS: 'uploads', NODE_ENV: 'test' };

  it('the return page is https, or http on localhost only; empty means no return', () => {
    expect(loadConfig({ ...base, SANDBOX_RETURN_URL: 'https://web.example/ar/orders/{order_id}' }).SANDBOX_RETURN_URL).toBe('https://web.example/ar/orders/{order_id}');
    expect(loadConfig({ ...base, SANDBOX_RETURN_URL: 'http://localhost:3001/orders/{order_id}' }).SANDBOX_RETURN_URL).toBeDefined();
    expect(() => loadConfig({ ...base, SANDBOX_RETURN_URL: 'http://web.example/orders' })).toThrow(/SANDBOX_RETURN_URL/);
    expect(() => loadConfig({ ...base, SANDBOX_RETURN_URL: 'javascript:alert(1)' })).toThrow(/SANDBOX_RETURN_URL/);
    expect(loadConfig({ ...base, SANDBOX_RETURN_URL: '' }).SANDBOX_RETURN_URL).toBeUndefined();
  });

  it('the download link lives minutes by default and never beyond 24 hours', () => {
    expect(loadConfig(base)).toMatchObject({ LICENSE_DOWNLOAD_URL_SECONDS: 600, LICENSE_DOWNLOAD_LIMIT: 5 });
    expect(() => loadConfig({ ...base, LICENSE_DOWNLOAD_URL_SECONDS: '86401' })).toThrow(/LICENSE_DOWNLOAD_URL_SECONDS/);
  });
});
