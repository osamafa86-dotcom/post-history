import { createSign } from 'node:crypto';
import { AttestationRejected } from './app-attest';

/** Google غير متاح (شبكة، 5xx، حصة): 503 attestation_unavailable، ويبقى العميل على النطاق الرئيسي. */
export class AttestationUnavailable extends Error {
  constructor(readonly retryAfterSeconds = 30) {
    super('attestation provider unavailable');
  }
}

/** يفك رمز Play Integrity إلى الحكم (tokenPayloadExternal). */
export interface PlayIntegrityDecoder {
  decode(integrityToken: string): Promise<unknown>;
}

const SCOPE = 'https://www.googleapis.com/auth/playintegrity';
const REQUEST_TIMEOUT_MS = 10_000;

interface ServiceAccount {
  client_email: string;
  private_key: string;
  token_uri: string;
}

/**
 * واجهة Google: decodeIntegrityToken بحساب خدمة (منحة JWT bearer، RS256). الرمز والحكم لا يُسجَّلان؛ مفتاح الحساب
 * سر من SOPS. `fetchImpl` قابل للحقن للاختبار.
 */
export class GooglePlayIntegrityDecoder implements PlayIntegrityDecoder {
  private readonly account: ServiceAccount;
  private access: { token: string; expiresAt: number } | null = null;

  constructor(
    serviceAccountBase64: string,
    private readonly packageName: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    const parsed = JSON.parse(Buffer.from(serviceAccountBase64, 'base64').toString('utf8')) as Partial<ServiceAccount>;
    if (!parsed.client_email || !parsed.private_key) throw new Error('PLAY_INTEGRITY_SERVICE_ACCOUNT is not a service account key');
    this.account = { client_email: parsed.client_email, private_key: parsed.private_key, token_uri: parsed.token_uri ?? 'https://oauth2.googleapis.com/token' };
  }

  async decode(integrityToken: string): Promise<unknown> {
    const res = await this.call(`https://playintegrity.googleapis.com/v1/${encodeURIComponent(this.packageName)}:decodeIntegrityToken`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${await this.accessToken()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ integrity_token: integrityToken }),
    });
    // 400: رمز تالف أو لحزمة أخرى، فهو فشل شهادة لا تعذّر خدمة
    if (res.status === 400) throw new AttestationRejected('play_integrity_invalid_token');
    if (!res.ok) throw new AttestationUnavailable();
    const body = (await res.json()) as { tokenPayloadExternal?: unknown };
    if (!body.tokenPayloadExternal) throw new AttestationRejected('play_integrity_payload');
    return body.tokenPayloadExternal;
  }

  private async accessToken(): Promise<string> {
    if (this.access && this.access.expiresAt > Date.now() + 60_000) return this.access.token;
    const now = Math.floor(Date.now() / 1000);
    const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const unsigned = `${enc({ alg: 'RS256', typ: 'JWT' })}.${enc({ iss: this.account.client_email, scope: SCOPE, aud: this.account.token_uri, iat: now, exp: now + 3600 })}`;
    const signature = createSign('RSA-SHA256').update(unsigned).sign(this.account.private_key).toString('base64url');
    const res = await this.call(this.account.token_uri, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${signature}` }).toString(),
    });
    if (!res.ok) throw new AttestationUnavailable();
    const body = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!body.access_token) throw new AttestationUnavailable();
    this.access = { token: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000 };
    return body.access_token;
  }

  private async call(url: string, init: RequestInit): Promise<Response> {
    try {
      return await this.fetchImpl(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch {
      throw new AttestationUnavailable();
    }
  }
}

/**
 * ATTESTATION_MODE=test فقط: الرمز هو الحكم نفسه بـ base64url(JSON) بلا توقيع، لاختبار شروط الحكم دون Google. ممنوع
 * في الإنتاج بفحص الإعداد.
 */
export class UnsignedTestDecoder implements PlayIntegrityDecoder {
  async decode(integrityToken: string): Promise<unknown> {
    try {
      return JSON.parse(Buffer.from(integrityToken, 'base64url').toString('utf8'));
    } catch {
      throw new AttestationRejected('play_integrity_invalid_token');
    }
  }
}

const MAX_AGE_MS = 5 * 60_000;

/**
 * شروط الحكم (ADR 0011): requestHash وrequestPackageName مطابقان، والتطبيق معروف لـ Play بإحدى بصمات التوقيع،
 * والجهاز يحمل MEETS_DEVICE_INTEGRITY، والطابع الزمني أحدث من 5 دقائق. لا يُقرأ accountDetails ولا يُخزَّن شيء من الحكم.
 */
export function checkPlayVerdict(
  payload: unknown,
  expected: { packageName: string; requestHash: string; certDigests: string[]; now?: number },
): void {
  const p = (payload ?? {}) as {
    requestDetails?: { requestPackageName?: string; requestHash?: string; timestampMillis?: string | number };
    appIntegrity?: { appRecognitionVerdict?: string; packageName?: string; certificateSha256Digest?: string[] };
    deviceIntegrity?: { deviceRecognitionVerdict?: string[] };
  };
  const now = expected.now ?? Date.now();
  const req = p.requestDetails;
  if (req?.requestPackageName !== expected.packageName || req.requestHash !== expected.requestHash) throw new AttestationRejected('request');
  const ts = Number(req.timestampMillis);
  if (!Number.isFinite(ts) || ts > now + 60_000 || now - ts > MAX_AGE_MS) throw new AttestationRejected('timestamp');
  const app = p.appIntegrity;
  if (app?.appRecognitionVerdict !== 'PLAY_RECOGNIZED' || app.packageName !== expected.packageName) throw new AttestationRejected('app');
  if (!app.certificateSha256Digest?.some((d) => expected.certDigests.includes(d))) throw new AttestationRejected('certificate');
  if (!p.deviceIntegrity?.deviceRecognitionVerdict?.includes('MEETS_DEVICE_INTEGRITY')) throw new AttestationRejected('device');
}
