import { createHash, randomBytes } from 'node:crypto';
import { CreateBucketCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { S3ObjectStorage } from '../../src/verification/object-storage';

/**
 * محوّل S3 الفعلي ضد MinIO المثبّت في compose (ADR 0004)، لا تخزين الذاكرة.
 * يعمل حين يُضبط S3_TEST_ENDPOINT (وظيفة api في CI تشغّل MinIO وتضبطه)؛ محليًا:
 *   S3_TEST_ENDPOINT=http://127.0.0.1:9000 S3_TEST_ACCESS_KEY=… S3_TEST_SECRET_KEY=… npm run test:integration
 */
const endpoint = process.env.S3_TEST_ENDPOINT;
const describeMinio = endpoint ? describe : describe.skip;

describeMinio('S3ObjectStorage against MinIO', () => {
  const opts = {
    endpoint: endpoint ?? '',
    region: 'auto',
    accessKeyId: process.env.S3_TEST_ACCESS_KEY ?? '',
    secretAccessKey: process.env.S3_TEST_SECRET_KEY ?? '',
  };
  const bucket = `adapter-test-${randomBytes(4).toString('hex')}`;
  const key = `tus/${randomBytes(8).toString('hex')}`;
  // أكبر من حجم القطعة الافتراضي في SDK، ليُختبر الحساب التدفقي على أكثر من قطعة
  const body = randomBytes(3 * 1024 * 1024 + 17);
  const storage = new S3ObjectStorage(opts);

  beforeAll(async () => {
    const raw = new S3Client({
      endpoint: opts.endpoint,
      region: opts.region,
      forcePathStyle: true,
      credentials: { accessKeyId: opts.accessKeyId, secretAccessKey: opts.secretAccessKey },
    });
    await raw.send(new CreateBucketCommand({ Bucket: bucket }));
    await raw.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body }));
    raw.destroy();
  });

  it('head returns the stored size', async () => {
    await expect(storage.head(bucket, key)).resolves.toEqual({ size: body.length });
  });

  it('head returns null for a missing object', async () => {
    await expect(storage.head(bucket, `${key}-missing`)).resolves.toBeNull();
  });

  it('read streams the exact bytes (SHA-256 matches)', async () => {
    const hash = createHash('sha256');
    for await (const chunk of await storage.read(bucket, key)) hash.update(chunk as Buffer);
    expect(hash.digest('hex')).toBe(createHash('sha256').update(body).digest('hex'));
  });
});
