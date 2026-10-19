import request from 'supertest';
import { createHarness, type Harness, seedUser } from './harness';

// حد الدخول في Redis مشترك بين النسخ: المحاولات الفاشلة على نسختين تُعدّ معًا.
describe('login rate limit across instances (Redis)', () => {
  let a: Harness;
  let b: Harness;
  beforeAll(async () => {
    a = await createHarness();
    b = await createHarness();
  });
  afterAll(async () => {
    await a.close();
    await b.close();
  });

  const login = (h: Harness, body: object) => request(h.app.getHttpServer()).post('/v1/auth/login').send(body);

  it('failures on two instances share one budget and both instances then refuse', async () => {
    const user = await seedUser(a);
    for (let i = 0; i < 5; i++) await login(i % 2 ? a : b, { email: user.email, password: 'wrong-password' }).expect(401);
    const fromA = await login(a, { email: user.email, password: user.password }).expect(429);
    expect(Number(fromA.headers['retry-after'])).toBeGreaterThan(0);
    await login(b, { email: user.email, password: user.password }).expect(429);
  });

  it('keeps no raw email or address in Redis keys', async () => {
    const user = await seedUser(a);
    await login(a, { email: user.email, password: 'wrong-password' }).expect(401);
    const Redis = (await import('ioredis')).default;
    const redis = new Redis(a.config.REDIS_URL);
    try {
      const keys = await redis.keys('rl:*');
      expect(keys.length).toBeGreaterThan(0);
      expect(keys.join(' ')).not.toContain(user.email);
      expect(keys.join(' ')).not.toContain('127.0.0.1');
    } finally {
      redis.disconnect();
    }
  });

  it('falls back to an in-memory limiter with the same limits when Redis is unreachable, and audits it once', async () => {
    const down = await createHarness({ env: { REDIS_URL: 'redis://127.0.0.1:1' } });
    try {
      const { rows: before } = await down.pool.query(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'rate_limiter.degraded'`);
      const user = await seedUser(down);
      for (let i = 0; i < 5; i++) await login(down, { email: user.email, password: 'wrong-password' }).expect(401);
      await login(down, { email: user.email, password: user.password }).expect(429);
      const other = await seedUser(down);
      await login(down, { email: other.email, password: other.password }).expect(200);
      const { rows: after } = await down.pool.query(
        `SELECT count(*)::int AS n FROM audit_log WHERE action = 'rate_limiter.degraded' AND details = '{"reason_code": "redis_unavailable"}'::jsonb`,
      );
      expect(after[0].n - before[0].n).toBe(1);
    } finally {
      await down.close();
    }
  });
});
