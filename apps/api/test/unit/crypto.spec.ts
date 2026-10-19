import { randomBytes } from 'node:crypto';
import { constantTimeEqual, decryptField, encryptField, totp, verifyTotp } from '../../src/common/crypto';

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

describe('field encryption (AES-256-GCM)', () => {
  const key = randomBytes(32);
  it('round-trips and uses a fresh IV each time', () => {
    const a = encryptField(key, Buffer.from('secret'));
    const b = encryptField(key, Buffer.from('secret'));
    expect(a.equals(b)).toBe(false);
    expect(decryptField(key, a).toString()).toBe('secret');
  });
  it('rejects tampering and the wrong key', () => {
    const blob = encryptField(key, Buffer.from('secret'));
    blob[blob.length - 1]! ^= 1;
    expect(() => decryptField(key, blob)).toThrow();
    expect(() => decryptField(randomBytes(32), encryptField(key, Buffer.from('x')))).toThrow();
  });
});

describe('constantTimeEqual', () => {
  it('compares strings of any length', () => {
    expect(constantTimeEqual('abc', 'abc')).toBe(true);
    expect(constantTimeEqual('abc', 'abcd')).toBe(false);
    expect(constantTimeEqual('', 'a')).toBe(false);
  });
});
