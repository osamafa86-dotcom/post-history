import { GetObjectCommand, HeadBucketCommand, HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { Readable } from 'node:stream';

/** ما يحتاجه التحقق من التخزين: الحجم الفعلي وقراءة تدفقية. null = الكائن غير موجود. */
export interface ObjectStorage {
  head(bucket: string, key: string): Promise<{ size: number } | null>;
  read(bucket: string, key: string): Promise<Readable>;
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

  constructor(opts: { endpoint: string; region: string; accessKeyId: string; secretAccessKey: string }, client?: Pick<S3Client, 'send'>) {
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
}
