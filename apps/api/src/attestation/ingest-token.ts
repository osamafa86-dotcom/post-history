import { createPrivateKey, createPublicKey, type KeyObject, randomUUID, sign } from 'node:crypto';

export interface IngestClaims {
  sid: string;
  plat: 'ios' | 'android';
  expiresAt: Date;
}

/**
 * رمز بوابة ingest (ADR 0011، infra/ingest/ingest_token.js): JWT ES256 بترويسة {alg, typ, kid} والمطالبات
 * aud=ingest، sid، iat، exp (≤ 900 ث بعد iat)، jti، plat. البوابة تتحقق بالمفتاح العام وحده ولا تتبع jti.
 * kid يسمّي المفتاح للتدوير: البوابة تحمل العامّين القديم والجديد فترة، والخادم يوقّع بالجديد وحده.
 */
export class IngestTokenSigner {
  private readonly key: KeyObject;

  constructor(
    pkcs8Base64: string,
    private readonly keyId: string,
  ) {
    this.key = createPrivateKey({ key: Buffer.from(pkcs8Base64, 'base64'), format: 'der', type: 'pkcs8' });
    const { namedCurve } = this.key.asymmetricKeyDetails ?? {};
    if (this.key.asymmetricKeyType !== 'ec' || namedCurve !== 'prime256v1') {
      throw new Error('INGEST_TOKEN_SIGNING_KEY must be an EC P-256 private key (PKCS#8 DER, base64)');
    }
  }

  /** المفتاح العام (SPKI DER، base64) كما تحمله البوابة في INGEST_TOKEN_PUBLIC_KEY. */
  publicKeyBase64(): string {
    return (createPublicKey(this.key).export({ format: 'der', type: 'spki' }) as Buffer).toString('base64');
  }

  mint(claims: IngestClaims, now = new Date()): { token: string; expiresAt: Date } {
    const iat = Math.floor(now.getTime() / 1000);
    const exp = Math.min(Math.floor(claims.expiresAt.getTime() / 1000), iat + 900);
    const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const signingInput = `${enc({ alg: 'ES256', typ: 'JWT', kid: this.keyId })}.${enc({
      aud: 'ingest',
      sid: claims.sid,
      iat,
      exp,
      jti: randomUUID(),
      plat: claims.plat,
    })}`;
    // JWS ES256: التوقيع r ‖ s بطول ثابت (IEEE P1363)، لا DER
    const signature = sign('sha256', Buffer.from(signingInput), { key: this.key, dsaEncoding: 'ieee-p1363' });
    return { token: `${signingInput}.${signature.toString('base64url')}`, expiresAt: new Date(exp * 1000) };
  }
}
