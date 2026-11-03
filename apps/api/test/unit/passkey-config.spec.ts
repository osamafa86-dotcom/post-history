import { webauthnIssues } from '../../src/config/config';
import { userHandle } from '../../src/identity/passkeys.service';
import { matchesChallenge } from '../../src/identity/webauthn-challenges';
import { sha256 } from '../../src/common/crypto';

// مفاتيح المرور (ADR 0107): RP ID ومصادره من البيئة، بقاعدة WebAuthn (المضيف هو النطاق أو تحته) وhttps إلا localhost خارج الإنتاج
describe('WebAuthn environment', () => {
  const base = { NODE_ENV: 'production', WEBAUTHN_ORIGINS: [] as string[] };
  const paths = (c: Partial<typeof base> & { WEBAUTHN_RP_ID?: string }) => webauthnIssues({ ...base, ...c }).map((i) => i.path[0]);

  it('is off without an RP ID, and origins alone are refused', () => {
    expect(paths({})).toEqual([]);
    expect(paths({ WEBAUTHN_ORIGINS: ['https://app.example.invalid'] })).toEqual(['WEBAUTHN_RP_ID']);
  });

  it('needs at least one origin on or under the RP ID, https in production', () => {
    expect(paths({ WEBAUTHN_RP_ID: 'example.invalid' })).toEqual(['WEBAUTHN_ORIGINS']);
    expect(paths({ WEBAUTHN_RP_ID: 'example.invalid', WEBAUTHN_ORIGINS: ['https://example.invalid', 'https://web.example.invalid:8443'] })).toEqual([]);
    for (const bad of ['http://example.invalid', 'https://example.invalid/', 'https://example.invalid/login', 'https://evil-example.invalid', 'https://other.invalid', 'example.invalid']) {
      expect(paths({ WEBAUTHN_RP_ID: 'example.invalid', WEBAUTHN_ORIGINS: [bad] })).toEqual(['WEBAUTHN_ORIGINS']);
    }
  });

  it('allows http on localhost outside production only', () => {
    expect(paths({ NODE_ENV: 'test', WEBAUTHN_RP_ID: 'localhost', WEBAUTHN_ORIGINS: ['http://localhost:3000'] })).toEqual([]);
    expect(paths({ WEBAUTHN_RP_ID: 'localhost', WEBAUTHN_ORIGINS: ['http://localhost:3000'] })).toEqual(['WEBAUTHN_ORIGINS']);
  });

  it('the user handle is the 16 bytes of the account id, and challenges compare by digest', () => {
    expect(userHandle('00112233-4455-6677-8899-aabbccddeeff').toString('hex')).toBe('00112233445566778899aabbccddeeff');
    const match = matchesChallenge(sha256('abc'));
    expect(match('abc')).toBe(true);
    expect(match('abd')).toBe(false);
    expect(match('a'.repeat(600))).toBe(false);
  });
});
