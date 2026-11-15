import {
  AbortMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListMultipartUploadsCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { createHash, createHmac } from 'node:crypto';
import type { Readable } from 'node:stream';

/** ما يحتاجه التحقق من التخزين: الحجم الفعلي وقراءة تدفقية. null = الكائن غير موجود. */
export interface ObjectStorage {
  head(bucket: string, key: string): Promise<{ size: number } | null>;
  read(bucket: string, key: string): Promise<Readable>;
  /**
   * رابط قراءة موقّع (SigV4 في الاستعلام) لكائن واحد؛ غير متاح = لا روابط تنزيل. `download`: اسم ملف يُحفظ به، فيحمل الرابط
   * `response-content-disposition=attachment` موقّعًا معه (`downloadName`)، والمتصفح ينزّله ولا يفتحه مكان الصفحة.
   */
  presignGet?(bucket: string, key: string, expiresSeconds: number, now?: Date, download?: string): string;
  /** يحذف رفعًا ملغى من التخزين المؤقت: أجزاء tusd غير المجمّعة وكائنه وملفاته الجانبية (`.info` و`.part`). */
  removeUpload?(bucket: string, key: string): Promise<void>;
}
export const OBJECT_STORAGE = Symbol('OBJECT_STORAGE');

/**
 * خطأ تهيئة لا خطأ ملف: الحاوية غير موجودة أو غير مصرّح بها. يؤجل التحقق (تبقى الجلسة completed) وينبّه،
 * ولا يُفشل الرفعات، لأن تصحيح S3_BUCKET_UPLOADS أو الصلاحيات يكفي لإكمالها.
 */
export class StorageConfigError extends Error {
  override readonly name = 'StorageConfigError';
}

const statusOf = (err: unknown) => (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;

/** R2 في الإنتاج وMinIO محليًا (عنوان المسار لا النطاق الفرعي). */
export class S3ObjectStorage implements ObjectStorage {
  private readonly client: Pick<S3Client, 'send'>;

  constructor(
    private readonly opts: { endpoint: string; region: string; accessKeyId: string; secretAccessKey: string; publicEndpoint?: string },
    client?: Pick<S3Client, 'send'>,
  ) {
    this.client =
      client ??
      new S3Client({
        endpoint: opts.endpoint,
        region: opts.region,
        forcePathStyle: true,
        credentials: { accessKeyId: opts.accessKeyId, secretAccessKey: opts.secretAccessKey },
      });
  }

  async head(bucket: string, key: string): Promise<{ size: number } | null> {
    try {
      const res = await this.client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      return { size: Number(res.ContentLength ?? 0) };
    } catch (err) {
      const status = statusOf(err);
      if (status === 403) throw new StorageConfigError(`access denied to bucket ${bucket}`);
      if (status !== 404) throw err;
      // HEAD بلا جسم: 404 قد يعني كائنًا مفقودًا أو حاوية مفقودة؛ فحص الحاوية يفرّق بينهما
      try {
        await this.client.send(new HeadBucketCommand({ Bucket: bucket }));
      } catch (bucketErr) {
        const s = statusOf(bucketErr);
        if (s === 404 || s === 403) throw new StorageConfigError(`bucket ${bucket} is missing or not accessible`);
        throw bucketErr;
      }
      return null;
    }
  }

  async read(bucket: string, key: string): Promise<Readable> {
    const res = await this.client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    return res.Body as Readable;
  }

  async removeUpload(bucket: string, key: string): Promise<void> {
    // tusd (s3store) يرفع الجزء متعدد الأجزاء بمفتاح الكائن نفسه؛ معرّف الجزء لا يُحفظ قبل الاكتمال فيُبحث عنه بالبادئة
    const pending = await this.client.send(new ListMultipartUploadsCommand({ Bucket: bucket, Prefix: key }));
    for (const u of pending.Uploads ?? []) {
      if (u.Key === key && u.UploadId) await this.client.send(new AbortMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId: u.UploadId }));
    }
    for (const k of [key, `${key}.info`, `${key}.part`]) await this.client.send(new DeleteObjectCommand({ Bucket: bucket, Key: k }));
  }

  /** عنوان المسار على النقطة العامة (S3_PUBLIC_ENDPOINT، وإلا S3_ENDPOINT): التوقيع يشمل المضيف فيُوقَّع بما يطلبه العميل. */
  presignGet(bucket: string, key: string, expiresSeconds: number, now = new Date(), download?: string): string {
    const base = new URL(this.opts.publicEndpoint ?? this.opts.endpoint);
    return presignS3Get({
      origin: base.origin,
      host: base.host,
      path: `${base.pathname.replace(/\/$/, '')}/${bucket}/${key}`,
      region: this.opts.region,
      accessKeyId: this.opts.accessKeyId,
      secretAccessKey: this.opts.secretAccessKey,
      expiresSeconds,
      now,
      ...(download ? { query: { 'response-content-disposition': attachment(download) } } : {}),
    });
  }
}

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
/** `Content-Disposition` للتنزيل باسم ملف آمن (حروف لاتينية وأرقام و`._-` وحدها): لا اقتباس يُكسر ولا ترميز يُساء فهمه. */
export function attachment(name: string): string {
  if (!SAFE_NAME.test(name)) throw new Error('unsafe download name');
  return `attachment; filename="${name}"`;
}

