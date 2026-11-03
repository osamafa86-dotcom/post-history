import { randomBytes, randomUUID } from 'node:crypto';
import request from 'supertest';
import { fieldKeyring } from '../../src/config/config';
import { RetentionWorker } from '../../src/retention/retention.worker';
import { createHarness, ensureForm, type Harness, loginAs, seedUploadSession } from './harness';

/**
 * ADR 0116: ما انتهت حاجته التقنية لا يبقى بلا حد (رموز التحديث الميتة، واسم الملف على الجهاز، والإشعارات المقروءة، ومفاتيح منع
 * التكرار وردودها)، والرد المحفوظ لا يحمل الاسم الحقيقي ولا قيمة محمية ويُقرأ من جديد بصلاحيات المستدعي الحالية عند الإعادة.
 */
describe('retention sweep and stored idempotent responses (ADR 0116)', () => {
  let h: Harness;
  let worker: RetentionWorker;
  beforeAll(async () => {
    h = await createHarness();
    worker = h.app.get(RetentionWorker);
    await ensureForm(h);
  });
  afterAll(() => h.close());

  const http = () => request(h.app.getHttpServer());

  it('purges expired idempotency keys, long-dead refresh tokens (not those a live one points to), device filenames of finished uploads and old read notifications', async () => {
    const u = await loginAs(h, [{ role: 'reporter' }]);
    const q = (text: string, args: unknown[] = []) => h.pool.query(text, args);
    await q(`INSERT INTO idempotency_keys (user_id, key, request_fingerprint, state, response_status, response_body, expires_at) VALUES ($1, $2, $3, 'completed', 201, '{}', now() - interval '1 minute')`, [u.id, `old-${randomUUID()}`, randomBytes(32)]);
    await q(`INSERT INTO idempotency_keys (user_id, key, request_fingerprint, state, response_status, response_body) VALUES ($1, $2, $3, 'completed', 201, '{}')`, [u.id, `live-${randomUUID()}`, randomBytes(32)]);

    const token = async (expires: string, revoked: string | null, replacedBy: string | null = null) =>
      (
        await q(
          `INSERT INTO refresh_tokens (user_id, token_hash, expires_at, revoked_at, replaced_by) VALUES ($1, $2, now() + $3::interval, now() + $4::interval, $5) RETURNING id`,
          [u.id, randomBytes(32), expires, revoked, replacedBy],
        )
      ).rows[0]!.id as string;
    const deadNew = await token('-40 days', null);
    const deadOld = await token('-50 days', '-50 days', deadNew);
    const revokedRecently = await token('10 days', '-1 day');
    // رمز ميت قديم يشير إليه رمز حي (سلسلة التدوير): يبقى حتى يموت الحي ويحين حذفه
    const pointedTo = await token('-60 days', '-60 days');
    const live = await token('10 days', null);
    await q(`UPDATE refresh_tokens SET replaced_by = $2 WHERE id = $1`, [live, pointedTo]);

    const old = await seedUploadSession(h, u.id);
    const fresh = await seedUploadSession(h, u.id);
    const open = await seedUploadSession(h, u.id);
    await q(`UPDATE upload_sessions SET state = 'failed', failure_reason = 'expired', client_fingerprint = '{"name": "IMG_0001.MOV"}' WHERE id = ANY($1)`, [[old.id, fresh.id]]);
    await q(`ALTER TABLE upload_sessions DISABLE TRIGGER upload_sessions_set_updated_at`);
    try {
      await q(`UPDATE upload_sessions SET updated_at = now() - interval '31 days' WHERE id = ANY($1)`, [[old.id, open.id]]);
    } finally {
      await q(`ALTER TABLE upload_sessions ENABLE TRIGGER upload_sessions_set_updated_at`);
    }

    const note = async (readDaysAgo: number | null, assignment: string | null = null) => {
      const event = (
        await q(
          `INSERT INTO outbox_events (type, aggregate_type, aggregate_id, idempotency_key, payload)
           VALUES ('auth.recovery_codes_generated', 'user', $1, $2, '{"codes_count": 10}') RETURNING id`,
          [u.id, `retention-test:${randomUUID()}`],
        )
      ).rows[0]!.id;
      return (
        await q(
          `INSERT INTO notifications (user_id, event_id, type, title, state, read_at, assignment_state)
           VALUES ($1, $2, 'auth.recovery_codes_generated', 't', CASE WHEN $3::int IS NULL THEN 'sent' ELSE 'read' END,
                   CASE WHEN $3::int IS NULL THEN NULL ELSE now() - make_interval(days => $3::int) END, $4) RETURNING id`,
          [u.id, event, readDaysAgo, assignment],
        )
      ).rows[0]!.id as string;
    };
    const readOld = await note(200);
    const readRecent = await note(10);
    const unread = await note(null);
    const openTask = await note(200, 'assigned');

    const first = await worker.sweep();
    expect(first.idempotency_keys).toBeGreaterThanOrEqual(1);
    const exists = async (table: string, id: string) => (await q(`SELECT 1 FROM ${table} WHERE id = $1`, [id])).rowCount === 1;
    expect((await q(`SELECT count(*)::int AS n FROM idempotency_keys WHERE user_id = $1`, [u.id])).rows[0].n).toBe(1);
    expect([await exists('refresh_tokens', deadOld), await exists('refresh_tokens', deadNew)]).toEqual([false, false]);
    expect([await exists('refresh_tokens', revokedRecently), await exists('refresh_tokens', pointedTo), await exists('refresh_tokens', live)]).toEqual([true, true, true]);
    const sessions = (await q(`SELECT id, filename, client_fingerprint FROM upload_sessions WHERE id = ANY($1)`, [[old.id, fresh.id, open.id]])).rows;
    const by = (id: string) => sessions.find((s) => s.id === id);
    expect(by(old.id)).toMatchObject({ filename: '-', client_fingerprint: null });
    expect(by(fresh.id)!.filename).not.toBe('-');
    expect(by(open.id)!.filename).not.toBe('-');
    expect([await exists('notifications', readOld), await exists('notifications', readRecent), await exists('notifications', unread), await exists('notifications', openTask)]).toEqual([
      false,
      true,
      true,
      true,
    ]);
    // ذاتي التكرار
    const again = await worker.sweep();
    expect(again.upload_filenames).toBe(0);
  });

  it('stores a Material response as a reference only, and a replay re-reads it with the caller current permissions and audits the sensitive read', async () => {
    const reporter = await loginAs(h, [{ role: 'reporter' }]);
    const legal = `Legal Name ${randomUUID().slice(0, 8)}`;
    await h.pool.query(`UPDATE users SET legal_name_enc = $2 WHERE id = $1`, [reporter.id, fieldKeyring(h.config).encrypt(Buffer.from(legal))]);
    const viewer = await loginAs(h, [{ role: 'editor_in_chief' }]);
    const admin = await loginAs(h, [{ role: 'system_admin' }]);
    await h.pool.query(`INSERT INTO user_permissions (user_id, permission, granted_by, reason) VALUES ($1, 'reporter_identity:read', $2, 'test')`, [viewer.id, admin.id]);

    const { materialId } = await seedUploadSession(h, reporter.id);
    const key = randomUUID();
    const patch = () =>
      http().patch(`/v1/materials/${materialId}`).set('Authorization', `Bearer ${viewer.token}`).set('Idempotency-Key', key).send({ priority: 'important' });
    const res = await patch().expect(200);
    expect(res.body.reporter_legal_name).toBe(legal);
    const { rows } = await h.pool.query(`SELECT response_body FROM idempotency_keys WHERE user_id = $1 AND key = $2`, [viewer.id, key]);
    expect(rows[0].response_body).toEqual({ material_replay: { id: materialId, row_version: res.body.row_version } });
    expect(JSON.stringify(rows)).not.toContain(legal);

    const audits = async () =>
      (await h.pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM audit_log WHERE actor_id = $1 AND action = 'material.sensitive_read' AND target_id = $2`, [viewer.id, materialId])).rows[0]!.n;
    const before = await audits();
    const replay = await patch().expect(200);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.body).toMatchObject({ id: materialId, priority: 'important', reporter_legal_name: legal });
    expect(await audits()).toBe(before + 1);

    // بعد سحب الصلاحية لا يعيد التكرار ما كان يُرى بها
    await http()
      .delete(`/v1/users/${viewer.id}/permissions/reporter_identity:read`)
      .set('Authorization', `Bearer ${admin.token}`)
      .set('Idempotency-Key', randomUUID())
      .expect(204);
    const after = await patch().expect(200);
    expect(after.body).not.toHaveProperty('reporter_legal_name');
  });
});
