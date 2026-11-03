import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { EscalationWorker } from '../../src/notifications/escalation.worker';
import { createHarness, drainOutbox, ensureForm, type Harness, loginAs } from './harness';

type Actor = Awaited<ReturnType<typeof loginAs>>;

// المهلة قابلة للحقن: 2 ثانية للعاجل هنا، ويُقدَّم escalate_at في القاعدة بدل الانتظار.
describe('escalation of unacknowledged urgent tasks', () => {
  let h: Harness;
  let worker: EscalationWorker;
  let reporter: Actor;
  let supervisor: Actor;
  let editor: Actor;
  let admin: Actor;
  let supervisorB: Actor;
  let producers: Actor[];

  beforeAll(async () => {
    h = await createHarness({ env: { ESCALATION_URGENT_SECONDS: '2', ESCALATION_IMPORTANT_SECONDS: '7' } });
    worker = h.app.get(EscalationWorker);
    await ensureForm(h);
    const office = (await h.pool.query<{ id: string }>(`INSERT INTO offices (name_ar, name_en) VALUES ('م', 'o') RETURNING id`)).rows[0]!.id;
    reporter = await loginAs(h, [{ role: 'reporter' }], { officeId: office });
    supervisor = await loginAs(h, [{ role: 'supervisor', scopeKind: 'office', scopeId: office }]);
    editor = await loginAs(h, [{ role: 'editor_in_chief' }]);
    admin = await loginAs(h, [{ role: 'system_admin' }]);
    supervisorB = await loginAs(h, [{ role: 'supervisor', scopeKind: 'office', scopeId: office }]);
    producers = [await loginAs(h, [{ role: 'producer' }]), await loginAs(h, [{ role: 'producer' }])];
    // لا تتدخل مهام الملفات الأخرى
    await h.pool.query(`UPDATE notifications SET escalate_at = NULL`);
  });
  afterAll(() => h.close());

  const http = () => request(h.app.getHttpServer());
  const drain = async () => {
    await drainOutbox(h);
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
  // مهام المادة: كل مستلم نسخة، والمادة تُحسم مرة واحدة
  const post = (a: Actor, url: string, body: object) =>
    http().post(`/v1${url}`).set('Authorization', `Bearer ${a.token}`).set('Idempotency-Key', randomUUID()).send(body);
  const tasksOf = async (materialId: string, types: string[]) =>
    (
      await h.pool.query<{ id: string; user_id: string; type: string; assignment_state: string | null; acknowledged_at: string | null; escalate_at: string | null; escalation_level: number }>(
        `SELECT id, user_id, type, assignment_state, acknowledged_at, escalate_at, escalation_level FROM notifications WHERE material_id = $1 AND type = ANY($2) ORDER BY id`,
        [materialId, types],
      )
    ).rows;
  const escalationsOf = async (materialId: string) =>
    (
      await h.pool.query<{ aggregate_id: string; payload: Record<string, unknown> }>(
        `SELECT aggregate_id, payload FROM outbox_events WHERE type = 'notification.escalated' AND payload->>'material_id' = $1 ORDER BY id`,
        [materialId],
      )
    ).rows;
  // مهام المواد الأخرى لا تتدخل، وكل مهمة مفتوحة لهذه المادة يحين موعدها الآن
  const allDue = async (materialId: string, types?: string[]) => {
    await h.pool.query(
      `UPDATE notifications SET escalate_at = NULL WHERE material_id IS DISTINCT FROM $1 AND acknowledged_at IS NULL AND escalate_at IS NOT NULL`,
      [materialId],
    );
    await h.pool.query(
      `UPDATE notifications SET escalate_at = CASE WHEN $2::text[] IS NULL OR type = ANY($2) THEN now() - interval '1 second' END
        WHERE material_id = $1 AND acknowledged_at IS NULL AND escalate_at IS NOT NULL`,
      [materialId, types ?? null],
    );
  };
  const created = async (priority: string) => (await material(priority)).material_id as string;
  const accepted = async () => {
    const m = await created('urgent');
    for (const to of ['acknowledged', 'reviewing', 'accepted']) {
      await post(supervisor, `/materials/${m}/transitions`, { track: 'editorial', to, reason: 'flow' }).expect(200);
    }
    await drain();
    return m;
  };
  const inMinutes = (n: number) => new Date(Date.now() + n * 60_000).toISOString();
  const RECEIPT = ['material.created', 'material.urgent_received'];
  const PRODUCTION = ['material.accepted_for_production'];

  it('receiving the material closes every supervisor receipt task, so none escalates to the editor in chief after it', async () => {
    const m = await created('urgent');
    const open = await tasksOf(m, RECEIPT);
    expect(open.map((n) => n.user_id)).toEqual(expect.arrayContaining([supervisor.id, supervisorB.id]));
    await post(supervisor, `/materials/${m}/transitions`, { track: 'editorial', to: 'acknowledged', reason: 'received' }).expect(200);
    const after = await tasksOf(m, RECEIPT);
    expect(after.every((n) => n.assignment_state === 'acknowledged' && n.escalate_at === null)).toBe(true);
    // الفاعل أقرّ إشعاره، والمشرف الآخر أُغلقت مهمته وبقي إشعاره كما هو في صندوقه
    expect(after.filter((n) => n.acknowledged_at !== null).map((n) => n.user_id)).toEqual([supervisor.id]);
    // المادة بلا موعد إقرار بعد استلامها
    const read = await http().get(`/v1/materials/${m}`).set('Authorization', `Bearer ${supervisorB.token}`).expect(200);
    expect(read.body.acknowledgement_due_at).toBeNull();
    await h.pool.query(`UPDATE notifications SET escalate_at = now() - interval '1 second' WHERE material_id = $1`, [m]);
    await worker.escalateDue();
    expect(await escalationsOf(m)).toEqual([]);
  });

  it('a receipt task whose material was received before the fan-out is closed at its deadline, not escalated', async () => {
    const m = await created('urgent');
    // الاستلام سبق المُرسل: المادة acknowledged ومهامها ما زالت مفتوحة
    await h.pool.query(`UPDATE materials SET editorial_state = 'acknowledged', acknowledged_at = now(), acknowledged_by = $2 WHERE id = $1`, [m, supervisor.id]);
    await allDue(m);
    expect(await worker.escalateDue()).toBe(0);
    expect(await escalationsOf(m)).toEqual([]);
    expect((await tasksOf(m, RECEIPT)).every((n) => n.assignment_state === 'acknowledged' && n.escalate_at === null)).toBe(true);
  });

  it('accepted for production reaches every producer: it escalates once per material, and the assignment closes every copy', async () => {
    const m = await accepted();
    const copies = await tasksOf(m, PRODUCTION);
    expect(copies.map((n) => n.user_id)).toEqual(expect.arrayContaining(producers.map((p) => p.id)));
    expect(copies.every((n) => n.assignment_state === 'assigned' && n.escalate_at !== null)).toBe(true);

    await allDue(m);
    expect(await worker.escalateDue()).toBe(1);
    const events = await escalationsOf(m);
    // درج واحد للمادة: حدث لكل رئيس تحرير نشط عن نسخة واحدة، لا لكل نسخة
    expect(new Set(events.map((e) => e.aggregate_id)).size).toBe(1);
    expect(events.map((e) => e.payload.escalated_to)).toContain(editor.id);
    expect(new Set(events.map((e) => e.payload.escalated_to)).size).toBe(events.length);
    expect((await tasksOf(m, PRODUCTION)).every((n) => n.escalation_level === 1)).toBe(true);
    await drain();

    await post(supervisor, `/materials/${m}/assignments`, { assignee_id: producers[0]!.id, due_at: inMinutes(30) }).expect(201);
    const closed = await tasksOf(m, [...PRODUCTION, 'notification.escalated']);
    expect(closed.length).toBeGreaterThan(copies.length);
    expect(closed.every((n) => n.assignment_state === 'acknowledged' && n.escalate_at === null)).toBe(true);
    await h.pool.query(`UPDATE notifications SET escalate_at = now() - interval '1 second' WHERE material_id = $1`, [m]);
    await worker.escalateDue();
    expect((await escalationsOf(m)).length).toBe(events.length);
  });

  it('a production task whose material was assigned before the fan-out, or that one producer acknowledged, does not escalate', async () => {
    // الإسناد قبل المُرسل: النسخ تصل بعد الإسناد، وتُغلق عند موعدها
    const early = await created('urgent');
    for (const to of ['acknowledged', 'reviewing', 'accepted']) {
      await post(supervisor, `/materials/${early}/transitions`, { track: 'editorial', to, reason: 'flow' }).expect(200);
    }
    await post(supervisor, `/materials/${early}/assignments`, { assignee_id: producers[1]!.id, due_at: inMinutes(30) }).expect(201);
    await drain();
    // مهمة الإسناد نفسها للمونتير تبقى بسلسلتها؛ المقيس نسخ «قُبلت للإنتاج»
    await allDue(early, PRODUCTION);
    expect(await worker.escalateDue()).toBe(0);
    expect(await escalationsOf(early)).toEqual([]);

    // منتج واحد أقرّ: المهمة حُسمت، فلا تُصعَّد نسخ غيره
    const acked = await accepted();
    const [mine] = (await tasksOf(acked, PRODUCTION)).filter((n) => n.user_id === producers[0]!.id);
    await http().post(`/v1/notifications/${mine!.id}/ack`).set('Authorization', `Bearer ${producers[0]!.token}`).set('Idempotency-Key', randomUUID()).expect(204);
    await allDue(acked, PRODUCTION);
    expect(await worker.escalateDue()).toBe(0);
    expect(await escalationsOf(acked)).toEqual([]);
  });

  it('acknowledging the escalation stops every copy of the original task', async () => {
    const m = await created('urgent');
    await allDue(m);
    await worker.escalateDue();
    await drain();
    const escalation = (await inbox(editor)).find((n) => n.material_id === m && n.type === 'notification.escalated')!;
    await http().post(`/v1/notifications/${escalation.id}/ack`).set('Authorization', `Bearer ${editor.token}`).set('Idempotency-Key', randomUUID()).expect(204);
    expect((await tasksOf(m, RECEIPT)).every((n) => n.escalate_at === null)).toBe(true);
  });
});
