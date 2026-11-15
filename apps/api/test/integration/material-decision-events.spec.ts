import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { schemaValidator } from '../../src/common/contract';
import { createHarness, drainOutbox, ensureForm, type Harness, loginAs } from './harness';

type Actor = Awaited<ReturnType<typeof loginAs>>;
interface Note {
  id: string;
  type: string;
  title: string;
  material_id: string;
  assignment_state: string | null;
}

// ADR 0121: الرفض والقبول يصلان المراسل، وإعادة الإرسال بعد طلب التعديل تصل مشرفي مكتب المادة. الحمولة والعنوان بلا سبب ولا عنوان مادة.
describe('material decision events', () => {
  let h: Harness;
  let reporter: Actor;
  let supervisor: Actor;
  let colleague: Actor;
  let otherSupervisor: Actor;
  let producer: Actor;

  beforeAll(async () => {
    h = await createHarness();
    await ensureForm(h);
    const office = async () =>
      (await h.pool.query<{ id: string }>(`INSERT INTO offices (name_ar, name_en, governorate) VALUES ('م', 'o', 'gaza') RETURNING id`)).rows[0]!.id;
    const officeA = await office();
    const officeB = await office();
    reporter = await loginAs(h, [{ role: 'reporter' }], { officeId: officeA });
    supervisor = await loginAs(h, [{ role: 'supervisor', scopeKind: 'office', scopeId: officeA }]);
    colleague = await loginAs(h, [{ role: 'supervisor', scopeKind: 'office', scopeId: officeA }]);
    otherSupervisor = await loginAs(h, [{ role: 'supervisor', scopeKind: 'office', scopeId: officeB }]);
    producer = await loginAs(h, [{ role: 'producer' }]);
  });
  afterAll(() => h.close());

  const http = () => request(h.app.getHttpServer());
  const post = (a: Actor, url: string, body?: object) =>
    http().post(url).set('Authorization', `Bearer ${a.token}`).set('Idempotency-Key', randomUUID()).send(body);
  const notes = async (a: Actor, materialId: string, type: string): Promise<Note[]> =>
    ((await http().get('/v1/notifications?limit=100').set('Authorization', `Bearer ${a.token}`).expect(200)).body.items as Note[]).filter(
      (n) => n.material_id === materialId && n.type === type,
    );
  const move = (a: Actor, id: string, to: string, reason = 'Named source, cannot run') =>
    post(a, `/v1/materials/${id}/transitions`, { track: 'editorial', to, reason }).expect(200);
  const createMaterial = async () =>
    (
      await post(reporter, '/v1/materials', {
        title: 'Secret meeting with a named source',
        material_types: ['report'],
        governorate: 'gaza',
        city: 'gaza',
        priority: 'normal',
        sensitivity: { minors: false, injured: false, graphic: false },
        display_name: { mode: 'network' },
        form_version: 1,
        dynamic_fields: {},
      }).expect(201)
    ).body as { id: string };
  const payloads = async (materialId: string, type: string) =>
    (await h.pool.query<{ payload: Record<string, unknown> }>(`SELECT payload FROM outbox_events WHERE type = $1 AND aggregate_id = $2`, [type, materialId])).rows.map(
      (r) => r.payload,
    );
  const clean = (list: Note[]) => {
    const valid = schemaValidator('Notification');
    for (const n of list) expect(valid(n) ? [] : valid.errors).toEqual([]);
    expect(JSON.stringify(list)).not.toContain('Secret meeting');
    expect(JSON.stringify(list)).not.toContain('Named source');
  };

  it('a rejection reaches the reporter, with no reason and no title in the notification or the event', async () => {
    const m = await createMaterial();
    await move(supervisor, m.id, 'acknowledged');
    await move(supervisor, m.id, 'rejected');
    await drainOutbox(h);
    const mine = await notes(reporter, m.id, 'material.rejected');
    expect(mine).toEqual([expect.objectContaining({ title: `رُفضت مادتك #${m.id.slice(0, 8)}`, assignment_state: null })]);
    clean(mine);
    expect(await payloads(m.id, 'material.rejected')).toEqual([
      { material_id: m.id, priority: 'normal', office_id: expect.any(String), editorial_state: 'rejected', material_version: 1 },
    ]);
    for (const staff of [supervisor, colleague, otherSupervisor, producer]) expect(await notes(staff, m.id, 'material.rejected')).toEqual([]);
    // إعادة الإرسال لا تكرّر الإشعار
    await drainOutbox(h);
    expect(await notes(reporter, m.id, 'material.rejected')).toHaveLength(1);
  });

  it('a rejection straight from the inbox reaches the reporter too', async () => {
    const m = await createMaterial();
    await move(supervisor, m.id, 'rejected');
    await drainOutbox(h);
    expect(await notes(reporter, m.id, 'material.rejected')).toHaveLength(1);
  });

  it('an acceptance reaches the reporter once; production keeps its task, and a release back to accepted does not tell the reporter again', async () => {
    const m = await createMaterial();
    await move(supervisor, m.id, 'acknowledged');
    await move(supervisor, m.id, 'reviewing');
    await move(supervisor, m.id, 'accepted', 'good');
    await drainOutbox(h);
    const mine = await notes(reporter, m.id, 'material.accepted');
    expect(mine).toEqual([expect.objectContaining({ title: `قُبلت مادتك #${m.id.slice(0, 8)}`, assignment_state: null })]);
    clean(mine);
    expect(await payloads(m.id, 'material.accepted')).toEqual([
      { material_id: m.id, priority: 'normal', office_id: expect.any(String), editorial_state: 'accepted', material_version: 1 },
    ]);
    expect(await notes(producer, m.id, 'material.accepted_for_production')).toEqual([expect.objectContaining({ assignment_state: 'assigned' })]);
    expect(await notes(producer, m.id, 'material.accepted')).toEqual([]);
    // المنتج يحجز ثم يعيد المادة إلى «مقبولة»: ليس قبولًا جديدًا
    await post(producer, `/v1/materials/${m.id}/reservation`).expect(200);
    await move(producer, m.id, 'accepted', 'released');
    await drainOutbox(h);
    expect(await payloads(m.id, 'material.accepted')).toHaveLength(1);
    expect(await notes(reporter, m.id, 'material.accepted')).toHaveLength(1);
  });

  it("a resubmission after a change request reaches the supervisors of the material's office, not as a task", async () => {
    const m = await createMaterial();
    await move(supervisor, m.id, 'acknowledged');
    await move(supervisor, m.id, 'reviewing');
    // «قيد المراجعة» أول مرة ليست إعادة إرسال
    await drainOutbox(h);
    expect(await payloads(m.id, 'material.resubmitted')).toEqual([]);
    await move(supervisor, m.id, 'needs_changes');
    await move(reporter, m.id, 'reviewing', 'Reshot the first take');
    await drainOutbox(h);
    for (const staff of [supervisor, colleague]) {
      const mine = await notes(staff, m.id, 'material.resubmitted');
      expect(mine).toEqual([expect.objectContaining({ title: `أُعيد إرسال المادة #${m.id.slice(0, 8)} بعد التعديل`, assignment_state: null })]);
      clean(mine);
      expect(JSON.stringify(mine)).not.toContain('Reshot');
    }
    expect(await payloads(m.id, 'material.resubmitted')).toEqual([
      { material_id: m.id, priority: 'normal', office_id: expect.any(String), editorial_state: 'reviewing', material_version: 1 },
    ]);
    for (const other of [otherSupervisor, reporter, producer]) expect(await notes(other, m.id, 'material.resubmitted')).toEqual([]);
  });
});
