import { canonicalJson } from '../../src/common/canonical-json';
import { validateBody } from '../../src/common/contract';
import { ApiError } from '../../src/common/errors';
import { redactPath } from '../../src/common/logger';
import { loadConfig } from '../../src/config/config';
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
  it('blocks after max hits and resets after the window', () => {
    let now = 0;
    const rl = new FixedWindowRateLimiter(2, 10_000, () => now);
    expect([rl.hit('k'), rl.hit('k')]).toEqual([0, 0]);
    expect(rl.hit('k')).toBe(10);
    expect(rl.hit('other')).toBe(0);
    now = 10_000;
    expect(rl.hit('k')).toBe(0);
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
