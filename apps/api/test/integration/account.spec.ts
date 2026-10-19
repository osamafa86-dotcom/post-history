import { createHash, randomUUID } from 'node:crypto';
import request from 'supertest';
import { schemaValidator } from '../../src/common/contract';
import { OutboxDispatcher } from '../../src/outbox/outbox.dispatcher';
import { createHarness, type Harness, loginAs, seedUser } from './harness';

type Actor = Awaited<ReturnType<typeof loginAs>>;

describe('account: sessions and recovery', () => {
  let h: Harness;
  let officeA: string;
  let officeB: string;
  beforeAll(async () => {
    h = await createHarness();
    const office = async () =>
      (await h.pool.query<{ id: string }>(`INSERT INTO offices (name_ar, name_en, governorate) VALUES ('م', 'o', 'gaza') RETURNING id`)).rows[0]!.id;
    officeA = await office();
    officeB = await office();
  });
  afterAll(() => h.close());

  const http = () => request(h.app.getHttpServer());
  const login = async (email: string, password: string) =>
    (await http().post('/v1/auth/login').send({ email, password }).expect(200)).body as { access_token: string; refresh_token: string };
  const sessions = (token: string) => http().get('/v1/auth/sessions').set('Authorization', `Bearer ${token}`);
  const revoke = (token: string, id: string) => http().delete(`/v1/auth/sessions/${id}`).set('Authorization', `Bearer ${token}`);

  describe('/auth/sessions', () => {
    it('lists active sessions with the current one marked, and revokes one of my own', async () => {
      const user = await seedUser(h);
      const a = await login(user.email, user.password);
      const b = await login(user.email, user.password);
      const list = await sessions(a.access_token).expect(200);
      expect(list.body.items).toHaveLength(2);
      const valid = schemaValidator('UserSession');
      for (const s of list.body.items) expect(valid(s) ? [] : valid.errors).toEqual([]);
      expect(list.body.items.filter((s: { current: boolean }) => s.current)).toHaveLength(1);
      const other = list.body.items.find((s: { current: boolean }) => !s.current);
      await revoke(a.access_token, other.id).expect(204);
      await http().get('/v1/auth/me').set('Authorization', `Bearer ${b.access_token}`).expect(401);
      expect((await sessions(a.access_token).expect(200)).body.items).toHaveLength(1);
    });

    it('the current flag follows refresh rotation', async () => {
      const user = await seedUser(h);
      const s1 = await login(user.email, user.password);
      const s2 = (await http().post('/v1/auth/refresh').send({ refresh_token: s1.refresh_token }).expect(200)).body;
      const list = await sessions(s1.access_token).expect(200);
      expect(list.body.items).toEqual([expect.objectContaining({ current: true })]);
      expect((await sessions(s2.access_token).expect(200)).body.items[0].current).toBe(true);
    });

    it("a supervisor in scope or a system admin revokes a reporter's session (audited); others get 404", async () => {
      const reporter = await loginAs(h, [{ role: 'reporter' }], { officeId: officeA });
      const sup = await loginAs(h, [{ role: 'supervisor', scopeKind: 'office', scopeId: officeA }]);
      const supGov = await loginAs(h, [{ role: 'supervisor', scopeKind: 'governorate', scopeId: 'gaza' }]);
      const outside = await loginAs(h, [{ role: 'supervisor', scopeKind: 'office', scopeId: officeB }]);
      const stranger = await loginAs(h, [{ role: 'reporter' }]);
      const admin = await loginAs(h, [{ role: 'system_admin' }]);
      const ids = async () => (await sessions(reporter.token).expect(200)).body.items.map((s: { id: string }) => s.id) as string[];
      const [first] = await ids();
      await revoke(outside.token, first!).expect(404);
      await revoke(stranger.token, first!).expect(404);
      await revoke(sup.token, first!).expect(204);
      await http().get('/v1/auth/me').set('Authorization', `Bearer ${reporter.token}`).expect(401);
      const { rows } = await h.pool.query(`SELECT actor_id, details FROM audit_log WHERE action = 'session.revoked' AND target_id = $1`, [reporter.id]);
      expect(rows).toEqual([{ actor_id: sup.id, details: { session_id: first, target_user_id: reporter.id } }]);

      const again = await login(reporter.email, reporter.password);
      const [second] = (await sessions(again.access_token).expect(200)).body.items.map((s: { id: string }) => s.id);
      await revoke(supGov.token, second).expect(204);
      const third = await login(reporter.email, reporter.password);
      const [thirdId] = (await sessions(third.access_token).expect(200)).body.items.map((s: { id: string }) => s.id);
      await revoke(admin.token, thirdId).expect(204);
      await revoke(admin.token, thirdId).expect(404);
    });
  });

  describe('/auth/recovery', () => {
    const code = 'ABCDEFGHIJ2345';
    const seedCode = (userId: string, c = code) =>
      h.pool.query(`INSERT INTO recovery_codes (user_id, code_hash) VALUES ($1, $2)`, [userId, createHash('sha256').update(c).digest()]);
    const start = (email: string, backup_code: string) => http().post('/v1/auth/recovery').send({ email, backup_code });
    const requests = async (userId: string) =>
      (await h.pool.query(`SELECT id, state FROM recovery_requests WHERE user_id = $1 ORDER BY created_at`, [userId])).rows;

    it('answers 202 identically for a wrong code, an unknown email and a right code; only the right code opens a request', async () => {
      const reporter = await loginAs(h, [{ role: 'reporter' }], { officeId: officeA });
      await seedCode(reporter.id);
      const replies = [
        await start(reporter.email, 'WRONGCODE234').expect(202),
        await start(`nobody-${randomUUID()}@example.test`, code).expect(202),
        await start(reporter.email, code).expect(202),
        await start(reporter.email, code).expect(202),
      ];
      for (const r of replies) expect(r.body).toEqual({ accepted: true });
      expect(await requests(reporter.id)).toEqual([{ id: expect.any(String), state: 'pending_approval' }]);
      // الرمز لا يُستعمل مرتين، والجلسات القائمة لا تُبطل قبل الاعتماد
      await http().get('/v1/auth/me').set('Authorization', `Bearer ${reporter.token}`).expect(200);
    });

    it('notifies supervisors in scope with the request id and alerts the account owner', async () => {
      const reporter = await loginAs(h, [{ role: 'reporter' }], { officeId: officeA });
      const sup = await loginAs(h, [{ role: 'supervisor', scopeKind: 'office', scopeId: officeA }]);
      const outside = await loginAs(h, [{ role: 'supervisor', scopeKind: 'office', scopeId: officeB }]);
      await seedCode(reporter.id, 'QRSTUVWXYZ2345');
      await start(reporter.email, 'QRSTUVWXYZ2345').expect(202);
      const [req] = await requests(reporter.id);
      const dispatcher = h.app.get(OutboxDispatcher);
      while ((await dispatcher.dispatchBatch(500)) > 0);
      const inbox = async (a: Actor) =>
        (await http().get('/v1/notifications?limit=100').set('Authorization', `Bearer ${a.token}`).expect(200)).body.items as Array<Record<string, string>>;
      expect((await inbox(sup)).some((n) => n.type === 'auth.recovery_requested' && n.title?.includes(req.id))).toBe(true);
      expect((await inbox(outside)).some((n) => n.title?.includes(req.id))).toBe(false);
      const own = (await inbox(reporter)).filter((n) => n.type === 'auth.recovery_requested');
      expect(own).toHaveLength(1);
      expect(own[0]!.title).not.toContain(req.id);
    });

    it('approval by a supervisor in scope revokes all sessions, is audited, and cannot happen twice', async () => {
      const reporter = await loginAs(h, [{ role: 'reporter' }], { officeId: officeA });
      const sup = await loginAs(h, [{ role: 'supervisor', scopeKind: 'office', scopeId: officeA }]);
      const outside = await loginAs(h, [{ role: 'supervisor', scopeKind: 'office', scopeId: officeB }]);
      await seedCode(reporter.id, 'MNOPQRSTUV2345');
      await start(reporter.email, 'MNOPQRSTUV2345').expect(202);
      const [req] = await requests(reporter.id);
      const approve = (a: Actor, body: object = { verification_note: 'called the reporter on the office line' }) =>
        http().post(`/v1/auth/recovery/${req.id}/approve`).set('Authorization', `Bearer ${a.token}`).send(body);

      await approve(reporter).expect(403);
      await approve(outside).expect(404);
      await approve(sup, {}).expect(422);
      const res = await approve(sup).expect(200);
      expect(res.body).toMatchObject({ id: req.id, state: 'approved', approved_by: sup.id });
      const valid = schemaValidator('RecoveryRequest');
      expect(valid(res.body) ? [] : valid.errors).toEqual([]);
      await http().get('/v1/auth/me').set('Authorization', `Bearer ${reporter.token}`).expect(401);
      expect((await approve(sup).expect(409)).body.code).toBe('recovery_state_conflict');
      const { rows } = await h.pool.query(`SELECT action FROM audit_log WHERE target_id = $1 AND action LIKE 'auth.recovery%' ORDER BY id`, [reporter.id]);
      expect(rows.map((r) => r.action)).toEqual(['auth.recovery_requested', 'auth.recovery_approved']);
      const { rows: notes } = await h.pool.query(`SELECT details FROM audit_log WHERE target_id = $1`, [reporter.id]);
      expect(JSON.stringify(notes)).not.toContain('office line');
    });

    it('an expired request is 409 and becomes expired', async () => {
      const reporter = await loginAs(h, [{ role: 'reporter' }], { officeId: officeA });
      const admin = await loginAs(h, [{ role: 'system_admin' }]);
      await seedCode(reporter.id, 'EXPIREDCODE234');
      await start(reporter.email, 'EXPIREDCODE234').expect(202);
      const [req] = await requests(reporter.id);
      await h.pool.query(`UPDATE recovery_requests SET expires_at = now() - interval '1 second' WHERE id = $1`, [req.id]);
      await http()
        .post(`/v1/auth/recovery/${req.id}/approve`)
        .set('Authorization', `Bearer ${admin.token}`)
        .send({ verification_note: 'x' })
        .expect(409);
      expect(await requests(reporter.id)).toEqual([{ id: req.id, state: 'expired' }]);
    });

    it('rate-limits recovery attempts per email and address', async () => {
      const user = await seedUser(h);
      for (let i = 0; i < 5; i++) await start(user.email, 'NOPENOPE2345').expect(202);
      const res = await start(user.email, 'NOPENOPE2345').expect(429);
      expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
    });
  });
});
