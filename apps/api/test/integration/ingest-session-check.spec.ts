import { generateKeyPairSync, randomUUID } from 'node:crypto';
import request from 'supertest';
import { AppAttestFixtures } from '../support/app-attest-fixtures';
import { createHarness, type Harness, loginAs, seedUploadSession } from './harness';

type Actor = Awaited<ReturnType<typeof loginAs>>;
const claims = (jwt: string) => JSON.parse(Buffer.from(jwt.split('.')[1]!, 'base64url').toString('utf8')) as Record<string, unknown>;

describe('ingest gateway: web ingest tokens and the session check', () => {
  const signing = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const fx = new AppAttestFixtures();
  const env = {
    ATTESTATION_MODE: 'test',
    APP_ATTEST_APP_ID: 'ABCDE12345.org.posthistory.reporter',
    APP_ATTEST_TEST_ROOT_PEM: Buffer.from(fx.rootPem).toString('base64'),
    INGEST_TOKEN_SIGNING_KEY: (signing.privateKey.export({ format: 'der', type: 'pkcs8' }) as Buffer).toString('base64'),
    INGEST_TOKEN_KEY_ID: 'ingest-2026-10',
    INGEST_TOKEN_TTL_SECONDS: '900',
  };
  let h: Harness;
  let reporter: Actor;
  beforeAll(async () => {
    // في الاختبار يأتي الاتصال من الحلقة المحلية: هي عنوان الـBFF وعنوان البوابة الداخلي معًا
    h = await createHarness({ env: { ...env, BFF_SOURCE_ADDRESSES: '127.0.0.1/32,::1/128' } });
    reporter = await loginAs(h, [{ role: 'reporter' }]);
  });
  afterAll(async () => {
    fx.close();
    await h.close();
  });

  const http = (x: Harness = h) => request(x.app.getHttpServer());
  const webToken = (a: Actor, sessionId: string, x: Harness = h, key = randomUUID()) =>
    http(x).post(`/v1/uploads/${sessionId}/web-ingest-token`).set('Authorization', `Bearer ${a.token}`).set('Idempotency-Key', key).send();
  const status = (sid: string, ses?: string, x: Harness = h) =>
    http(x).get(`/internal/ingest/session-status?sid=${sid}${ses ? `&ses=${ses}` : ''}`);
  const authSession = (a: Actor) => claims(a.token).sid as string;

  it('issues a short web token bound to the upload session and the login session, audited', async () => {
    const s = await seedUploadSession(h, reporter.id);
    const key = randomUUID();
    const res = await webToken(reporter, s.id, h, key).expect(200);
    const c = claims(res.body.token);
    expect(c).toMatchObject({ aud: 'ingest', sid: s.id, plat: 'web', ses: authSession(reporter) });
    expect((c.exp as number) - (c.iat as number)).toBeLessThanOrEqual(600);
    // إعادة الطلب بالمفتاح نفسه تعيد رمز ويب للجلسة نفسها بلا تجاوز انتهاء الأول
    const again = await webToken(reporter, s.id, h, key).expect(200);
    expect(claims(again.body.token)).toMatchObject({ plat: 'web', sid: s.id, ses: authSession(reporter) });
    expect(Date.parse(again.body.expires_at)).toBeLessThanOrEqual(Date.parse(res.body.expires_at));
    const { rows } = await h.pool.query(`SELECT details FROM audit_log WHERE action = 'ingest_token.issued' AND target_id = $1`, [s.id]);
    expect(rows).toEqual([{ details: { upload_session_id: s.id, target_user_id: reporter.id, reason_code: 'web' } }]);
  });

  it('is refused for a session of someone else, and from anywhere but the BFF', async () => {
    const other = await loginAs(h, [{ role: 'reporter' }]);
    const s = await seedUploadSession(h, reporter.id);
    await webToken(other, s.id).expect(404);
    const direct = await createHarness({ env: { ...env, BFF_SOURCE_ADDRESSES: '192.0.2.10/32' } });
    try {
      await webToken(reporter, s.id, direct).expect(404);
    } finally {
      await direct.close();
    }
  });

  it('the session check accepts a live session and refuses within one call of any revocation', async () => {
    const s = await seedUploadSession(h, reporter.id);
    await status(s.id).expect(204);
    await status(s.id, authSession(reporter)).expect(204);
    // صفر جسم في الحالتين
    expect((await status(randomUUID())).text).toBe('');
    await status(randomUUID()).expect(403);
    await status('not-a-uuid').expect(403);
    await status(s.id, 'not-a-uuid').expect(403);

    // تسجيل الخروج يبطل جلسة الدخول: رمز الويب يسقط، ورمز الجهاز (بلا ses) يبقى ما دامت جلسة الرفع حية
    const leaving = await loginAs(h, [{ role: 'reporter' }]);
    const mine = await seedUploadSession(h, leaving.id);
    await status(mine.id, authSession(leaving)).expect(204);
    await http().post('/v1/auth/logout').set('Authorization', `Bearer ${leaving.token}`).send({}).expect(204);
    await status(mine.id, authSession(leaving)).expect(403);
    await status(mine.id).expect(204);
    // جلسة دخول لمستخدم آخر لا تصلح لجلسة الرفع هذه
    await status(s.id, authSession(leaving)).expect(403);

    // تعليق الصاحب، وانتهاء الجلسة، وإبطال رمز الرفع: كلها رفض
    await h.pool.query(`UPDATE users SET status = 'suspended' WHERE id = $1`, [leaving.id]);
    await status(mine.id).expect(403);
    const expired = await seedUploadSession(h, reporter.id, { expiresInSeconds: -60 });
    await status(expired.id).expect(403);
    const revoked = await seedUploadSession(h, reporter.id);
    await h.pool.query(`UPDATE upload_sessions SET upload_token_hash = NULL WHERE id = $1`, [revoked.id]);
    await status(revoked.id).expect(403);
  });

  it('logging out of all sessions refuses device tokens too (no ses)', async () => {
    const leaving = await loginAs(h, [{ role: 'reporter' }]);
    const mine = await seedUploadSession(h, leaving.id);
    await status(mine.id).expect(204);
    await http().post('/v1/auth/logout').set('Authorization', `Bearer ${leaving.token}`).send({ all_sessions: true }).expect(204);
    await status(mine.id).expect(403);
  });

  it('with INGEST_GATE_TOKEN set, the check requires the matching bearer', async () => {
    const gate = 'g'.repeat(40);
    const gated = await createHarness({ env: { ...env, INGEST_GATE_TOKEN: gate } });
    try {
      const s = await seedUploadSession(gated, reporter.id);
      await status(s.id, undefined, gated).expect(403);
      await status(s.id, undefined, gated).set('Authorization', `Bearer ${'h'.repeat(40)}`).expect(403);
      await status(s.id, undefined, gated).set('Authorization', gate).expect(403);
      const ok = await status(s.id, undefined, gated).set('Authorization', `Bearer ${gate}`).expect(204);
      expect(ok.text).toBe('');
    } finally {
      await gated.close();
    }
  });

  it('the session check is internal only', async () => {
    const outside = await createHarness({ env: { ...env, INTERNAL_ALLOWED_CIDRS: '192.0.2.1/32' } });
    try {
      const s = await seedUploadSession(outside, reporter.id);
      await status(s.id, undefined, outside).expect(404);
      await http(outside).get(`/v1/internal/ingest/session-status?sid=${s.id}`).expect(404);
    } finally {
      await outside.close();
    }
  });
});
