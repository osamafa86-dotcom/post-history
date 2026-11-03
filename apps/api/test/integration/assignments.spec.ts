import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { EscalationWorker } from '../../src/notifications/escalation.worker';
import { createHarness, drainOutbox, ensureForm, type Harness, loginAs, seedUser } from './harness';

type Actor = Awaited<ReturnType<typeof loginAs>>;

// نص محايد؛ والملاحظة كناري: لا تظهر في حدث ولا إشعار ولا سجل تدقيق (ADR 0096)
const NOTE = 'ملاحظة كناري للاختبار';
const RETURN_NOTE = 'سبب إعادة كناري';
const inMinutes = (m: number) => new Date(Date.now() + m * 60_000).toISOString();

// إسناد المادة إلى المونتير و«مهامي» (ADR 0096)
describe('material assignments', () => {
  let h: Harness;
  let office: string;
  let otherOffice: string;
  let reporter: Actor;
  let supervisor: Actor;
  let otherSupervisor: Actor;
  let producer: Actor;
  let producer2: Actor;
  let chief: Actor;

  beforeAll(async () => {
    h = await createHarness({ env: { ESCALATION_URGENT_SECONDS: '120', ESCALATION_IMPORTANT_SECONDS: '600' } });
    await ensureForm(h);
    const newOffice = async () => (await h.pool.query<{ id: string }>(`INSERT INTO offices (name_ar, name_en) VALUES ('م', 'o') RETURNING id`)).rows[0]!.id;
    office = await newOffice();
    otherOffice = await newOffice();
    reporter = await loginAs(h, [{ role: 'reporter' }], { officeId: office });
    supervisor = await loginAs(h, [{ role: 'supervisor', scopeKind: 'office', scopeId: office }]);
    otherSupervisor = await loginAs(h, [{ role: 'supervisor', scopeKind: 'office', scopeId: otherOffice }]);
    producer = await loginAs(h, [{ role: 'producer' }]);
    producer2 = await loginAs(h, [{ role: 'producer' }]);
    chief = await loginAs(h, [{ role: 'editor_in_chief' }]);
    await h.pool.query(`UPDATE users SET work_name = $2 WHERE id = $1`, [producer.id, 'مونتير تجريبي ١']);
    await h.pool.query(`UPDATE users SET work_name = $2 WHERE id = $1`, [supervisor.id, 'محرر تجريبي ١']);
  });
  afterAll(() => h.close());

  const http = () => request(h.app.getHttpServer());
  const as = (a: Actor) => ({
    get: (url: string) => http().get(`/v1${url}`).set('Authorization', `Bearer ${a.token}`),
    post: (url: string, body: object, key: string = randomUUID()) => http().post(`/v1${url}`).set('Authorization', `Bearer ${a.token}`).set('Idempotency-Key', key).send(body),
  });

  const material = async (priority: 'urgent' | 'important' | 'normal' = 'normal', editorial = 'accepted') => {
    const res = await as(reporter)
      .post('/materials', {
        title: 'عنوان تجريبي',
        material_types: ['report'],
        governorate: 'محافظة',
        city: 'مدينة',
        priority,
        sensitivity: { minors: false, injured: false, graphic: false },
        display_name: { mode: 'network' },
        form_version: 1,
        dynamic_fields: {},
      })
      .expect(201);
    await h.pool.query(`UPDATE materials SET editorial_state = $2 WHERE id = $1`, [res.body.id, editorial]);
    return res.body.id as string;
  };
  const assign = (materialId: string, over: object = {}, by: Actor = supervisor, key?: string) =>
    as(by).post(`/materials/${materialId}/assignments`, { assignee_id: producer.id, due_at: inMinutes(30), note: NOTE, ...over }, key);
  const move = (a: Actor, id: string, to: string, extra: object = {}) => as(a).post(`/assignments/${id}/transitions`, { to, ...extra });
  const eventsOf = async (assignmentId: string) =>
    (await h.pool.query<{ type: string; payload: Record<string, unknown> }>(
      `SELECT type, payload FROM outbox_events WHERE payload->>'assignment_id' = $1 ORDER BY id`, [assignmentId])).rows;
  const notificationsOf = async (assignmentId: string) =>
    (await h.pool.query<{ id: string; user_id: string; type: string; title: string; state: string; assignment_state: string | null; escalate_at: string | null }>(
      `SELECT id, user_id, type, title, state, assignment_state, escalate_at FROM notifications WHERE assignment_id = $1 ORDER BY created_at, id`,
      [assignmentId])).rows;
  const states = async (materialId: string) =>
    (await h.pool.query(`SELECT technical_state, editorial_state, rights_state, reserved_by FROM materials WHERE id = $1`, [materialId])).rows[0];

  it('assigns an accepted material: ids-only event and audit, names for staff, and the three states untouched', async () => {
    const m = await material('important');
    const before = await states(m);
    const key = randomUUID();
    const due = { due_at: inMinutes(30) };
    const res = await assign(m, due, supervisor, key).expect(201);
    expect(res.body).toMatchObject({
      material_id: m,
      priority: 'important',
      assignee_id: producer.id,
      assignee_name: 'مونتير تجريبي ١',
      assigned_by: supervisor.id,
      assigned_by_name: 'محرر تجريبي ١',
      state: 'assigned',
      overdue: false,
      note: NOTE,
      returned_by: null,
      return_note: null,
      acknowledged_at: null,
      started_at: null,
      closed_at: null,
    });
    expect(await states(m)).toEqual(before);

    // التكرار بالمفتاح نفسه يعيد المهمة نفسها دون حدث ثانٍ
    const again = await assign(m, due, supervisor, key).expect(201);
    expect(again.body.id).toBe(res.body.id);
    const events = await eventsOf(res.body.id);
    expect(events).toEqual([
      {
        type: 'assignment.created',
        payload: { material_id: m, assignment_id: res.body.id, priority: 'important', assignee_id: producer.id, assigned_by: supervisor.id },
      },
    ]);
    const audit = await h.pool.query(`SELECT action, details FROM audit_log WHERE target_type = 'material_assignment' AND target_id = $1`, [res.body.id]);
    expect(audit.rows).toEqual([
      { action: 'assignment.created', details: { assignment_id: res.body.id, material_id: m, target_user_id: producer.id, to: 'assigned' } },
    ]);
    expect(JSON.stringify(audit.rows)).not.toContain(NOTE);

    // رئيس التحرير يُسند كذلك، بلا ملاحظة
    const m2 = await material();
    const byChief = await assign(m2, { note: undefined }, chief).expect(201);
    expect(byChief.body).toMatchObject({ assigned_by: chief.id, note: null });
  });

  it('turns the event into a task notification on the existing mechanism, which escalates and stops on acknowledgement', async () => {
    const m = await material('urgent');
    const a = (await assign(m).expect(201)).body;
    await drainOutbox(h);
    const [task, ...rest] = await notificationsOf(a.id);
    expect(rest).toEqual([]);
    expect(task).toMatchObject({ user_id: producer.id, type: 'assignment.created', state: 'sent', assignment_state: 'assigned' });
    expect(task!.escalate_at).not.toBeNull();
    expect(task!.title).toContain(m.slice(0, 8));
    expect(task!.title).not.toContain(NOTE);
    const inbox = await as(producer).get('/notifications').expect(200);
    expect(inbox.body.items.find((n: { id: string }) => n.id === task!.id)).toMatchObject({ assignment_id: a.id, assignment_state: 'assigned' });
    // يظهر موعد الإقرار على المادة كما في الإشعارات القائمة (ADR 0035)
    expect((await as(supervisor).get(`/materials/${m}`).expect(200)).body.acknowledgement_due_at).not.toBeNull();

    // التصعيد بالسلّم الافتراضي حين يحين ولم يُقرّ
    await h.pool.query(`UPDATE notifications SET escalate_at = now() - interval '1 second' WHERE id = $1`, [task!.id]);
    await h.app.get(EscalationWorker).escalateDue();
    await drainOutbox(h);
    const escalated = await h.pool.query(`SELECT user_id FROM notifications WHERE type = 'notification.escalated' AND material_id = $1`, [m]);
    expect(escalated.rows.map((r) => r.user_id)).toContain(chief.id);

    // الإقرار من المهمة يقرّ الإشعار ويوقف التصعيد
    await move(producer, a.id, 'acknowledged').expect(200);
    const [after] = await notificationsOf(a.id);
    expect(after).toMatchObject({ state: 'acknowledged', assignment_state: 'acknowledged', escalate_at: null });
  });

  it('acknowledging the task notification acknowledges the assignment', async () => {
    const a = (await assign(await material('important')).expect(201)).body;
    await drainOutbox(h);
    const [task] = await notificationsOf(a.id);
    await as(producer).post(`/notifications/${task!.id}/ack`, {}).expect(204);
    const read = await as(producer).get(`/assignments/${a.id}`).expect(200);
    expect(read.body).toMatchObject({ state: 'acknowledged' });
    expect(read.body.acknowledged_at).not.toBeNull();
    expect((await eventsOf(a.id)).map((e) => e.payload.to)).toEqual([undefined, 'acknowledged']);
  });

  it('a task started before the dispatcher runs arrives acknowledged and without escalation', async () => {
    const a = (await assign(await material('urgent')).expect(201)).body;
    const started = await move(producer, a.id, 'in_progress').expect(200);
    expect(started.body.acknowledged_at).not.toBeNull();
    expect(started.body.started_at).not.toBeNull();
    await drainOutbox(h);
    const [task] = await notificationsOf(a.id);
    expect(task).toMatchObject({ state: 'acknowledged', assignment_state: 'acknowledged', escalate_at: null });
  });

  it('enforces who assigns, to whom, on what, once, and by when', async () => {
    const m = await material();
    await assign(m, {}, reporter).expect(403);
    await assign(m, {}, producer).expect(403);
    await assign(m, {}, otherSupervisor).expect(404);
    await assign(randomUUID()).expect(404);

    const inbox = await material('normal', 'reviewing');
    const notReady = await assign(inbox).expect(409);
    expect(notReady.body).toMatchObject({ code: 'assignment_not_allowed', details: { failed: ['editorial_state'] } });

    expect((await assign(m, { assignee_id: reporter.id }).expect(422)).body.code).toBe('assignee_not_eligible');
    const suspended = await seedUser(h, { roles: [{ role: 'producer' }], status: 'suspended' });
    expect((await assign(m, { assignee_id: suspended.id }).expect(422)).body.code).toBe('assignee_not_eligible');
    expect((await assign(m, { assignee_id: randomUUID() }).expect(422)).body.code).toBe('assignee_not_eligible');

    expect((await assign(m, { due_at: inMinutes(-1) }).expect(422)).body).toMatchObject({ code: 'validation_failed', details: { fields: ['/due_at'] } });
    await assign(m, { due_at: inMinutes(31 * 24 * 60) }).expect(422);
    await assign(m, { note: ` ${NOTE}` }).expect(422);
    await assign(m, { note: `${NOTE}\nثانٍ` }).expect(422);
    await assign(m, { note: 'م'.repeat(501) }).expect(422);
    await assign(m, { extra: true }).expect(422);

    const first = (await assign(m).expect(201)).body;
    const second = await assign(m, { assignee_id: producer2.id }).expect(409);
    expect(second.body).toMatchObject({ code: 'assignment_open', details: { assignment_id: first.id } });
    expect((await eventsOf(first.id)).length).toBe(1);
  });

  it('follows the transition table and its owners, and returning frees the material for a new assignment', async () => {
    const m = await material('important');
    const before = await states(m);
    const a = (await assign(m).expect(201)).body;

    expect((await move(producer, a.id, 'done').expect(409)).body).toMatchObject({ code: 'invalid_transition', details: { from: 'assigned', to: 'done' } });
    expect((await move(producer2, a.id, 'acknowledged').expect(403)).body.code).toBe('forbidden_scope');
    expect((await move(supervisor, a.id, 'in_progress').expect(403)).body.code).toBe('forbidden_scope');
    await move(otherSupervisor, a.id, 'returned').expect(404);
    await move(reporter, a.id, 'returned').expect(403);
    expect((await move(producer, a.id, 'acknowledged', { note: NOTE }).expect(422)).body.details).toEqual({ fields: ['/note'] });
    await move(producer, a.id, 'paused').expect(422);

    await move(producer, a.id, 'acknowledged').expect(200);
    await move(producer, a.id, 'acknowledged').expect(409);
    await move(producer, a.id, 'in_progress').expect(200);
    const done = await move(producer, a.id, 'done').expect(200);
    expect(done.body).toMatchObject({ state: 'done', overdue: false });
    expect(done.body.closed_at).not.toBeNull();
    await move(producer, a.id, 'returned').expect(409);
    await drainOutbox(h);
    // التسليم يُعلم من أسند داخل المنصة
    const delivered = (await notificationsOf(a.id)).filter((n) => n.type === 'assignment.state_changed');
    expect(delivered.map((n) => [n.user_id, n.assignment_state])).toEqual([[supervisor.id, null]]);

    // مهمة جديدة بعد الإغلاق، يسحبها المشرف بسبب لإعادة التوزيع، ثم إسناد لغيره
    const b = (await assign(m).expect(201)).body;
    const back = await move(supervisor, b.id, 'returned', { note: RETURN_NOTE }).expect(200);
    expect(back.body).toMatchObject({ state: 'returned', returned_by: supervisor.id, return_note: RETURN_NOTE, acknowledged_at: null });
    const c = (await assign(m, { assignee_id: producer2.id }).expect(201)).body;
    // والمونتير يعيد ما أُسند إليه
    await move(producer2, c.id, 'returned').expect(200);
    await drainOutbox(h);
    const toProducer = (await notificationsOf(b.id)).filter((n) => n.type === 'assignment.state_changed');
    expect(toProducer.map((n) => n.user_id)).toEqual([producer.id]);
    expect(toProducer[0]!.title).not.toContain(RETURN_NOTE);
    const toSupervisor = (await notificationsOf(c.id)).filter((n) => n.type === 'assignment.state_changed');
    expect(toSupervisor.map((n) => n.user_id)).toEqual([supervisor.id]);

    const payloads = [...(await eventsOf(a.id)), ...(await eventsOf(b.id))];
    expect(payloads.map((e) => [e.type, e.payload.from, e.payload.to])).toEqual([
      ['assignment.created', undefined, undefined],
      ['assignment.state_changed', 'assigned', 'acknowledged'],
      ['assignment.state_changed', 'acknowledged', 'in_progress'],
      ['assignment.state_changed', 'in_progress', 'done'],
      ['assignment.created', undefined, undefined],
      ['assignment.state_changed', 'assigned', 'returned'],
    ]);
    expect(JSON.stringify(payloads)).not.toContain(RETURN_NOTE);
    const audit = await h.pool.query(`SELECT details FROM audit_log WHERE action = 'assignment.transitioned' AND target_id = $1 ORDER BY id`, [b.id]);
    expect(audit.rows).toEqual([{ details: { assignment_id: b.id, material_id: m, from: 'assigned', to: 'returned' } }]);
    expect(await states(m)).toEqual(before);

    // سجل المادة الأحدث أولًا، ويراه الإنتاج كما يرى المادة
    const list = await as(producer2).get(`/materials/${m}/assignments`).expect(200);
    expect(list.body.items.map((x: { id: string }) => x.id)).toEqual([c.id, b.id, a.id]);
    await as(otherSupervisor).get(`/materials/${m}/assignments`).expect(404);
    await as(reporter).get(`/materials/${m}/assignments`).expect(403);
  });

  it('reads one assignment for its assignee and those who see the material', async () => {
    const m = await material();
    const a = (await assign(m).expect(201)).body;
    await as(producer).get(`/assignments/${a.id}`).expect(200);
    await as(supervisor).get(`/assignments/${a.id}`).expect(200);
    await as(chief).get(`/assignments/${a.id}`).expect(200);
    await as(otherSupervisor).get(`/assignments/${a.id}`).expect(404);
    await as(reporter).get(`/assignments/${a.id}`).expect(403);
    await as(producer).get(`/assignments/${randomUUID()}`).expect(404);
    await as(producer).get('/assignments/not-a-uuid').expect(404);
  });

  it('lists «my tasks» overdue first, then by due time, with a summary over all of them', async () => {
    const mine = await loginAs(h, [{ role: 'producer' }]);
    const make = async (minutes: number, priority: 'urgent' | 'normal' = 'normal') =>
      (await assign(await material(priority), { assignee_id: mine.id, due_at: inMinutes(minutes) }).expect(201)).body.id as string;
    const later = await make(120);
    const soon = await make(20, 'urgent');
    const late = await make(60);
    // متأخرة: الموعد قبل الآن (والإنشاء قبله، قيد القاعدة)
    await h.pool.query(`UPDATE material_assignments SET created_at = now() - interval '2 hours', due_at = now() - interval '1 hour' WHERE id = $1`, [late]);
    const finished = await make(90);
    await move(mine, finished, 'in_progress').expect(200);
    await move(mine, finished, 'done').expect(200);

    const open = await as(mine).get('/me/assignments').expect(200);
    expect(open.body.items.map((x: { id: string }) => x.id)).toEqual([late, soon, later]);
    expect(open.body.items[0]).toMatchObject({ overdue: true });
    expect(open.body.items[1]).toMatchObject({ overdue: false, priority: 'urgent' });
    expect(open.body.summary).toEqual({ open: 3, overdue: 1, done_last_7_days: 1 });
    expect(open.body.next_cursor).toBeNull();

    const page1 = await as(mine).get('/me/assignments?limit=2').expect(200);
    expect(page1.body.items.map((x: { id: string }) => x.id)).toEqual([late, soon]);
    const page2 = await as(mine).get(`/me/assignments?limit=2&cursor=${page1.body.next_cursor}`).expect(200);
    expect(page2.body.items.map((x: { id: string }) => x.id)).toEqual([later]);
    expect(page2.body.next_cursor).toBeNull();

    const closed = await as(mine).get('/me/assignments?status=closed').expect(200);
    expect(closed.body.items.map((x: { id: string }) => x.id)).toEqual([finished]);
    await as(mine).get('/me/assignments?status=all').expect(400);
    await as(mine).get('/me/assignments?cursor=bad').expect(400);
    await as(supervisor).get('/me/assignments').expect(403);
    expect((await as(producer2).get('/me/assignments').expect(200)).body.items.map((x: { assignee_id: string }) => x.assignee_id)).not.toContain(mine.id);

    // المرشّحون: المنتجون النشطون وحدهم بحمل كلٍّ منهم، بلا بريد
    const candidates = await as(supervisor).get('/assignment-candidates').expect(200);
    const row = candidates.body.items.find((c: { user_id: string }) => c.user_id === mine.id);
    expect(row).toEqual({ user_id: mine.id, work_name: null, open_count: 3, urgent_open_count: 1, overdue_count: 1 });
    const ids = candidates.body.items.map((c: { user_id: string }) => c.user_id);
    expect(ids).not.toContain(reporter.id);
    expect(ids).not.toContain(supervisor.id);
    expect(JSON.stringify(candidates.body)).not.toContain('@');
    await as(producer).get('/assignment-candidates').expect(403);
  });
});
