import { GoogleServiceAccountAuth, GoogleUnavailable } from '../common/google-auth';
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

/**
 * واجهة Google: decodeIntegrityToken بحساب خدمة (common/google-auth.ts). الرمز والحكم لا يُسجَّلان؛ مفتاح الحساب
 * سر من SOPS. `fetchImpl` قابل للحقن للاختبار.
 */
export class GooglePlayIntegrityDecoder implements PlayIntegrityDecoder {
  private readonly auth: GoogleServiceAccountAuth;

  constructor(
    serviceAccountBase64: string,
    private readonly packageName: string,
    fetchImpl: typeof fetch = fetch,
  ) {
    try {
      this.auth = new GoogleServiceAccountAuth(serviceAccountBase64, SCOPE, fetchImpl);
    } catch {
      throw new Error('PLAY_INTEGRITY_SERVICE_ACCOUNT is not a service account key');
    }
  }

  async decode(integrityToken: string): Promise<unknown> {
    try {
      const res = await this.auth.call(`https://playintegrity.googleapis.com/v1/${encodeURIComponent(this.packageName)}:decodeIntegrityToken`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${await this.auth.accessToken()}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ integrity_token: integrityToken }),
      });
      // 400: رمز تالف أو لحزمة أخرى، فهو فشل شهادة لا تعذّر خدمة
      if (res.status === 400) throw new AttestationRejected('play_integrity_invalid_token');
      if (!res.ok) throw new AttestationUnavailable();
      const body = (await res.json()) as { tokenPayloadExternal?: unknown };
      if (!body.tokenPayloadExternal) throw new AttestationRejected('play_integrity_payload');
      return body.tokenPayloadExternal;
    } catch (err) {
      if (err instanceof GoogleUnavailable) throw new AttestationUnavailable();
      throw err;
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
