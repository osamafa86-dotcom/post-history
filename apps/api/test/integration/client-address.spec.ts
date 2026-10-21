import { randomInt, randomUUID } from 'node:crypto';
import request from 'supertest';
import { CLIENT_ADDRESS_HEADER } from '../../src/common/client-address';
import { createHarness, type Harness } from './harness';

// عنوان عشوائي لكل تشغيل: سلال حد المعدل في Redis تبقى بين التشغيلات
const address = () => `10.${randomInt(256)}.${randomInt(256)}.${randomInt(1, 255)}`;
const fail = (h: Harness, from?: string) => {
  const r = request(h.app.getHttpServer()).post('/v1/auth/login');
  return (from ? r.set(CLIENT_ADDRESS_HEADER, from) : r).send({ email: `nobody-${randomUUID()}@example.test`, password: 'wrong-password' });
};

describe('client address forwarded by the BFF for login rate limits', () => {
  const env = { LOGIN_RATE_LIMIT_IP_MAX: '3' };

  it('from the configured BFF address, each forwarded client address has its own budget', async () => {
    // الاتصال في الاختبار من الحلقة المحلية: هي «عنوان الـBFF» المضبوط هنا
    const h = await createHarness({ env: { ...env, BFF_SOURCE_ADDRESSES: '127.0.0.1/32,::1/128' } });
    try {
      const [a, b] = [address(), address()];
      for (let i = 0; i < 3; i++) await fail(h, a).expect(401);
      expect((await fail(h, a).expect(429)).body.code).toBe('rate_limited');
      await fail(h, b).expect(401);
      // قيمة ليست عنوانًا تُهمل ويُعدّ الطلب على عنوان الـBFF نفسه
      await fail(h, 'not-an-address').expect((res) => expect([401, 429]).toContain(res.status));
    } finally {
      await h.close();
    }
  });

  it('from any other source the header is ignored, so changing it does not escape the budget', async () => {
    const h = await createHarness({ env: { ...env, BFF_SOURCE_ADDRESSES: '192.0.2.10/32' } });
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 6; i++) statuses.push((await fail(h, address())).status);
      expect(statuses.slice(-3)).toEqual([429, 429, 429]);
    } finally {
      await h.close();
    }
  });

  it('refuses a configured range wider than one address', async () => {
    await expect(createHarness({ env: { BFF_SOURCE_ADDRESSES: '10.0.0.0/24' } })).rejects.toThrow();
  });
});
