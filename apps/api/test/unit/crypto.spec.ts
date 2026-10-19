import { randomBytes } from 'node:crypto';
import { constantTimeEqual, FieldKeyring, totp, verifyTotp } from '../../src/common/crypto';

describe('totp (RFC 6238, SHA-1)', () => {
  const secret = Buffer.from('12345678901234567890');
  it.each([
    [59, '287082'],
    [1111111109, '081804'],
    [1234567890, '005924'],
    [2000000000, '279037'],
  ])('T=%i → %s', (t, code) => {
    expect(totp(secret, t * 1000)).toBe(code);
  });

  it('accepts ±1 step and rejects further drift', () => {
    const now = 1_700_000_000_000;
    expect(verifyTotp(secret, totp(secret, now - 30_000), now)).toBe(true);
    expect(verifyTotp(secret, totp(secret, now + 30_000), now)).toBe(true);
    expect(verifyTotp(secret, totp(secret, now - 90_000), now)).toBe(false);
  });
});

describe('field encryption (AES-256-GCM, versioned keys)', () => {
  const k1 = { version: 1, key: randomBytes(32) };
  const k2 = { version: 2, key: randomBytes(32) };
  const ring = new FieldKeyring(k1);
  it('round-trips, prefixes the key version and uses a fresh IV each time', () => {
    const a = ring.encrypt(Buffer.from('secret'));
    const b = ring.encrypt(Buffer.from('secret'));
    expect(a.equals(b)).toBe(false);
    expect(a[0]).toBe(1);
    expect(ring.decrypt(a).toString()).toBe('secret');
  });
  it('rejects tampering, a swapped version byte, the wrong key and an unknown version', () => {
    const blob = ring.encrypt(Buffer.from('secret'));
    const tampered = Buffer.from(blob);
    tampered[tampered.length - 1]! ^= 1;
    expect(() => ring.decrypt(tampered)).toThrow();
    // بايت الإصدار مصادَق عليه: تبديله إلى إصدار معروف آخر يفشل التحقق ولا يفك بمفتاح آخر
    const both = new FieldKeyring(k1, { version: 2, key: k1.key });
    const swapped = Buffer.from(blob);
    swapped[0] = 2;
    expect(() => both.decrypt(swapped)).toThrow();
    expect(() => new FieldKeyring({ version: 1, key: randomBytes(32) }).decrypt(blob)).toThrow();
    expect(() => new FieldKeyring(k2).decrypt(blob)).toThrow('unknown key version');
  });
  it('rotation: the new key writes, the previous one still reads, and old blobs are reported stale', () => {
    const old = ring.encrypt(Buffer.from('before rotation'));
    const rotated = new FieldKeyring(k2, k1);
    const fresh = rotated.encrypt(Buffer.from('after rotation'));
    expect(fresh[0]).toBe(2);
    expect(rotated.decrypt(old).toString()).toBe('before rotation');
    expect(rotated.decrypt(fresh).toString()).toBe('after rotation');
    expect([rotated.isStale(old), rotated.isStale(fresh)]).toEqual([true, false]);
    // بعد إزالة السابق لا يُقرأ ما كُتب به
    expect(() => new FieldKeyring(k2).decrypt(old)).toThrow();
  });
  it('refuses duplicate versions, out-of-range versions and short keys', () => {
    expect(() => new FieldKeyring(k1, { version: 1, key: randomBytes(32) })).toThrow();
    expect(() => new FieldKeyring({ version: 0, key: randomBytes(32) })).toThrow();
    expect(() => new FieldKeyring({ version: 256, key: randomBytes(32) })).toThrow();
    expect(() => new FieldKeyring({ version: 3, key: randomBytes(16) })).toThrow();
  });
});

describe('constantTimeEqual', () => {
  it('compares strings of any length', () => {
    expect(constantTimeEqual('abc', 'abc')).toBe(true);
    expect(constantTimeEqual('abc', 'abcd')).toBe(false);
    expect(constantTimeEqual('', 'a')).toBe(false);
  });
});
