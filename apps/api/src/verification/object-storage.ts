import { GetObjectCommand, HeadBucketCommand, HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { createHash, createHmac } from 'node:crypto';
import type { Readable } from 'node:stream';

/** ما يحتاجه التحقق من التخزين: الحجم الفعلي وقراءة تدفقية. null = الكائن غير موجود. */
export interface ObjectStorage {
  head(bucket: string, key: string): Promise<{ size: number } | null>;
  read(bucket: string, key: string): Promise<Readable>;
  /** رابط قراءة موقّع (SigV4 في الاستعلام) لكائن واحد؛ غير متاح = لا روابط تنزيل. */
  presignGet?(bucket: string, key: string, expiresSeconds: number, now?: Date): string;
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

  /** عنوان المسار على النقطة العامة (S3_PUBLIC_ENDPOINT، وإلا S3_ENDPOINT): التوقيع يشمل المضيف فيُوقَّع بما يطلبه العميل. */
  presignGet(bucket: string, key: string, expiresSeconds: number, now = new Date()): string {
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
    });
  }
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
