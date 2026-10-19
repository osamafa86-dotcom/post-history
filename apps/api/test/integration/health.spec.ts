import request from 'supertest';
import { createHarness, type Harness } from './harness';

describe('GET /health', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(() => h.close());

  it('reports ok with a request id and without leaking versions', async () => {
    const res = await request(h.app.getHttpServer()).get('/health').expect(200);
    expect(res.body).toEqual({ status: 'ok' });
    expect(res.headers['x-request-id']).toEqual(expect.any(String));
  });

  it('unknown routes return the contract error shape', async () => {
    const res = await request(h.app.getHttpServer()).get('/v1/nope').expect(404);
    expect(res.body).toEqual({ code: 'not_found', message: 'Not found.', request_id: res.headers['x-request-id'] });
  });
});
