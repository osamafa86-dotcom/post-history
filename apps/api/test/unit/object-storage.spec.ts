import { HeadBucketCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { S3ObjectStorage, StorageConfigError } from '../../src/verification/object-storage';

const httpError = (status: number) => Object.assign(new Error(`http ${status}`), { $metadata: { httpStatusCode: status } });
const opts = { endpoint: 'http://s3.invalid', region: 'auto', accessKeyId: 'k', secretAccessKey: 's' };

/** عميل S3 بديل: يجيب HeadObject وHeadBucket بما يُعطى. */
function storage(object: number | { size: number }, bucket: number | 'ok') {
  const send = jest.fn(async (cmd: unknown) => {
    if (cmd instanceof HeadObjectCommand) {
      if (typeof object === 'number') throw httpError(object);
      return { ContentLength: object.size };
    }
    if (cmd instanceof HeadBucketCommand) {
      if (bucket !== 'ok') throw httpError(bucket);
      return {};
    }
    throw new Error('unexpected command');
  });
  return new S3ObjectStorage(opts, { send } as never);
}

describe('S3ObjectStorage.head', () => {
  it('returns the size of an existing object', async () => {
    expect(await storage({ size: 42 }, 'ok').head('uploads', 'k')).toEqual({ size: 42 });
  });
  it('a missing object in an existing bucket is null (the upload fails as storage_error)', async () => {
    expect(await storage(404, 'ok').head('uploads', 'k')).toBeNull();
  });
  it('a missing or forbidden bucket is a configuration error (verification is deferred, not failed)', async () => {
    await expect(storage(404, 404).head('wrong-bucket', 'k')).rejects.toBeInstanceOf(StorageConfigError);
    await expect(storage(404, 403).head('uploads', 'k')).rejects.toBeInstanceOf(StorageConfigError);
    await expect(storage(403, 'ok').head('uploads', 'k')).rejects.toBeInstanceOf(StorageConfigError);
  });
  it('other errors propagate unchanged (deferred as transient)', async () => {
    await expect(storage(500, 'ok').head('uploads', 'k')).rejects.not.toBeInstanceOf(StorageConfigError);
  });
});
