import { canonicalJson } from '../../src/common/canonical-json';
import { validateBody } from '../../src/common/contract';
import { ApiError } from '../../src/common/errors';
import { redactPath } from '../../src/common/logger';
import { addressAllowed, blockListOf, loadConfig } from '../../src/config/config';
import { requiresIdempotencyKey } from '../../src/idempotency/idempotency.interceptor';
import { FixedWindowRateLimiter } from '../../src/identity/rate-limiter';

describe('canonicalJson', () => {
  it('is independent of key order and drops undefined', () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { y: 2, x: 1 }], c: undefined } })).toBe(
      canonicalJson({ a: { d: [1, { x: 1, y: 2 }] }, b: 1 }),
    );
    expect(canonicalJson(undefined)).toBe('null');
  });
});

describe('redactPath', () => {
  it('hides the tusd hook token and query strings', () => {
    expect(redactPath('/internal/tusd-hooks/s3cr3t-token-value?x=1')).toBe('/internal/tusd-hooks/:hook_token');
    expect(redactPath('/v1/auth/me?token=abc')).toBe('/v1/auth/me');
  });
});

describe('requiresIdempotencyKey', () => {
  it.each([
    ['POST', '/v1/uploads', true],
    ['DELETE', '/v1/push-devices/x', true],
    ['GET', '/v1/materials', false],
    ['POST', '/v1/auth/login', false],
    ['POST', '/v1/auth/logout', false],
    ['POST', '/internal/tusd-hooks/x', false],
  ])('%s %s → %s', (method, path, expected) => {
    expect(requiresIdempotencyKey(method, path)).toBe(expected);
  });
});

describe('FixedWindowRateLimiter', () => {
  it('blocks once recorded failures reach max, resets after the window or on reset()', () => {
    let now = 0;
    const rl = new FixedWindowRateLimiter(2, 10_000, () => now);
    expect(rl.retryAfter('k')).toBe(0);
    rl.record('k');
    expect(rl.retryAfter('k')).toBe(0);
    rl.record('k');
    expect(rl.retryAfter('k')).toBe(10);
    expect(rl.retryAfter('other')).toBe(0);
    now = 10_000;
    expect(rl.retryAfter('k')).toBe(0);
    rl.record('k');
    rl.record('k');
    rl.reset('k');
    expect(rl.retryAfter('k')).toBe(0);
  });
});

describe('addressAllowed', () => {
  const list = blockListOf(['127.0.0.1/32', '172.16.0.0/12', '::1/128']);
  it.each([
    ['127.0.0.1', true],
    ['::ffff:127.0.0.1', true],
    ['172.20.0.5', true],
    ['::1', true],
    ['8.8.8.8', false],
    ['::ffff:8.8.8.8', false],
    [undefined, false],
  ])('%s → %s', (addr, expected) => {
    expect(addressAllowed(list, addr)).toBe(expected);
  });
  it('rejects malformed CIDR configuration by name', () => {
    expect(() => loadConfig({ INTERNAL_ALLOWED_CIDRS: '10.0.0.0/33' } as NodeJS.ProcessEnv)).toThrow(/INTERNAL_ALLOWED_CIDRS/);
  });
});

describe('contract validation', () => {
  it('validates request bodies against contracts/openapi.yaml', () => {
    expect(validateBody('/auth/login', 'post', { email: 'a@b.test', password: '12345678' })).toBeTruthy();
    try {
      validateBody('/auth/login', 'post', { email: 'x', password: 'secretvalue', totp_code: '12' });
      fail('expected validation error');
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      expect((e as ApiError).status).toBe(422);
      expect(JSON.stringify((e as ApiError).details)).not.toContain('secretvalue');
    }
  });
});

describe('loadConfig', () => {
  it('names invalid variables without echoing their values', () => {
    expect(() => loadConfig({ JWT_SECRET: 'too-short-secret-value' } as NodeJS.ProcessEnv)).toThrow(/JWT_SECRET/);
    expect(() => loadConfig({ JWT_SECRET: 'too-short-secret-value' } as NodeJS.ProcessEnv)).not.toThrow(/too-short/);
  });
});

describe('contract validation precision', () => {
  it('accepts two-decimal shares like 33.33 under multipleOf 0.01', () => {
    const body = { contributors: [{ user_id: '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d', role: 'reporter', share_percent: 33.33 }] };
    expect(() => validateBody('/materials/{id}/contributors', 'put', body)).not.toThrow();
    expect(() =>
      validateBody('/materials/{id}/contributors', 'put', { contributors: [{ ...body.contributors[0], share_percent: 33.333 }] }),
    ).toThrow();
  });
});
