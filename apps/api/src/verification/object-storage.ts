import { GetObjectCommand, HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { Readable } from 'node:stream';

/** ما يحتاجه التحقق من التخزين: الحجم الفعلي وقراءة تدفقية. null = الكائن غير موجود. */
export interface ObjectStorage {
  head(bucket: string, key: string): Promise<{ size: number } | null>;
  read(bucket: string, key: string): Promise<Readable>;
}
export const OBJECT_STORAGE = Symbol('OBJECT_STORAGE');

/** R2 في الإنتاج وMinIO محليًا (عنوان المسار لا النطاق الفرعي). */
export class S3ObjectStorage implements ObjectStorage {
  private readonly client: S3Client;

  constructor(opts: { endpoint: string; region: string; accessKeyId: string; secretAccessKey: string }) {
    this.client = new S3Client({
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
      const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      if (status === 404) return null;
      throw err;
    }
  }

  async read(bucket: string, key: string): Promise<Readable> {
    const res = await this.client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    return res.Body as Readable;
  }
}
