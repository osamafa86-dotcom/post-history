import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createHarness, type Harness, loginAs, seedUploadSession } from './harness';

describe('internal paths restricted by source address', () => {
  const workerToken = 'w'.repeat(40);
  let gate: Harness;
  beforeAll(async () => {
    // الحلقة المحلية هنا عنوان البوابة: في INTERNAL_ALLOWED_CIDRS (الافتراضي) وفي مصدر مقيّد بـ /internal/ingest/ معًا
    gate = await createHarness({
      env: {
        MEDIA_WORKER_TOKEN: workerToken,
        INTERNAL_SOURCE_PATHS: '127.0.0.1/32=/internal/ingest/; ::1/128=/internal/ingest/',
      },
    });
  });
  afterAll(() => gate.close());
  const http = (x: Harness) => request(x.app.getHttpServer());

  it('the restricted source reaches its own prefix', async () => {
    const reporter = await loginAs(gate, [{ role: 'reporter' }]);
    const s = await seedUploadSession(gate, reporter.id);
    await http(gate).get(`/internal/ingest/session-status?sid=${s.id}`).expect(204);
  });

  it('is refused 403 elsewhere under /internal even with valid secrets', async () => {
    const tusd = await http(gate).post(`/internal/tusd-hooks/${gate.config.TUSD_HOOK_SECRET}`).send({}).expect(403);
    expect(tusd.text).toBe('');
    await http(gate).get(`/internal/media/sessions/${randomUUID()}`).set('Authorization', `Bearer ${workerToken}`).expect(403);
    await http(gate).post(`/internal/media/files/${randomUUID()}/derivatives`).set('Authorization', `Bearer ${workerToken}`).send({}).expect(403);
    // لا مقاطع نقطية ولا ترميز في المسار
    await http(gate).get(`/internal/ingest/%2e%2e/media/sessions/${randomUUID()}`).set('Authorization', `Bearer ${workerToken}`).expect(403);
    await http(gate).get(`/internal/ingest//session-status?sid=${randomUUID()}`).expect(403);
  });

  it('without the explicit entry the same address keeps INTERNAL_ALLOWED_CIDRS access', async () => {
    const open = await createHarness({ env: { MEDIA_WORKER_TOKEN: workerToken } });
    try {
      // مسار العامل يُخدم (404 الخدمة لجلسة غير موجودة لا 403 المصدر)
      const res = await http(open).get(`/internal/media/sessions/${randomUUID()}`).set('Authorization', `Bearer ${workerToken}`);
      expect(res.status).not.toBe(403);
    } finally {
      await open.close();
    }
  });

  it('a source outside both lists still gets 404', async () => {
    const outside = await createHarness({ env: { INTERNAL_ALLOWED_CIDRS: '192.0.2.1/32', INTERNAL_SOURCE_PATHS: '192.0.2.2/32=/internal/ingest/' } });
    try {
      await http(outside).get(`/internal/ingest/session-status?sid=${randomUUID()}`).expect(404);
    } finally {
      await outside.close();
    }
  });
});
