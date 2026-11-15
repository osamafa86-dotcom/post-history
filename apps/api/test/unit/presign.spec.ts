import { attachment, downloadName, presignS3Get } from '../../src/verification/object-storage';

describe('S3 presigned GET (SigV4 query)', () => {
  it('matches the AWS documented example', () => {
    // https://docs.aws.amazon.com/AmazonS3/latest/API/sigv4-query-string-auth.html (مفاتيح المثال العامة في الوثيقة)
    const url = presignS3Get({
      origin: 'https://examplebucket.s3.amazonaws.com',
      host: 'examplebucket.s3.amazonaws.com',
      path: '/test.txt',
      region: 'us-east-1',
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      expiresSeconds: 86400,
      now: new Date('2013-05-24T00:00:00Z'),
    });
    expect(url).toBe(
      'https://examplebucket.s3.amazonaws.com/test.txt?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404',
    );
  });

  it('signs response-content-disposition with the link, as the SDK presigner does for the same request', () => {
    // القيمة المرجعية من موقّع SigV4 في حزمة AWS (smithy) للطلب نفسه بمفاتيح المثال العامة
    const url = new URL(
      presignS3Get({
        origin: 'https://examplebucket.s3.amazonaws.com',
        host: 'examplebucket.s3.amazonaws.com',
        path: '/test.txt',
        region: 'us-east-1',
        accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
        secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
        expiresSeconds: 86400,
        now: new Date('2013-05-24T00:00:00Z'),
        query: { 'response-content-disposition': attachment('circulated-vertical-1a2b3c4d.mp4') },
      }),
    );
    expect(url.searchParams.get('response-content-disposition')).toBe('attachment; filename="circulated-vertical-1a2b3c4d.mp4"');
    expect(url.searchParams.get('X-Amz-Signature')).toBe('9c9474f8b9656f2f421b6ef4cccad76e5183a55da0c19fb7fcb7df757e1c3b45');
  });
});

describe('download names', () => {
  const material = '1a2b3c4d-0000-4000-8000-000000000001';
  it('keep the stored leaf name and add the material, or use the kind and the content type for an upload key', () => {
    expect(downloadName(`derived/${material}/f/renders/r/circulated-vertical.mp4`, 'circulated_render', material, 'video/mp4')).toBe('circulated-vertical-1a2b3c4d.mp4');
    expect(downloadName(`derived/${material}/f/poster.jpg`, 'thumbnail', material, 'image/jpeg')).toBe('poster-1a2b3c4d.jpg');
    expect(downloadName('tus/0f0e0d0c-0000-4000-8000-000000000009', 'proxy', material, 'video/mp4')).toBe('proxy-1a2b3c4d.mp4');
    expect(downloadName('tus/0f0e0d0c', 'circulated_render', material, 'application/x-unknown')).toBe('circulated-render-1a2b3c4d');
  });
  it('refuse a name that could break the header', () => {
    for (const name of ['a"b.mp4', 'a b.mp4', 'مادة.mp4', '../x.mp4', '']) expect(() => attachment(name)).toThrow('unsafe download name');
    expect(attachment('PH-2026-ABCDEFGHJK.zip')).toBe('attachment; filename="PH-2026-ABCDEFGHJK.zip"');
  });
});
