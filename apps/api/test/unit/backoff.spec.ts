import { totp, totpStep, verifyTotp } from '../../src/common/crypto';
import { backoffDelayMs, MemoryBackoffLimiter } from '../../src/identity/rate-limiter';

// ADR 0117: عدّاد الفشل لكل حساب بتأخير متضاعف، ورقم خطوة TOTP الذي يُحجز قبل قبول الرمز
describe('per-account backoff', () => {
  const policy = { free: 3, baseMs: 1000, maxMs: 8000, forgetMs: 60_000 };

  it('is free up to the allowance, then doubles from the base up to the cap', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8, 40].map((n) => backoffDelayMs(n, policy))).toEqual([0, 0, 0, 1000, 2000, 4000, 8000, 8000, 8000]);
  });

  it('holds the key back after the allowance, lets it retry once the delay passes, and forgets it after a quiet period', async () => {
    let now = 1_000_000;
    const l = new MemoryBackoffLimiter(policy, () => now);
    for (let i = 0; i < 3; i++) await l.record('k');
    expect(await l.retryAfter('k')).toBe(0);
    await l.record('k');
    expect(await l.retryAfter('k')).toBe(1);
    now += 1000;
    expect(await l.retryAfter('k')).toBe(0);
    await l.record('k');
    expect(await l.retryAfter('k')).toBe(2);
    expect(await l.retryAfter('other')).toBe(0);
    now += 61_000;
    await l.record('k');
    expect(await l.retryAfter('k')).toBe(0);
    await l.reset('k');
    expect(await l.retryAfter('k')).toBe(0);
  });
});

describe('totpStep', () => {
  const secret = Buffer.from('12345678901234567890');
  const at = 59_000_000_000;

  it('names the matched step within one step of drift, and null otherwise', () => {
    const step = Math.floor(at / 30_000);
    expect(totpStep(secret, totp(secret, at), at)).toBe(step);
    expect(totpStep(secret, totp(secret, at - 30_000), at)).toBe(step - 1);
    expect(totpStep(secret, totp(secret, at + 30_000), at)).toBe(step + 1);
    expect(totpStep(secret, totp(secret, at + 90_000), at)).toBeNull();
    expect(verifyTotp(secret, totp(secret, at), at)).toBe(true);
    expect(verifyTotp(secret, totp(secret, at - 90_000), at)).toBe(false);
  });
});
