import { generateKeyPairSync } from 'node:crypto';
import { AttestationRejected } from '../../src/attestation/app-attest';
import { decodeCbor } from '../../src/attestation/cbor';
import { IngestTokenSigner } from '../../src/attestation/ingest-token';
import { AttestationUnavailable, checkPlayVerdict, GooglePlayIntegrityDecoder } from '../../src/attestation/play-integrity';

describe('CBOR decoder', () => {
  it('decodes maps, byte and text strings, arrays and integers', () => {
    // {"a": h'0102', "b": [1, -2, "x"]}
    const data = Buffer.from('a2616142010261628301214178', 'hex');
    const v = decodeCbor(data) as Map<string, unknown>;
    expect(v.get('a')).toEqual(Buffer.from([1, 2]));
    expect(v.get('b')).toEqual([1, -2, Buffer.from('x')]);
  });

  it('rejects indefinite lengths, floats, tags, truncation and trailing bytes', () => {
    for (const hex of ['5f41ff', 'fa3f800000', 'c24101', '4401', 'a1616101ff', '0000']) {
      expect(() => decodeCbor(Buffer.from(hex, 'hex'))).toThrow();
    }
  });
});

describe('Play Integrity', () => {
  const account = () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    return Buffer.from(
      JSON.stringify({ client_email: 'svc@example.iam.gserviceaccount.com', private_key: privateKey.export({ format: 'pem', type: 'pkcs8' }), token_uri: 'https://oauth.test/token' }),
    ).toString('base64');
  };
  const json = (status: number, body: object) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  it('exchanges a signed JWT for an access token once and decodes with it', async () => {
    const calls: Array<{ url: string; auth?: string; body: string }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, auth: (init.headers as Record<string, string>).Authorization, body: String(init.body) });
      return url.includes('oauth.test') ? json(200, { access_token: 'at-1', expires_in: 3600 }) : json(200, { tokenPayloadExternal: { ok: true } });
    }) as unknown as typeof fetch;
    const d = new GooglePlayIntegrityDecoder(account(), 'org.example.app', fetchImpl);
    expect(await d.decode('t1')).toEqual({ ok: true });
    expect(await d.decode('t2')).toEqual({ ok: true });
    expect(calls.map((c) => c.url)).toEqual([
      'https://oauth.test/token',
      'https://playintegrity.googleapis.com/v1/org.example.app:decodeIntegrityToken',
      'https://playintegrity.googleapis.com/v1/org.example.app:decodeIntegrityToken',
    ]);
    expect(calls[0]!.body).toContain('grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer');
    expect(calls[1]!.auth).toBe('Bearer at-1');
  });

  it('a 400 is a failed attestation; 5xx, 429 and network errors are unavailable', async () => {
    const make = (decode: () => Promise<Response>) =>
      new GooglePlayIntegrityDecoder(account(), 'org.example.app', (async (url: string) =>
        url.includes('oauth.test') ? json(200, { access_token: 'at' }) : decode()) as unknown as typeof fetch);
    await expect(make(async () => json(400, {})).decode('t')).rejects.toBeInstanceOf(AttestationRejected);
    await expect(make(async () => json(503, {})).decode('t')).rejects.toBeInstanceOf(AttestationUnavailable);
    await expect(make(async () => json(429, {})).decode('t')).rejects.toBeInstanceOf(AttestationUnavailable);
    await expect(make(async () => Promise.reject(new Error('ECONNRESET'))).decode('t')).rejects.toBeInstanceOf(AttestationUnavailable);
  });

  it('checks every verdict condition', () => {
    const now = 1_800_000_000_000;
    const good = {
      requestDetails: { requestPackageName: 'p.q', requestHash: 'h', timestampMillis: String(now - 1000) },
      appIntegrity: { appRecognitionVerdict: 'PLAY_RECOGNIZED', packageName: 'p.q', certificateSha256Digest: ['c'] },
      deviceIntegrity: { deviceRecognitionVerdict: ['MEETS_DEVICE_INTEGRITY', 'MEETS_BASIC_INTEGRITY'] },
    };
    const expected = { packageName: 'p.q', requestHash: 'h', certDigests: ['c'], now };
    expect(() => checkPlayVerdict(good, expected)).not.toThrow();
    expect(() => checkPlayVerdict({ ...good, requestDetails: { ...good.requestDetails, timestampMillis: String(now + 120_000) } }, expected)).toThrow(AttestationRejected);
    expect(() => checkPlayVerdict(null, expected)).toThrow(AttestationRejected);
  });
});

describe('ingest token signer', () => {
  it('accepts only an EC P-256 PKCS#8 key and caps the lifetime at 900 s', () => {
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ format: 'der', type: 'pkcs8' }) as Buffer;
    expect(() => new IngestTokenSigner(rsa.toString('base64'), 'k')).toThrow();
    const p384 = generateKeyPairSync('ec', { namedCurve: 'P-384' }).privateKey.export({ format: 'der', type: 'pkcs8' }) as Buffer;
    expect(() => new IngestTokenSigner(p384.toString('base64'), 'k')).toThrow();
    const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ format: 'der', type: 'pkcs8' }) as Buffer;
    const signer = new IngestTokenSigner(ec.toString('base64'), 'k');
    const now = new Date('2026-10-20T00:00:00Z');
    const { token, expiresAt } = signer.mint({ sid: '00000000-0000-4000-8000-000000000000', plat: 'ios', expiresAt: new Date(now.getTime() + 3600_000) }, now);
    const claims = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString());
    expect(claims.exp - claims.iat).toBe(900);
    expect(expiresAt.getTime()).toBe(claims.exp * 1000);
    expect(Buffer.from(token.split('.')[2]!, 'base64url')).toHaveLength(64);
  });
});
