import { createSign } from 'node:crypto';

const REQUEST_TIMEOUT_MS = 10_000;

/** تعذر الوصول إلى Google أو رفض مؤقت: يعيد المستدعي المحاولة لاحقًا. */
export class GoogleUnavailable extends Error {
  constructor() {
    super('google endpoint unavailable');
  }
}

/**
 * رمز وصول OAuth بحساب خدمة Google (منحة JWT bearer، RS256)، مخبّأ حتى قبيل انتهائه. يستعمله Play Integrity وFCM.
 * مفتاح الحساب سر من SOPS ولا يُسجَّل؛ `fetchImpl` قابل للحقن للاختبار.
 */
export class GoogleServiceAccountAuth {
  private readonly email: string;
  private readonly privateKey: string;
  private readonly tokenUri: string;
  private access: { token: string; expiresAt: number } | null = null;

  constructor(
    serviceAccountBase64: string,
    private readonly scope: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    const parsed = JSON.parse(Buffer.from(serviceAccountBase64, 'base64').toString('utf8')) as {
      client_email?: string;
      private_key?: string;
      token_uri?: string;
    };
    if (!parsed.client_email || !parsed.private_key) throw new Error('not a Google service account key');
    this.email = parsed.client_email;
    this.privateKey = parsed.private_key;
    this.tokenUri = parsed.token_uri ?? 'https://oauth2.googleapis.com/token';
  }

  async accessToken(): Promise<string> {
    if (this.access && this.access.expiresAt > Date.now() + 60_000) return this.access.token;
    const now = Math.floor(Date.now() / 1000);
    const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const unsigned = `${enc({ alg: 'RS256', typ: 'JWT' })}.${enc({ iss: this.email, scope: this.scope, aud: this.tokenUri, iat: now, exp: now + 3600 })}`;
    const signature = createSign('RSA-SHA256').update(unsigned).sign(this.privateKey).toString('base64url');
    const res = await this.call(this.tokenUri, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${signature}` }).toString(),
    });
    if (!res.ok) throw new GoogleUnavailable();
    const body = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!body.access_token) throw new GoogleUnavailable();
    this.access = { token: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000 };
    return body.access_token;
  }

  async call(url: string, init: RequestInit): Promise<Response> {
    try {
      return await this.fetchImpl(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch {
      throw new GoogleUnavailable();
    }
  }
}
