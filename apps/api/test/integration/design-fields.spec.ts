import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createHarness, ensureForm, drainOutbox, loginAs, type Harness } from './harness';

type Actor = Awaited<ReturnType<typeof loginAs>>;
describe('ADR 0035: أسماء الطاقم وقراءة الكل ومواعيد الإقرار', () => {
  let h: Harness; let admin: Actor; let reporter: Actor; let supervisor: Actor; let outside: Actor;
  beforeAll(async () => {
    h = await createHarness({ env: { DASHBOARD_SNAPSHOT_MS: '0', OUTBOX_DISPATCHER_ENABLED: 'false' } });
    await ensureForm(h);
    const office = async () => (await h.pool.query(`INSERT INTO offices (name_ar,name_en,governorate) VALUES ('مكتب اصطناعي','Synthetic','gaza') RETURNING id`)).rows[0].id as string;
    const a = await office(); const b = await office();
    admin = await loginAs(h,[{role:'system_admin'}]);
    reporter = await loginAs(h,[{role:'reporter'}],{officeId:a});
    supervisor = await loginAs(h,[{role:'supervisor',scopeKind:'office',scopeId:a}]);
    outside = await loginAs(h,[{role:'supervisor',scopeKind:'office',scopeId:b}]);
  });
  afterAll(() => h.close());
  const http = () => request(h.app.getHttpServer());
  const get = (a: Actor,path: string) => http().get(`/v1${path}`).auth(a.token,{type:'bearer'});
  const name = (a: Actor,id: string,value: unknown,key = randomUUID()) => http().put(`/v1/users/${id}/work-name`).auth(a.token,{type:'bearer'}).set('Idempotency-Key',key).send({work_name:value});
  const material = async () => (await http().post('/v1/materials').auth(reporter.token,{type:'bearer'}).set('Idempotency-Key',randomUUID()).send({
    title:'مادة اصطناعية', material_types:['report'], governorate:'gaza',city:'مدينة اصطناعية', priority:'normal',
    sensitivity:{minors:false,injured:false,graphic:false},display_name:{mode:'network'},form_version:1,dynamic_fields:{},
  }).expect(201)).body.id as string;

  it('admin sets and clears names idempotently, audits codes only, rejects reporter and malformed input', async () => {
    const value = 'اسم عمل اصطناعي'; const key = randomUUID();
    await name(admin,supervisor.id,value,key).expect(204);
    await name(admin,supervisor.id,value,key).expect(204);
    await name(admin,supervisor.id,value).expect(204);
    expect((await get(supervisor,'/auth/me').expect(200)).body.work_name).toBe(value);
    const { rows } = await h.pool.query(`SELECT details FROM audit_log WHERE target_id = $1 AND action = 'user.work_name_changed'`,[supervisor.id]);
    expect(rows).toEqual([{details:{target_user_id:supervisor.id,reason_code:'work_name_set'}}]);
    await name(supervisor,supervisor.id,value).expect(403);
    await name(admin,reporter.id,value).expect(422);
    for (const invalid of [' leading','trailing ','line\nbreak','bad\u202ename','x'.repeat(81)]) await name(admin,supervisor.id,invalid).expect(422);
    await name(admin,supervisor.id,null).expect(204);
    expect((await get(supervisor,'/auth/me').expect(200)).body.work_name).toBeNull();
  });

  it('reservation and actor names are staff-only; reporter actors and stale reservations give null', async () => {
    const id = await material(); await name(admin,supervisor.id,'محرر اصطناعي').expect(204);
    await h.pool.query(`UPDATE materials SET reserved_by=$2,reserved_at=now() WHERE id=$1`,[id,supervisor.id]);
    await h.pool.query(`INSERT INTO material_transitions (material_id,track,from_state,to_state,reason,actor_id) VALUES ($1,'editorial','inbox','acknowledged','synthetic',$2),($1,'editorial','acknowledged','needs_changes','synthetic',$3)`,[id,supervisor.id,reporter.id]);
    expect((await get(supervisor,`/materials/${id}`).expect(200)).body.reserved_by_name).toBe('محرر اصطناعي');
    expect((await get(reporter,`/materials/${id}`).expect(200)).body.reserved_by_name).toBeNull();
    await get(outside,`/materials/${id}`).expect(404);
    const transitions = (await get(supervisor,`/materials/${id}/transitions`).expect(200)).body.items;
    expect(transitions.map((t: {actor_name:unknown})=>t.actor_name)).toEqual(['محرر اصطناعي',null]);
    await h.pool.query(`UPDATE materials SET reserved_at=now()-interval '2 days' WHERE id=$1`,[id]);
    expect((await get(supervisor,`/materials/${id}`).expect(200)).body.reserved_by_name).toBeNull();
  });

  it('read-all replays the original count and leaves assignments, deadlines, future and other users unread', async () => {
    const id = await material(); await drainOutbox(h);
    const due = '2026-01-01T00:00:00.000Z';
    await h.pool.query(`UPDATE notifications SET created_at='2026-01-01',escalate_at=$2 WHERE material_id=$1 AND user_id=$3`,[id,due,supervisor.id]);
    await h.pool.query(`INSERT INTO notifications (user_id,event_id,type,material_id,title,priority) SELECT $2,event_id,type,material_id,'إشعار اصطناعي','normal' FROM notifications WHERE material_id=$1 AND user_id=$3 LIMIT 1`,[id,outside.id,supervisor.id]);
    const key = randomUUID(); const before = '2026-01-02T00:00:00Z';
    const read = () => http().post('/v1/notifications/read-all').auth(supervisor.token,{type:'bearer'}).set('Idempotency-Key',key).send({before});
    const first = (await read().expect(200)).body; expect(first.read_count).toBeGreaterThan(0);
    expect((await read().expect(200)).body).toEqual(first);
    const { rows: [n] } = await h.pool.query(`SELECT assignment_state,acknowledged_at,escalate_at,read_at FROM notifications WHERE material_id=$1 AND user_id=$2`,[id,supervisor.id]);
    const other = (await h.pool.query(`SELECT read_at FROM notifications WHERE material_id=$1 AND user_id=$2`,[id,outside.id])).rows;
    expect(other).toHaveLength(1);expect(other[0].read_at).toBeNull();
    expect(n.assignment_state).toBe('assigned');expect(n.acknowledged_at).toBeNull();expect(n.read_at).not.toBeNull();
    expect(new Date(n.escalate_at).toISOString()).toBe(due);
    expect((await get(supervisor,`/materials/${id}`).expect(200)).body.acknowledgement_due_at).toBe(due);
    expect((await get(supervisor,'/dashboard/newsroom').expect(200)).body.oldest_overdue_acknowledgement_at).toBe(due);
    expect((await get(outside,'/dashboard/newsroom').expect(200)).body.oldest_overdue_acknowledgement_at).toBeNull();
    const newer = await material();await drainOutbox(h);
    expect((await read().expect(200)).body).toEqual(first);
    expect((await h.pool.query(`SELECT read_at FROM notifications WHERE material_id=$1 AND user_id=$2`,[newer,supervisor.id])).rows.every(r=>r.read_at===null)).toBe(true);
    const reporterInbox = (await get(reporter,'/notifications').expect(200)).body;
    expect(JSON.stringify(reporterInbox)).not.toContain('محرر اصطناعي');
  });
});
