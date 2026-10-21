import { writeFileSync } from 'node:fs';
import request from 'supertest';
import { createHarness, drainOutbox, type Harness, loginAs, seedUploadSession, seedUser } from './harness';

// «الوارد الآن» (ADR 0024): تقدّم الرفع بحدث لكل عُشر من الحجم، ولقطة الجلسات الجارية في لوحة غرفة الأخبار ضمن النطاق
describe('inbox now: upload progress (post-receive, uploads_in_progress)', () => {
  let h: Harness;
  let reporterId: string;
  let office: string;
  let supervisor: { token: string };
  let otherSupervisor: { token: string };
  beforeAll(async () => {
    h = await createHarness({ env: { DASHBOARD_SNAPSHOT_MS: '0' } });
    reporterId = (await seedUser(h)).id;
    const newOffice = async () => (await h.pool.query<{ id: string }>(`INSERT INTO offices (name_ar, name_en) VALUES ('م', 'o') RETURNING id`)).rows[0]!.id;
    office = await newOffice();
    const otherOffice = await newOffice();
    supervisor = await loginAs(h, [{ role: 'supervisor', scopeKind: 'office', scopeId: office }]);
    otherSupervisor = await loginAs(h, [{ role: 'supervisor', scopeKind: 'office', scopeId: otherOffice }]);
  });
  afterAll(() => h.close());

  const hook = (body: object) => request(h.app.getHttpServer()).post(`/internal/tusd-hooks/${h.config.TUSD_HOOK_SECRET}`).send(body);
  const receive = (sessionId: string, offset: number, size = 1000, key = `tus/${sessionId}`) =>
    hook({
      Type: 'post-receive',
      Event: {
        Upload: { ID: `${sessionId}+multipart-id`, Size: size, Offset: offset, MetaData: { upload_session_id: sessionId }, Storage: { Type: 's3store', Bucket: 'uploads', Key: key } },
        HTTPRequest: { Method: 'PATCH', URI: `/files/${sessionId}`, Header: {} },
      },
    }).expect(200);
  const progress = async (id: string) =>
    (
      await h.pool.query<{ idempotency_key: string; payload: Record<string, unknown> }>(
        `SELECT idempotency_key, payload FROM outbox_events WHERE aggregate_id = $1 AND type = 'upload.progress' ORDER BY id`,
        [id],
      )
    ).rows;
  const inOffice = async (sessionId: string, opts: { priority?: string } = {}) => {
    await h.pool.query(
      `UPDATE materials SET office_id = $2, priority = $3 WHERE id = (SELECT material_id FROM upload_sessions WHERE id = $1)`,
      [sessionId, office, opts.priority ?? 'normal'],
    );
  };
  const dashboard = async (token: string) =>
    (await request(h.app.getHttpServer()).get('/v1/dashboard/newsroom').set('Authorization', `Bearer ${token}`).expect(200)).body;

  it('records bytes received and writes one upload.progress per new tenth, ids and numbers only', async () => {
    const s = await seedUploadSession(h, reporterId, { state: 'in_progress' });
    await inOffice(s.id, { priority: 'urgent' });
    await receive(s.id, 50);
    expect(await progress(s.id)).toEqual([]);
    await receive(s.id, 120);
    await receive(s.id, 150);
    await receive(s.id, 350);
    // tusd يعيد الخطّاف: بلا صف ثانٍ، والمستلم لا ينقص
    await receive(s.id, 350);
    await receive(s.id, 200);
    await receive(s.id, 1000);
    const rows = await progress(s.id);
    expect(rows.map((r) => r.idempotency_key)).toEqual([1, 3, 9].map((t) => `upload.progress:${s.id}:${t}`));
    expect(rows[1]!.payload).toEqual({
      material_id: s.materialId,
      upload_session_id: s.id,
      kind: 'original',
      priority: 'urgent',
      bytes_received: 350,
      size_bytes: 1000,
    });
    const { rows: [row] } = await h.pool.query(`SELECT state, bytes_received FROM upload_sessions WHERE id = $1`, [s.id]);
    expect(row).toEqual({ state: 'in_progress', bytes_received: '1000' });
  });

  it('ignores a storage key that is not the session one and a session past in_progress', async () => {
    const s = await seedUploadSession(h, reporterId, { state: 'in_progress' });
    await receive(s.id, 500, 1000, 'tus/someone-else');
    const done = await seedUploadSession(h, reporterId, { state: 'completed' });
    await receive(done.id, 500);
    const { rows } = await h.pool.query(`SELECT bytes_received FROM upload_sessions WHERE id = ANY($1::uuid[])`, [[s.id, done.id]]);
    expect(rows.map((r) => r.bytes_received)).toEqual(['0', '0']);
    expect([...(await progress(s.id)), ...(await progress(done.id))]).toEqual([]);
  });

  it('creates no notification for upload.progress', async () => {
    const s = await seedUploadSession(h, reporterId, { state: 'in_progress' });
    await inOffice(s.id, { priority: 'urgent' });
    await receive(s.id, 500);
    await drainOutbox(h);
    const { rows } = await h.pool.query(
      `SELECT count(*)::int AS n FROM notifications n JOIN outbox_events e ON e.id = n.event_id WHERE e.aggregate_id = $1`,
      [s.id],
    );
    expect(rows[0].n).toBe(0);
  });

  it('the dashboard lists in-flight sessions within scope only, urgent first, without filename or reporter', async () => {
    const normal = await seedUploadSession(h, reporterId, { state: 'in_progress' });
    await inOffice(normal.id);
    const urgent = await seedUploadSession(h, reporterId, { state: 'created', updatedSecondsAgo: 60 });
    await inOffice(urgent.id, { priority: 'urgent' });
    const expired = await seedUploadSession(h, reporterId, { state: 'in_progress', expiresInSeconds: -1 });
    await inOffice(expired.id);
    const finished = await seedUploadSession(h, reporterId, { state: 'completed' });
    await inOffice(finished.id);
    await receive(normal.id, 400);

    const body = await dashboard(supervisor.token);
    const ids = body.uploads_in_progress.map((u: { upload_session_id: string }) => u.upload_session_id);
    expect(ids).toEqual(expect.arrayContaining([normal.id, urgent.id]));
    expect(ids).not.toContain(expired.id);
    expect(ids).not.toContain(finished.id);
    expect(ids.indexOf(urgent.id)).toBeLessThan(ids.indexOf(normal.id));
    const entry = body.uploads_in_progress.find((u: { upload_session_id: string }) => u.upload_session_id === normal.id);
    expect(Object.keys(entry).sort()).toEqual(
      ['bytes_received', 'kind', 'material_id', 'priority', 'size_bytes', 'state', 'updated_at', 'upload_session_id'].sort(),
    );
    expect(entry).toMatchObject({ material_id: normal.materialId, kind: 'original', priority: 'normal', state: 'in_progress', size_bytes: 1000, bytes_received: 400 });
    expect(JSON.stringify(body.uploads_in_progress)).not.toContain('clip.mp4');
    expect(JSON.stringify(body.uploads_in_progress)).not.toContain(reporterId);

    const others = await dashboard(otherSupervisor.token);
    expect(others.uploads_in_progress).toEqual([]);
  });
  it('a large part that jumps across several tenths writes one row, keyed by the last tenth crossed', async () => {
    const s = await seedUploadSession(h, reporterId, { state: 'in_progress' });
    await receive(s.id, 50);
    await receive(s.id, 350);
    const rows = await progress(s.id);
    expect(rows.map((r) => r.idempotency_key)).toEqual([`upload.progress:${s.id}:3`]);
    expect(rows[0]!.payload).toMatchObject({ bytes_received: 350, size_bytes: 1000 });
  });

  // ADR 0024: مع #225 يصل post-receive كل ثانية لكل رفع، ويأخذ قفل صف الجلسة. القياس: زمن الخطّاف تحت رفوع متزامنة،
  // كل رفع يرسل خطّافاته متتابعة كما يفعل tusd، والرفوع بالتوازي. INBOX_NOW_MEASURE_FILE يكتب النتيجة بمخطط القياس.
  it('post-receive under concurrent uploads: every hook succeeds, one row per tenth per session, latency recorded', async () => {
    const uploads = Number(process.env.INBOX_NOW_CONCURRENT_UPLOADS ?? 40);
    const hooksPerUpload = 20;
    const sessions = await Promise.all(Array.from({ length: uploads }, () => seedUploadSession(h, reporterId, { state: 'in_progress' })));
    const started = new Date();
    const samples: number[] = [];
    await Promise.all(
      sessions.map(async (s) => {
        for (let i = 1; i <= hooksPerUpload; i++) {
          const t0 = performance.now();
          await receive(s.id, Math.round((1000 * i) / hooksPerUpload));
          samples.push(performance.now() - t0);
        }
      }),
    );
    const ended = new Date();
    const { rows } = await h.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM outbox_events WHERE type = 'upload.progress' AND aggregate_id = ANY($1::uuid[]) GROUP BY aggregate_id`,
      [sessions.map((s) => s.id)],
    );
    expect(rows).toHaveLength(uploads);
    expect(rows.every((r) => r.n === 9)).toBe(true);

    samples.sort((a, b) => a - b);
    const pct = (p: number) => Math.round(samples[Math.min(samples.length - 1, Math.ceil((p / 100) * samples.length) - 1)]!);
    const metrics = {
      concurrent_uploads: uploads,
      hooks_per_upload: hooksPerUpload,
      hooks_total: samples.length,
      progress_rows_per_upload: 9,
      hook_ms_p50: pct(50),
      hook_ms_p95: pct(95),
      hook_ms_p99: pct(99),
      hook_ms_max: Math.round(samples[samples.length - 1]!),
    };
    // حد حماية واسع لبيئة CI المشتركة، لا هدف أداء: الهدف يُقرأ من ملف القياس
    expect(metrics.hook_ms_p95).toBeLessThan(2000);
    const out = process.env.INBOX_NOW_MEASURE_FILE;
    if (out) {
      writeFileSync(
        out,
        `${JSON.stringify(
          {
            schema_version: 1,
            tool: 'other',
            role: 'وكيل الخادم',
            test_name: 'inbox-now-post-receive-concurrency',
            started_at: started.toISOString(),
            ended_at: ended.toISOString(),
            result: 'info',
            device: { platform: 'server' },
            upload_path: 'n/a',
            metrics,
            notes:
              'خطّاف post-receive عبر HTTP إلى الخادم وPostgres على المضيف نفسه (حاوية تطوير سحابية مشتركة). كل رفع يرسل خطّافاته متتابعة كما يفعل tusd، والرفوع بالتوازي. الزمن من إرسال الطلب إلى الرد، ويشمل قفل صف الجلسة وكتابة حدث العُشر.',
          },
          null,
          2,
        )}\n`,
      );
    }
  }, 120_000);
});
