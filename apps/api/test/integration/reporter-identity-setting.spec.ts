import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { fieldKeyring } from '../../src/config/config';
import { createHarness, drainOutbox, ensureForm, type Harness, loginAs } from './harness';

const LEGAL = 'نور-الاختبار-٤٢';
type Actor = Awaited<ReturnType<typeof loginAs>>;

describe('reporter identity setting (ADR 0021)', () => {
  let h: Harness;
  let admin: Actor;
  let otherAdmin: Actor;
  let reporter: Actor;
  let identityHolder: Actor;
  let sourceHolder: Actor;
  let chief: Actor;
  let materialId: string;
  beforeAll(async () => {
    h = await createHarness();
    await ensureForm(h);
    // الإعداد عام على القاعدة المشتركة: يبدأ هذا الملف من الافتراضي
    await h.pool.query(`UPDATE system_settings SET value = 'separate', updated_by = NULL WHERE key = 'reporter_legal_name_access'`);
    admin = await loginAs(h, [{ role: 'system_admin' }]);
    otherAdmin = await loginAs(h, [{ role: 'system_admin' }]);
    reporter = await loginAs(h, [{ role: 'reporter' }]);
    chief = await loginAs(h, [{ role: 'editor_in_chief' }]);
    const grant = async (permission: string) => {
      const a = await loginAs(h, [{ role: 'editor_in_chief' }]);
      await http()
        .put(`/v1/users/${a.id}/permissions/${permission}`)
        .set('Authorization', `Bearer ${admin.token}`)
        .set('Idempotency-Key', randomUUID())
        .send({ reason: 'test' })
        .expect(204);
      return a;
    };
    identityHolder = await grant('reporter_identity:read');
    sourceHolder = await grant('protected_source:read');
    await h.pool.query(`UPDATE users SET legal_name_enc = $2 WHERE id = $1`, [reporter.id, fieldKeyring(h.config).encrypt(Buffer.from(LEGAL))]);
    const res = await http()
      .post('/v1/materials')
      .set('Authorization', `Bearer ${reporter.token}`)
      .set('Idempotency-Key', randomUUID())
      .send({
        title: 'عنوان',
        material_types: ['report'],
        governorate: 'gaza',
        city: 'gaza',
        priority: 'normal',
        sensitivity: { minors: false, injured: false, graphic: false },
        display_name: { mode: 'network' },
        form_version: 1,
        dynamic_fields: {},
      });
    if (res.status !== 201) throw new Error(`material: ${res.status} ${JSON.stringify(res.body)}`);
    materialId = res.body.id;
  });
  afterAll(async () => {
    await h.pool.query(`UPDATE system_settings SET value = 'separate', updated_by = NULL WHERE key = 'reporter_legal_name_access'`);
    await h.close();
  });

  const http = () => request(h.app.getHttpServer());
  const read = (a: Actor) => http().get(`/v1/materials/${materialId}`).set('Authorization', `Bearer ${a.token}`).expect(200);
  const sees = async (a: Actor) => {
    const body = (await read(a)).body as Record<string, unknown>;
    return 'reporter_legal_name' in body ? body.reporter_legal_name : undefined;
  };
  const put = (a: Actor, body: object) =>
    http().put('/v1/admin/settings/reporter-identity').set('Authorization', `Bearer ${a.token}`).set('Idempotency-Key', randomUUID()).send(body);
  const changes = async () =>
    (
      await h.pool.query<{ details: Record<string, string> }>(
        `SELECT details FROM audit_log WHERE action = 'setting.changed' AND target_type = 'setting' AND target_id = 'reporter_legal_name_access' AND actor_id = ANY($1) ORDER BY id`,
        [[admin.id, otherAdmin.id]],
      )
    ).rows.map((r) => r.details);
  const events = async () =>
    (await h.pool.query<{ payload: Record<string, string> }>(`SELECT payload FROM outbox_events WHERE type = 'setting.changed' AND aggregate_id = ANY($1) ORDER BY occurred_at`, [[admin.id, otherAdmin.id]])).rows.map(
      (r) => r.payload,
    );

  it('defaults to separate: only reporter_identity:read reveals the name, and protected_source:read alone does not', async () => {
    const setting = await http().get('/v1/admin/settings/reporter-identity').set('Authorization', `Bearer ${admin.token}`).expect(200);
    expect(setting.body).toMatchObject({ access: 'separate', updated_by: null });
    expect(await sees(identityHolder)).toBe(LEGAL);
    expect(await sees(sourceHolder)).toBeUndefined();
    expect(await sees(chief)).toBeUndefined();
    expect(await sees(reporter)).toBeUndefined();
    const { rows } = await h.pool.query(`SELECT details FROM audit_log WHERE actor_id = $1 AND action = 'material.sensitive_read' AND target_id = $2`, [
      identityHolder.id,
      materialId,
    ]);
    expect(rows).toEqual([{ details: { material_id: materialId, field_keys: ['reporter_legal_name'] } }]);
  });

  it('switching to protected_source takes effect live, audited, with one event notifying every system admin', async () => {
    const res = await put(admin, { access: 'protected_source', reason_code: 'policy_change' }).expect(200);
    expect(res.body).toMatchObject({ access: 'protected_source', updated_by: admin.id });
    expect(await sees(sourceHolder)).toBe(LEGAL);
    expect(await sees(identityHolder)).toBeUndefined();
    expect(await sees(chief)).toBeUndefined();

    expect(await changes()).toEqual([{ setting: 'reporter_legal_name_access', value: 'protected_source', reason_code: 'policy_change' }]);
    const [event, ...more] = await events();
    expect(more).toEqual([]);
    expect(event).toEqual({
      setting: 'reporter_legal_name_access',
      value: 'protected_source',
      actor_id: admin.id,
      reason_code: 'policy_change',
      occurred_at: expect.any(String),
    });
    // لا اسم حقيقي في الحدث ولا في التدقيق ولا في الإشعار
    expect(JSON.stringify([event, await changes()])).not.toContain(LEGAL);
    await drainOutbox(h);
    const { rows } = await h.pool.query<{ user_id: string; title: string }>(
      `SELECT n.user_id, n.title FROM notifications n JOIN outbox_events e ON e.id = n.event_id WHERE e.type = 'setting.changed' AND e.aggregate_id = $1`,
      [admin.id],
    );
    expect(rows.map((r) => r.user_id)).toEqual(expect.arrayContaining([admin.id, otherAdmin.id]));
    expect(rows.every((r) => !r.title.includes(LEGAL) && !r.title.includes('protected_source'))).toBe(true);
  });

  it('the same value again writes neither event nor audit; switching back restores separate', async () => {
    const before = { audit: (await changes()).length, events: (await events()).length };
    await put(otherAdmin, { access: 'protected_source', reason_code: 'operational_need' }).expect(200);
    expect((await changes()).length).toBe(before.audit);
    expect((await events()).length).toBe(before.events);

    const back = await put(otherAdmin, { access: 'separate', reason_code: 'audit_finding' }).expect(200);
    expect(back.body).toMatchObject({ access: 'separate', updated_by: otherAdmin.id });
    expect(await sees(sourceHolder)).toBeUndefined();
    expect(await sees(identityHolder)).toBe(LEGAL);
    expect((await changes()).length).toBe(before.audit + 1);
  });

  it('is for system admins only, with a coded reason', async () => {
    await http().get('/v1/admin/settings/reporter-identity').set('Authorization', `Bearer ${chief.token}`).expect(403);
    await put(identityHolder, { access: 'protected_source', reason_code: 'policy_change' }).expect(403);
    await put(admin, { access: 'protected_source' }).expect(422);
    await put(admin, { access: 'protected_source', reason_code: 'because I said so' }).expect(422);
    await put(admin, { access: 'everyone', reason_code: 'policy_change' }).expect(422);
    await put(admin, { access: 'protected_source', reason_code: 'policy_change', note: 'x' }).expect(422);
  });
});