const EXTENSIONS: Record<string, string> = {
  'video/mp4': 'mp4', 'video/quicktime': 'mov', 'audio/mp4': 'm4a', 'image/jpeg': 'jpg', 'image/png': 'png',
  'application/zip': 'zip', 'text/vtt': 'vtt', 'application/json': 'json', 'text/plain': 'txt',
};
/**
 * اسم الملف المنزَّل: اسم الكائن في التخزين بلا امتداده (`circulated-vertical`، `proxy-480p`) أو نوع الملف حين لا اسم له (مفتاح رفع
 * بالمعرّف وحده)، ثم أول ثمانية من معرّف المادة، ثم الامتداد من الاسم وإلا من نوع المحتوى. بالمعرّفات والكلمات الثابتة وحدها كمفتاح التخزين:
 * لا عنوان مادة ولا اسم مراسل ولا مكان.
 */
export function downloadName(storageKey: string, fallback: string, materialId: string, mimeType?: string | null): string {
  const leaf = storageKey.split('/').pop() ?? '';
  const named = /^([a-z0-9]+(?:-[a-z0-9]+)*)\.([a-z0-9]{2,5})$/i.exec(leaf);
  const stem = named ? named[1]! : fallback.replace(/_/g, '-');
  const ext = named ? named[2]!.toLowerCase() : EXTENSIONS[(mimeType ?? '').split(';')[0]!.trim().toLowerCase()];
  return `${stem}-${materialId.replace(/-/g, '').slice(0, 8)}${ext ? `.${ext}` : ''}`;
}

const rfc3986 = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const hmac = (key: Buffer | string, data: string) => createHmac('sha256', key).update(data).digest();

/** AWS SigV4 بالاستعلام لطلب GET (رابط موقّع)، بالترويسة host وحدها والحمولة UNSIGNED-PAYLOAD. */
export function presignS3Get(a: {
  origin: string;
  host: string;
  path: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  expiresSeconds: number;
  now: Date;
  /** معاملات استعلام إضافية تدخل التوقيع (`response-content-disposition`). */
  query?: Record<string, string>;
}): string {
  const amzDate = a.now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const date = amzDate.slice(0, 8);
  const scope = `${date}/${a.region}/s3/aws4_request`;
  const canonicalUri = a.path.split('/').map(rfc3986).join('/');
  const query: Array<[string, string]> = [
    ['X-Amz-Algorithm', 'AWS4-HMAC-SHA256'],
    ['X-Amz-Credential', `${a.accessKeyId}/${scope}`],
    ['X-Amz-Date', amzDate],
    ['X-Amz-Expires', String(a.expiresSeconds)],
    ['X-Amz-SignedHeaders', 'host'],
    ...Object.entries(a.query ?? {}),
  ];
  const canonicalQuery = query
    .map(([k, v]) => [rfc3986(k), rfc3986(v)])
    .sort(([x], [y]) => (x! < y! ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const canonicalRequest = ['GET', canonicalUri, canonicalQuery, `host:${a.host}`, '', 'host', 'UNSIGNED-PAYLOAD'].join('\n');
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, createHash('sha256').update(canonicalRequest).digest('hex')].join('\n');
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${a.secretAccessKey}`, date), a.region), 's3'), 'aws4_request');
  const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex');
  return `${a.origin}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}
