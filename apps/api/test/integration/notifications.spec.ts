import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { schemaValidator } from '../../src/common/contract';
import { DB, type Database } from '../../src/database/database.module';
import { writeOutboxEvent } from '../../src/outbox/outbox';
import { createHarness, drainOutbox, ensureForm, type Harness, loginAs } from './harness';

type Actor = Awaited<ReturnType<typeof loginAs>>;

describe('notifications and events', () => {
  let h: Harness;
  let officeA: string;
  let reporter: Actor;
  let supervisor: Actor;
  let otherSupervisor: Actor;
  let producer: Actor;
  let admin: Actor;

  beforeAll(async () => {
    h = await createHarness();
    await ensureForm(h);
    const office = async () =>
      (await h.pool.query<{ id: string }>(`INSERT INTO offices (name_ar, name_en, governorate) VALUES ('م', 'o', 'gaza') RETURNING id`)).rows[0]!.id;
    officeA = await office();
    const officeB = await office();
    reporter = await loginAs(h, [{ role: 'reporter' }], { officeId: officeA });
    supervisor = await loginAs(h, [{ role: 'supervisor', scopeKind: 'office', scopeId: officeA }]);
    otherSupervisor = await loginAs(h, [{ role: 'supervisor', scopeKind: 'office', scopeId: officeB }]);
    producer = await loginAs(h, [{ role: 'producer' }]);
    admin = await loginAs(h, [{ role: 'system_admin' }]);
  });
  afterAll(() => h.close());

  const http = () => request(h.app.getHttpServer());
  const get = (a: Actor, url: string) => http().get(url).set('Authorization', `Bearer ${a.token}`);
  const post = (a: Actor, url: string, body?: object) =>
    http().post(url).set('Authorization', `Bearer ${a.token}`).set('Idempotency-Key', randomUUID()).send(body);
  const drain = async () => {
    await drainOutbox(h);
  };
  const inbox = async (a: Actor) => (await get(a, '/v1/notifications?limit=100').expect(200)).body;
  const createMaterial = async (priority = 'normal') =>
    (
      await post(reporter, '/v1/materials', {
        title: 'Secret meeting with a named source',
        material_types: ['report'],
        governorate: 'gaza',
        city: 'gaza',
        priority,
        sensitivity: { minors: false, injured: false, graphic: false },
        display_name: { mode: 'network' },
        form_version: 1,
        dynamic_fields: {},
      }).expect(201)
    ).body as { id: string };

  it('incoming material notifies supervisors in scope only, once even when urgent, with a template title', async () => {
    const m = await createMaterial('urgent');
    await drain();
    const mine = (await inbox(supervisor)).items.filter((n: { material_id: string }) => n.material_id === m.id);
    expect(mine).toEqual([
      expect.objectContaining({
        type: 'material.urgent_received',
        title: `مادة عاجلة واردة #${m.id.slice(0, 8)}`,
        priority: 'urgent',
        state: 'sent',
        assignment_state: 'assigned',
        read_at: null,
      }),
    ]);
    const valid = schemaValidator('Notification');
    expect(valid(mine[0]) ? [] : valid.errors).toEqual([]);
    expect(JSON.stringify(mine)).not.toContain('Secret meeting');
    expect((await inbox(otherSupervisor)).items.some((n: { material_id: string }) => n.material_id === m.id)).toBe(false);
    // التكرار لا يكرر الإشعار
    await h.pool.query(`UPDATE outbox_events SET published_at = NULL WHERE aggregate_id = $1`, [m.id]);
    await drain();
    expect((await inbox(supervisor)).items.filter((n: { material_id: string }) => n.material_id === m.id)).toHaveLength(1);
  });

  it('read and ack: unread count, idempotency, ack moves the material to acknowledged and tells the reporter', async () => {
    const m = await createMaterial();
    await drain();
    const before = await inbox(supervisor);
    const n = before.items.find((x: { material_id: string }) => x.material_id === m.id);
    expect(n.type).toBe('material.created');
    await post(supervisor, `/v1/notifications/${n.id}/read`).expect(204);
    await post(supervisor, `/v1/notifications/${n.id}/read`).expect(204);
    const afterRead = await inbox(supervisor);
    expect(afterRead.unread_count).toBe(before.unread_count - 1);
    expect(afterRead.items.find((x: { id: string }) => x.id === n.id)).toMatchObject({ state: 'read' });

    await post(supervisor, `/v1/notifications/${n.id}/ack`).expect(204);
    await post(supervisor, `/v1/notifications/${n.id}/ack`).expect(204);
    const acked = (await inbox(supervisor)).items.find((x: { id: string }) => x.id === n.id);
    expect(acked).toMatchObject({ state: 'acknowledged', assignment_state: 'acknowledged', acknowledged_at: expect.any(String) });
    expect((await get(supervisor, `/v1/materials/${m.id}`).expect(200)).body.editorial_state).toBe('acknowledged');

    await drain();
    const seen = (await inbox(reporter)).items.filter((x: { material_id: string }) => x.material_id === m.id);
    expect(seen).toEqual([expect.objectContaining({ type: 'material.acknowledged', title: `شوهدت مادتك #${m.id.slice(0, 8)}` })]);
    // read بعد ack لا يتراجع
    await post(supervisor, `/v1/notifications/${n.id}/read`).expect(204);
    expect((await inbox(supervisor)).items.find((x: { id: string }) => x.id === n.id).state).toBe('acknowledged');
  });

  it("another user's notification is 404 for read and ack", async () => {
    const m = await createMaterial();
    await drain();
    const n = (await inbox(supervisor)).items.find((x: { material_id: string }) => x.material_id === m.id);
    await post(reporter, `/v1/notifications/${n.id}/read`).expect(404);
    await post(reporter, `/v1/notifications/${n.id}/ack`).expect(404);
    await post(reporter, `/v1/notifications/not-a-uuid/ack`).expect(404);
  });

  it('receipt: a verified original with a receipt number notifies the reporter with the number', async () => {
    const m = await createMaterial();
    const sessionId = randomUUID();
    await h.app.get<Database>(DB).transaction((tx) =>
      writeOutboxEvent(tx, {
        type: 'upload.verified',
        aggregateType: 'upload',
        aggregateId: sessionId,
        idempotencyKey: `upload.verified:${sessionId}`,
        payload: { material_id: m.id, upload_session_id: sessionId, kind: 'original', receipt_number: 'R-202610-000042' },
      }),
    );
    await drain();
    const receipt = (await inbox(reporter)).items.filter((x: { type: string; material_id: string }) => x.type === 'upload.verified' && x.material_id === m.id);
    expect(receipt).toEqual([
      expect.objectContaining({ title: `تم الاستلام بنجاح — المادة #${m.id.slice(0, 8)}، الإيصال R-202610-000042`, assignment_state: null }),
    ]);
  });

  it('accepted for production assigns producers; their ack records the receipt of the task', async () => {
    const m = await createMaterial();
    await h.pool.query(`UPDATE materials SET editorial_state = 'reviewing' WHERE id = $1`, [m.id]);
    await post(supervisor, `/v1/materials/${m.id}/transitions`, { track: 'editorial', to: 'accepted', reason: 'good' }).expect(200);
    await drain();
    const task = (await inbox(producer)).items.find((x: { material_id: string }) => x.material_id === m.id);
    expect(task).toMatchObject({ type: 'material.accepted_for_production', assignment_state: 'assigned' });
    await post(producer, `/v1/notifications/${task.id}/ack`).expect(204);
    expect((await inbox(producer)).items.find((x: { id: string }) => x.id === task.id).assignment_state).toBe('acknowledged');
  });

  it('paginates the inbox and filters unread', async () => {
    const page1 = await get(supervisor, '/v1/notifications?limit=1').expect(200);
    expect(page1.body.items).toHaveLength(1);
    const page2 = await get(supervisor, `/v1/notifications?limit=1&cursor=${page1.body.next_cursor}`).expect(200);
    expect(page2.body.items[0].id).not.toBe(page1.body.items[0].id);
    const unread = await get(supervisor, '/v1/notifications?unread_only=true&limit=100').expect(200);
    expect(unread.body.items.every((x: { read_at: string | null }) => x.read_at === null)).toBe(true);
    await get(supervisor, '/v1/notifications?cursor=bad').expect(400);
  });

  it('GET /events: system admin only, ordered, filtered, resumable with next_after', async () => {
    await get(supervisor, '/v1/events').expect(403);
    const first = await get(admin, '/v1/events?type=material.created&limit=2').expect(200);
    expect(first.body.items.length).toBeGreaterThan(0);
    const valid = schemaValidator('OutboxEvent');
    for (const e of first.body.items) {
      expect(e.type).toBe('material.created');
      expect(valid(e) ? [] : valid.errors).toEqual([]);
    }
    const next = await get(admin, `/v1/events?type=material.created&after=${first.body.next_after}&limit=2`).expect(200);
    for (const e of next.body.items) expect(Number(e.id)).toBeGreaterThan(Number(first.body.next_after));
    const end = await get(admin, '/v1/events?after=999999999999').expect(200);
    expect(end.body).toEqual({ items: [], next_after: '999999999999' });
    await get(admin, '/v1/events?after=abc').expect(400);
  });
});
