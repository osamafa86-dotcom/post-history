import { createPrivateKey, type KeyObject, sign } from 'node:crypto';
import { connect, type ClientHttp2Session, constants } from 'node:http2';
import { GoogleServiceAccountAuth, GoogleUnavailable } from '../common/google-auth';

/**
 * حمولة الدفع: قائمة بيضاء ثابتة. العنوان من قوالب messages.ts (رقم المادة وحالتها فقط)، والباقي معرّفات. لا عنوان
 * مادة ولا اسم مصدر ولا موقع ولا اسم مستخدم، ولا يُبنى شيء هنا من حقول حرة.
 */
export interface PushPayload {
  notification_id: string;
  type: string;
  material_id: string | null;
  priority: 'urgent' | 'important' | 'normal';
  title: string;
}

/** نتيجة إرسال إلى جهاز واحد: ok، أو رمز الجهاز لم يعد صالحًا (يُبطل)، أو خطأ مؤقت يُعاد. */
export type PushResult = 'ok' | 'invalid_token' | 'retry';

export interface PushSender {
  send(deviceToken: string, payload: PushPayload): Promise<PushResult>;
}

export const APNS_SENDER = Symbol('APNS_SENDER');
export const FCM_SENDER = Symbol('FCM_SENDER');

/**
 * APNs بواجهة HTTP/2 ومصادقة رمز المزوّد (JWT ES256 بمفتاح .p8، يُجدَّد كل 50 دقيقة). الرمز في المسار ولا يُسجَّل.
 * 410 أو BadDeviceToken أو Unregistered = رمز غير صالح؛ 429 و5xx وأخطاء الاتصال = إعادة.
 */
export class ApnsSender implements PushSender {
  private readonly key: KeyObject;
  private session: ClientHttp2Session | null = null;
  private jwt: { token: string; at: number } | null = null;

  constructor(
    private readonly opts: { teamId: string; keyId: string; privateKeyPem: string; topic: string; host: string },
  ) {
    this.key = createPrivateKey(opts.privateKeyPem);
  }

  async send(deviceToken: string, payload: PushPayload): Promise<PushResult> {
    const body = JSON.stringify({
      aps: { alert: { title: payload.title }, ...(payload.priority === 'urgent' ? { sound: 'default', 'interruption-level': 'time-sensitive' } : {}) },
      notification_id: payload.notification_id,
      type: payload.type,
      material_id: payload.material_id,
      priority: payload.priority,
    });
    try {
      const { status, reason } = await this.request(deviceToken, body, payload.priority === 'normal' ? '5' : '10');
      if (status === 200) return 'ok';
      if (status === 410 || reason === 'BadDeviceToken' || reason === 'Unregistered' || reason === 'DeviceTokenNotForTopic') return 'invalid_token';
      return 'retry';
    } catch {
      this.session?.destroy();
      this.session = null;
      return 'retry';
    }
  }

  close(): void {
    this.session?.close();
  }

  private request(deviceToken: string, body: string, priority: string): Promise<{ status: number; reason?: string }> {
    if (!this.session || this.session.closed || this.session.destroyed) this.session = connect(`https://${this.opts.host}`);
    const req = this.session.request({
      [constants.HTTP2_HEADER_METHOD]: 'POST',
      [constants.HTTP2_HEADER_PATH]: `/3/device/${encodeURIComponent(deviceToken)}`,
      authorization: `bearer ${this.providerToken()}`,
      'apns-topic': this.opts.topic,
      'apns-push-type': 'alert',
      'apns-priority': priority,
      'content-type': 'application/json',
    });
    return new Promise((resolve, reject) => {
      let status = 0;
      let data = '';
      req.setTimeout(10_000, () => req.close(constants.NGHTTP2_CANCEL));
      req.on('response', (h) => (status = Number(h[constants.HTTP2_HEADER_STATUS])));
      req.on('data', (c: Buffer) => (data += c.toString()));
      req.on('end', () => {
        let reason: string | undefined;
        try {
          reason = data ? (JSON.parse(data) as { reason?: string }).reason : undefined;
        } catch {
          reason = undefined;
        }
        resolve({ status, reason });
      });
      req.on('error', reject);
      req.end(body);
    });
  }

  private providerToken(): string {
    if (this.jwt && Date.now() - this.jwt.at < 50 * 60_000) return this.jwt.token;
    const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const input = `${enc({ alg: 'ES256', kid: this.opts.keyId })}.${enc({ iss: this.opts.teamId, iat: Math.floor(Date.now() / 1000) })}`;
    const signature = sign('sha256', Buffer.from(input), { key: this.key, dsaEncoding: 'ieee-p1363' }).toString('base64url');
    this.jwt = { token: `${input}.${signature}`, at: Date.now() };
    return this.jwt.token;
  }
}

/**
 * FCM HTTP v1 بحساب خدمة. البيانات كلها في `data` (نصوص) والعنوان في `notification`. 404/UNREGISTERED أو
 * INVALID_ARGUMENT على الرمز = غير صالح؛ 429 و5xx = إعادة.
 */
export class FcmSender implements PushSender {
  private readonly auth: GoogleServiceAccountAuth;

  constructor(
    private readonly projectId: string,
    serviceAccountBase64: string,
    fetchImpl: typeof fetch = fetch,
  ) {
    this.auth = new GoogleServiceAccountAuth(serviceAccountBase64, 'https://www.googleapis.com/auth/firebase.messaging', fetchImpl);
  }

  async send(deviceToken: string, payload: PushPayload): Promise<PushResult> {
    try {
      const res = await this.auth.call(`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(this.projectId)}/messages:send`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${await this.auth.accessToken()}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: {
            token: deviceToken,
            notification: { title: payload.title },
            data: {
              notification_id: payload.notification_id,
              type: payload.type,
              material_id: payload.material_id ?? '',
              priority: payload.priority,
            },
            android: { priority: payload.priority === 'normal' ? 'NORMAL' : 'HIGH' },
          },
        }),
      });
      if (res.ok) return 'ok';
      if (res.status === 404) return 'invalid_token';
      if (res.status === 400) {
        const body = (await res.json().catch(() => ({}))) as { error?: { status?: string } };
        return body.error?.status === 'INVALID_ARGUMENT' ? 'invalid_token' : 'retry';
      }
      return 'retry';
    } catch (err) {
      if (err instanceof GoogleUnavailable) return 'retry';
      throw err;
    }
  }
}
