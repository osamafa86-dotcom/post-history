import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { EscalationWorker } from '../../src/notifications/escalation.worker';
import { OutboxDispatcher } from '../../src/outbox/outbox.dispatcher';
import { createHarness, ensureForm, type Harness, loginAs } from './harness';

type Actor = Awaited<ReturnType<typeof loginAs>>;

// المهلة قابلة للحقن: 2 ثانية للعاجل هنا، ويُقدَّم escalate_at في القاعدة بدل الانتظار.
describe('escalation of unacknowledged urgent tasks', () => {
  let h: Harness;
  let worker: EscalationWorker;
  let dispatcher: OutboxDispatcher;
  let reporter: Actor;
  let supervisor: Actor;
  let editor: Actor;
  let admin: Actor;

  beforeAll(async () => {
    h = await createHarness({ env: { ESCALATION_URGENT_SECONDS: '2', ESCALATION_IMPORTANT_SECONDS: '7' } });
    worker = h.app.get(EscalationWorker);
    dispatcher = h.app.get(OutboxDispatcher);
    await ensureForm(h);
    const office = (await h.pool.query<{ id: string }>(`INSERT INTO offices (name_ar, name_en) VALUES ('م', 'o') RETURNING id`)).rows[0]!.id;
    reporter = await loginAs(h, [{ role: 'reporter' }], { officeId: office });
    supervisor = await loginAs(h, [{ role: 'supervisor', scopeKind: 'office', scopeId: office }]);
    editor = await loginAs(h, [{ role: 'editor_in_chief' }]);
    admin = await loginAs(h, [{ role: 'system_admin' }]);
    // لا تتدخل مهام الملفات الأخرى
    await h.pool.query(`UPDATE notifications SET escalate_at = NULL`);
  });
  afterAll(() => h.close());

  const http = () => request(h.app.getHttpServer());
  const drain = async () => {
    while ((await dispatcher.dispatchBatch(500)) > 0);
  };
  const inbox = async (a: Actor) =>
    (await http().get('/v1/notifications?limit=100').set('Authorization', `Bearer ${a.token}`).expect(200)).body.items as Array<Record<string, any>>;
  const material = async (priority: string) => {
    const res = await http()
      .post('/v1/materials')
      .set('Authorization', `Bearer ${reporter.token}`)
      .set('Idempotency-Key', randomUUID())
      .send({
        title: 'Urgent footage title',
        material_types: ['breaking'],
        governorate: 'gaza',
        city: 'gaza',
        priority,
        sensitivity: { minors: false, injured: false, graphic: false },
        display_name: { mode: 'network' },
        form_version: 1,
        dynamic_fields: {},
      })
      .expect(201);
    await drain();
    return (await inbox(supervisor)).find((n) => n.material_id === res.body.id)!;
  };
  const due = (id: string) => h.pool.query(`UPDATE notifications SET escalate_at = now() - interval '1 second' WHERE id = $1`, [id]);

  it('sets the deadline by priority: urgent and important tasks only', async () => {
    const urgent = await material('urgent');
    const normal = await material('normal');
    const { rows } = await h.pool.query(
      `SELECT id, extract(epoch FROM escalate_at - created_at) AS secs FROM notifications WHERE id = ANY($1)`,
      [[urgent.id, normal.id]],
    );
    const secs = Object.fromEntries(rows.map((r) => [r.id, r.secs === null ? null : Math.round(Number(r.secs))]));
    expect(secs[urgent.id]).toBe(2);
    expect(secs[normal.id]).toBeNull();
  });

  it('escalates to the editor in chief, then to the system admin, then stops', async () => {
    const task = await material('urgent');
    await due(task.id);
    expect(await worker.escalateDue()).toBe(1);
    await drain();
    const toEditor = (await inbox(editor)).filter((n) => n.material_id === task.material_id);
    expect(toEditor).toEqual([expect.objectContaining({ type: 'notification.escalated', assignment_state: 'assigned', priority: 'urgent' })]);
    expect(toEditor[0]!.title).toBe(`تصعيد: لم يُقرّ استلام المادة #${task.material_id.slice(0, 8)}`);
    expect((await inbox(supervisor)).find((n) => n.id === task.id)!.escalation_level).toBe(1);
    const { rows: ev } = await h.pool.query(
      `SELECT payload FROM outbox_events WHERE type = 'notification.escalated' AND aggregate_id = $1 ORDER BY id`,
      [task.id],
    );
    // حدث لكل رئيس تحرير نشط (القاعدة المشتركة في الاختبارات فيها أكثر من واحد)
    expect(ev.map((e) => e.payload)).toContainEqual({
      notification_id: task.id,
      material_id: task.material_id,
      escalation_level: 1,
      priority: 'urgent',
      escalated_to: editor.id,
    });

    await due(task.id);
    await worker.escalateDue();
    await drain();
    expect((await inbox(admin)).some((n) => n.material_id === task.material_id && n.type === 'notification.escalated')).toBe(true);
    const { rows } = await h.pool.query(`SELECT escalation_level, escalate_at FROM notifications WHERE id = $1`, [task.id]);
    expect(rows[0]).toEqual({ escalation_level: 2, escalate_at: null });
  });

  it('acknowledging stops the chain; acknowledging the escalation stops the original too', async () => {
    const acked = await material('urgent');
    await http().post(`/v1/notifications/${acked.id}/ack`).set('Authorization', `Bearer ${supervisor.token}`).set('Idempotency-Key', randomUUID()).expect(204);
    await due(acked.id);
    await h.pool.query(`UPDATE notifications SET escalate_at = NULL WHERE id <> $1 AND acknowledged_at IS NULL AND escalate_at IS NOT NULL`, [acked.id]);
    expect(await worker.escalateDue()).toBe(0);

    const task = await material('urgent');
    await due(task.id);
    await worker.escalateDue();
    await drain();
    const escalation = (await inbox(editor)).find((n) => n.material_id === task.material_id)!;
    await http().post(`/v1/notifications/${escalation.id}/ack`).set('Authorization', `Bearer ${editor.token}`).set('Idempotency-Key', randomUUID()).expect(204);
    const { rows } = await h.pool.query(`SELECT escalate_at FROM notifications WHERE id = $1`, [task.id]);
    expect(rows[0].escalate_at).toBeNull();
  });
});
