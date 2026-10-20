import request from 'supertest';
import { schemaValidator } from '../../src/common/contract';
import { createHarness, type Harness } from './harness';

describe('GET /health', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(() => h.close());

  it('reports ok with a request id and without leaking versions', async () => {
    const res = await request(h.app.getHttpServer()).get('/health').expect(200);
    expect(res.body).toEqual({ status: 'ok', rate_limiter: 'redis' });
    const valid = schemaValidator('Health');
    expect(valid(res.body) ? [] : valid.errors).toEqual([]);
    expect(res.headers['x-request-id']).toEqual(expect.any(String));
    expect(res.headers['x-rate-limiter']).toBeUndefined();
  });

  it('reports a degraded rate limiter (in-memory) on /health only: without Redis, and after Redis fails', async () => {
    for (const REDIS_URL of ['', 'redis://127.0.0.1:1']) {
      const d = await createHarness({ env: { REDIS_URL } });
      try {
        const http = () => request(d.app.getHttpServer());
        // Redis المعطل يُكتشف عند أول استعمال لحد المعدل
        const login = await http().post('/v1/auth/login').send({ email: 'nobody@example.test', password: 'wrong-password' });
        expect(login.headers['x-rate-limiter']).toBeUndefined();
        const res = await http().get('/health').expect(200);
        expect(res.body).toEqual({ status: 'ok', rate_limiter: 'degraded' });
        expect(res.headers['x-rate-limiter']).toBe('degraded');
      } finally {
        await d.close();
      }
    }
  });

  it('outside INTERNAL_ALLOWED_CIDRS: status only, never the rate limiter state, even when degraded', async () => {
    const outside = await createHarness({ env: { REDIS_URL: '', INTERNAL_ALLOWED_CIDRS: '10.255.255.0/24' } });
    try {
      const res = await request(outside.app.getHttpServer()).get('/health').expect(200);
      expect(res.body).toEqual({ status: 'ok' });
      expect(res.headers['x-rate-limiter']).toBeUndefined();
    } finally {
      await outside.close();
    }
  });

  it('unknown routes return the contract error shape', async () => {
    const res = await request(h.app.getHttpServer()).get('/v1/nope').expect(404);
    expect(res.body).toEqual({ code: 'not_found', message: 'Not found.', request_id: res.headers['x-request-id'] });
  });
});
