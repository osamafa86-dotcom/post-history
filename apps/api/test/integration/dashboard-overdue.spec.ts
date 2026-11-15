import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { EscalationWorker } from '../../src/notifications/escalation.worker';
import { createHarness, drainOutbox, ensureForm, type Harness, loginAs } from './harness';

type Actor = Awaited<ReturnType<typeof loginAs>>;

// «متأخر عن الإقرار» في لوحة غرفة الأخبار: عدد المواد التي تنتظر، لا عدد صفوف تنبيهها عند كل من صُعِّدت إليه.
describe('newsroom dashboard: materials overdue for acknowledgement', () => {
  let h: Harness;
  let worker: EscalationWorker;
  let reporter: Actor;
  let supervisor: Actor;
  let outside: Actor;

  beforeAll(async () => {
    h = await createHarness({ env: { DASHBOARD_SNAPSHOT_MS: '0', ESCALATION_URGENT_SECONDS: '600', ESCALATION_IMPORTANT_SECONDS: '3600' } });
    worker = h.app.get(EscalationWorker);
    await ensureForm(h);
    const newOffice = async () => (await h.pool.query<{ id: string }>(`INSERT INTO offices (name_ar, name_en) VALUES ('م', 'o') RETURNING id`)).rows[0]!.id;
    const office = await newOffice();
    reporter = await loginAs(h, [{ role: 'reporter' }], { officeId: office });
    supervisor = await loginAs(h, [{ role: 'supervisor', scopeKind: 'office', scopeId: office }]);
    outside = await loginAs(h, [{ role: 'supervisor', scopeKind: 'office', scopeId: await newOffice() }]);
    // سلّم التصعيد: رئيس تحرير ثم مديرا نظام، فللمادة الواحدة بعد اكتماله أربعة صفوف تنبيه مفتوحة على الأقل (القاعدة مشتركة بين الملفات)
    await loginAs(h, [{ role: 'editor_in_chief' }]);
    await loginAs(h, [{ role: 'system_admin' }]);
    await loginAs(h, [{ role: 'system_admin' }]);
  });
  afterAll(() => h.close());

  const http = () => request(h.app.getHttpServer());
  const dashboard = async (a: Actor) => (await http().get('/v1/dashboard/newsroom').set('Authorization', `Bearer ${a.token}`).expect(200)).body;
  const material = async (priority: string) => {
    const res = await http().post('/v1/materials').set('Authorization', `Bearer ${reporter.token}`).set('Idempotency-Key', randomUUID())
      .send({ title: 'Overdue footage title', material_types: ['breaking'], governorate: 'gaza', city: 'gaza', priority, sensitivity: { minors: false, injured: false, graphic: false }, display_name: { mode: 'network' }, form_version: 1, dynamic_fields: {} })
      .expect(201);
    await drainOutbox(h);
    return res.body.id as string;
  };
  /** يجعل مهمة المشرف على المادة قد أُسندت قبل `minutes` دقيقة، وموعدها الأول بمهلة أولويتها كما يضعه التوزيع. */
  const age = async (id: string, minutes: number, delaySeconds: number) => {
    const { rows } = await h.pool.query<{ due: Date }>(
      `UPDATE notifications SET created_at = now() - make_interval(mins => $2), escalate_at = now() - make_interval(mins => $2) + make_interval(secs => $3)
        WHERE material_id = $1 AND user_id = $4 RETURNING escalate_at AS due`, [id, minutes, delaySeconds, supervisor.id]);
    return rows[0]!.due.toISOString();
  };
  const escalate = async (id: string) => {
    await h.pool.query(`UPDATE notifications SET escalate_at = now() - interval '1 second' WHERE material_id = $1 AND user_id = $2 AND escalate_at IS NOT NULL`, [id, supervisor.id]);
    await worker.escalateDue(); await drainOutbox(h);
  };
  const open = async (id: string) => (await h.pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM notifications WHERE material_id = $1 AND assignment_state = 'assigned' AND acknowledged_at IS NULL`, [id])).rows[0]!.n;

  it('counts each waiting material once however many people its task was escalated to, and keeps its first deadline as the oldest', async () => {
    const first = await material('urgent');
    expect(await dashboard(supervisor)).toMatchObject({ overdue_acknowledgements: 0, oldest_overdue_acknowledgement_at: null });

    // حان الموعد ولم يُصعَّد بعد: مادة واحدة، والأقدم موعدها
    const due = await age(first, 15, 600);
    expect(await dashboard(supervisor)).toMatchObject({ overdue_acknowledgements: 1, oldest_overdue_acknowledgement_at: due });

    // صُعِّدت إلى رئيس التحرير ثم إلى مديرَي النظام: أربعة صفوف مفتوحة فأكثر لمادة واحدة، والعدّاد واحد، والأقدم موعدها الأول لا يضيع
    await escalate(first); await escalate(first);
    expect(await open(first)).toBeGreaterThanOrEqual(4);
    expect(await dashboard(supervisor)).toMatchObject({ overdue_acknowledgements: 1, oldest_overdue_acknowledgement_at: due });

    // مادة مهمة أقدم منها: مادتان، والأقدم موعد الأقدم (بمهلة أولويتها)
    const second = await material('important');
    const older = await age(second, 90, 3600);
    await escalate(second);
    expect(await dashboard(supervisor)).toMatchObject({ overdue_acknowledgements: 2, oldest_overdue_acknowledgement_at: older });

    // مادة لم يحن موعدها لا تُعدّ، ومشرف مكتب آخر لا يرى شيئًا
    await material('urgent');
    expect((await dashboard(supervisor)).overdue_acknowledgements).toBe(2);
    expect(await dashboard(outside)).toMatchObject({ overdue_acknowledgements: 0, oldest_overdue_acknowledgement_at: null });

    // استلام المادة يُسقطها من العدّاد مع كل صفوفها
    const current = await http().get(`/v1/materials/${second}`).set('Authorization', `Bearer ${supervisor.token}`).expect(200);
    await http().post(`/v1/materials/${second}/transitions`).set('Authorization', `Bearer ${supervisor.token}`).set('Idempotency-Key', randomUUID()).set('If-Match', current.headers.etag)
      .send({ track: 'editorial', to: 'acknowledged', reason: 'seen by the desk' }).expect(200);
    await drainOutbox(h);
    expect(await dashboard(supervisor)).toMatchObject({ overdue_acknowledgements: 1, oldest_overdue_acknowledgement_at: due });
  });
});
