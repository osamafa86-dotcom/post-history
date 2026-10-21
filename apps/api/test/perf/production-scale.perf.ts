import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { OutboxDispatcher } from '../../src/outbox/outbox.dispatcher';
import { createHarness, type Harness, loginAs } from '../integration/harness';
import { seedYear, yearVolumes } from './seed';

/**
 * اختبار الأداء على بيانات بحجم سنة من الخطة (البند 18، ADR 0002): يبذر قاعدة مخصصة فارغة مُرحَّلة (PERF_DATABASE_URL)، ثم
 * يقيس p95 لكل سيناريو بطلبات HTTP حقيقية على الخادم نفسه وتوازٍ ثابت، ويكتب النتيجة بمخطط القياس في
 * docs/measurements/api/. الحد 2 ثانية للقراءة (البند 18). يُشغَّل يدويًا: npm run perf:production-scale.
 *   PERF_SCALE=1 (سنة كاملة)  PERF_CONCURRENCY=10  PERF_REQUESTS=200  PERF_OUT=<مسار الملف>
 */
const SCALE = Number(process.env.PERF_SCALE ?? 1);
const C = Number(process.env.PERF_CONCURRENCY ?? 10);
const R = Number(process.env.PERF_REQUESTS ?? 200);
const READ_P95_LIMIT_MS = 2000;
// هدف زمن الطلب الواحد (قرار المنسّق 2026-10-21): يُسجَّل ما يتجاوزه بالاسم، والحد الملزم يبقى 2 ث (البند 18)
const P95_TARGET_MS = Number(process.env.PERF_P95_TARGET_MS ?? 300);
const REPO = resolve(__dirname, '../../../..');

jest.setTimeout(60 * 60 * 1000);

type Actor = Awaited<ReturnType<typeof loginAs>>;

describe('performance at production scale', () => {
  let h: Harness;
  let base: string;
  let formVersion: number;
  const overTarget: string[] = [];
  const started = new Date();
  const metrics: Record<string, number | string | boolean> = {};
  const failures: string[] = [];

  beforeAll(async () => {
    h = await createHarness({ env: { DATABASE_POOL_MAX: '20' } });
    // قاعدة مُرحَّلة فارغة (سجل التدقيق لا يُفرَّغ): تُنشأ من جديد قبل كل تشغيل
    if (Number((await h.pool.query(`SELECT count(*) AS n FROM materials`)).rows[0].n) > 0) {
      throw new Error('PERF_DATABASE_URL must be a freshly migrated, empty database (drop and recreate it before each run)');
    }
    const form = readFileSync(resolve(REPO, 'contracts/examples/upload-form/valid/02-full-form-v0.json'), 'utf8');
    formVersion = (JSON.parse(form) as { version: number }).version;
    await h.pool.query(`INSERT INTO upload_forms (version, schema) VALUES ($1, $2)`, [formVersion, form]);
    const v = yearVolumes(SCALE);
    const t0 = performance.now();
    await seedYear(h.pool, v, formVersion);
    metrics.seed_s = Math.round((performance.now() - t0) / 1000);
    const count = async (table: string) => Number((await h.pool.query(`SELECT count(*) AS n FROM ${table}`)).rows[0].n);
    for (const t of ['materials', 'material_files', 'notifications', 'outbox_events', 'users']) metrics[`rows_${t}`] = await count(t);
    await h.app.listen(0);
    base = `http://127.0.0.1:${(h.app.getHttpServer().address() as AddressInfo).port}/v1`;
  });

  afterAll(async () => {
    // بذرة أو تشغيل لم يكتمل لا يكتب نتيجة: ما لا يُقاس لا يُدّعى
    if (!base) {
      await h?.close();
      return;
    }
    const doc = {
      schema_version: 1,
      tool: 'other',
      role: 'وكيل الخادم',
      // ما قيس فعلًا: زمن الواجهة بحجم الإنتاج؛ لا يدّعي اختبار القبول «performance» كله (البحث النصي ومعاينة 1080p)
      test_name: 'api-latency-production-scale',
      decision_ref: 18,
      started_at: started.toISOString(),
      ended_at: new Date().toISOString(),
      result: failures.length ? 'fail' : 'pass',
      device: { platform: 'server' },
      upload_path: 'n/a',
      metrics: { scale: SCALE, concurrency: C, requests_per_scenario: R, read_p95_limit_ms: READ_P95_LIMIT_MS, p95_target_ms: P95_TARGET_MS, over_target: overTarget.length, failures: failures.length, ...metrics },
      notes:
        `خادم الواجهة وPostgres على المضيف نفسه (${process.env.PERF_ENV_LABEL ?? 'محليًا'})، بذرة اصطناعية بحجم سنة من الخطة مضروبة في ${SCALE} ` +
        'بلا بيانات كاشفة. القراءة عبر HTTP بتوازٍ ثابت. البحث بالحقل الديناميكي يُقاس استعلامًا في القاعدة لأن العقد لا يعرّف نقطته بعد. ' +
        'تسليم الإشعار: من طلب الإنشاء إلى صف الإشعار عبر دفعة مُرسل واحدة (بلا مهلة الاستطلاع OUTBOX_POLL_INTERVAL_MS). ' +
        'التصفح بالمؤشر: كل صفحة عيّنة مستقلة. ' +
        (overTarget.length ? `فوق هدف ${P95_TARGET_MS} ms: ${overTarget.join('، ')}.` : `كل السيناريوهات ضمن هدف ${P95_TARGET_MS} ms.`) +
        (failures.length ? ` إخفاقات: ${failures.join('؛ ')}` : ''),
    };
    const ajv = new Ajv2020({ strict: false });
    addFormats(ajv);
    const valid = ajv.compile(JSON.parse(readFileSync(resolve(REPO, 'contracts/schemas/measurement.json'), 'utf8')));
    if (!valid(doc)) throw new Error(`measurement does not match the schema: ${JSON.stringify(valid.errors)}`);
    const out = process.env.PERF_OUT ?? resolve(REPO, `docs/measurements/api/${started.toISOString().slice(0, 10)}-production-scale.json`);
    mkdirSync(resolve(out, '..'), { recursive: true });
    writeFileSync(out, `${JSON.stringify(doc, null, 2)}\n`);
    await h?.close();
  });

  /** سيناريو يرمي = إخفاق في النتيجة المكتوبة أيضًا. */
  const scenario = (title: string, fn: () => Promise<void>) =>
    it(title, async () => {
      try {
        await fn();
      } catch (err) {
        failures.push(`${title}: ${(err as Error).message}`);
        throw err;
      }
    });

  const call = (a: Actor, method: string, path: string, body?: object) =>
    fetch(`${base}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${a.token}`,
        ...(body ? { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });

  /**
   * R عملية بتوازٍ C، ويسجّل p50/p95/p99 بالمللي ثانية، والفشل إن تجاوز p95 الحد أو رد غير المتوقع. العملية التي تعيد
   * أزمنة طلباتها (تصفح بالمؤشر) يُحسب كل طلب HTTP فيها عيّنة مستقلة: الحد زمن طلب واحد لا زمن السلسلة.
   */
  const measure = async (name: string, op: () => Promise<number | { status: number; times: number[] }>, expected: number, limitMs = READ_P95_LIMIT_MS) => {
    const times: number[] = [];
    let errors = 0;
    let next = 0;
    const worker = async () => {
      while (next < R) {
        next++;
        const t0 = performance.now();
        const out = await op();
        if (typeof out === 'number') times.push(performance.now() - t0);
        else times.push(...out.times);
        if ((typeof out === 'number' ? out : out.status) !== expected) errors++;
      }
    };
    await Promise.all(Array.from({ length: C }, worker));
    times.sort((a, b) => a - b);
    const pct = (p: number) => Math.round(times[Math.min(times.length - 1, Math.ceil((p / 100) * times.length) - 1)]!);
    metrics[`${name}_ms_p50`] = pct(50);
    metrics[`${name}_ms_p95`] = pct(95);
    metrics[`${name}_ms_p99`] = pct(99);
    if (errors) failures.push(`${name}: ${errors} unexpected responses`);
    if (pct(95) > limitMs) failures.push(`${name} p95 ${pct(95)} ms > ${limitMs}`);
    if (pct(95) > P95_TARGET_MS) overTarget.push(`${name} ${pct(95)}`);
  };

  const officeOfFirstSupervisor = async () =>
    (await h.pool.query<{ scope_id: string }>(`SELECT scope_id FROM user_roles WHERE role = 'supervisor' AND scope_kind = 'office' ORDER BY user_id LIMIT 1`)).rows[0]!.scope_id;

  scenario('inbox list: explicit filters and each sort through cursor pages', async () => {
    const office = await officeOfFirstSupervisor();
    const supervisor = await loginAs(h, [{ role: 'supervisor', scopeKind: 'office', scopeId: office }]);
    const chief = await loginAs(h, [{ role: 'editor_in_chief' }]);
    // ثلاث صفحات متتالية بالمؤشر في كل عملية: الوارد كما يفتحه المشرف ورئيس التحرير، وكل صفحة عيّنة
    const pages = (a: Actor, query: string) => async () => {
      let cursor: string | null = null;
      const times: number[] = [];
      for (let i = 0; i < 3; i++) {
        const t0 = performance.now();
        const res = await call(a, 'GET', `/materials?${query}&limit=50${cursor ? `&cursor=${cursor}` : ''}`);
        const body = res.status === 200 ? ((await res.json()) as { next_cursor: string | null }) : null;
        times.push(performance.now() - t0);
        if (!body) return { status: res.status, times };
        cursor = body.next_cursor;
        if (!cursor) break;
      }
      return { status: 200, times };
    };
    await measure('inbox_supervisor_created_desc', pages(supervisor, 'editorial_state=inbox&sort=created_desc'), 200);
    await measure('inbox_supervisor_urgent', pages(supervisor, 'priority=urgent&sort=created_desc'), 200);
    await measure('list_chief_shot_desc_governorate', pages(chief, 'governorate=gaza&sort=shot_desc'), 200);
    await measure('list_chief_updated_desc_rights', pages(chief, 'rights_state=sellable&editorial_state=published&sort=updated_desc'), 200);
    await measure('list_chief_created_asc', pages(chief, 'sort=created_asc'), 200);
  });

  scenario('newsroom dashboard', async () => {
    const office = await officeOfFirstSupervisor();
    const supervisor = await loginAs(h, [{ role: 'supervisor', scopeKind: 'office', scopeId: office }]);
    const chief = await loginAs(h, [{ role: 'editor_in_chief' }]);
    await measure('dashboard_supervisor', async () => (await call(supervisor, 'GET', '/dashboard/newsroom')).status, 200);
    await measure('dashboard_chief', async () => (await call(chief, 'GET', '/dashboard/newsroom')).status, 200);
  });

  scenario('search by the dynamic field marked searchable (the query an endpoint would run)', async () => {
    const office = await officeOfFirstSupervisor();
    // الحقل footage_source موسوم searchable في النموذج؛ القيمة النادرة (3%) ضمن نطاق مشرف، ثم على كل المواد
    const scoped = () =>
      h.pool.query(
        `SELECT id FROM materials WHERE office_id = $1 AND dynamic_fields ->> 'footage_source' = 'handout'
          ORDER BY created_at DESC, id DESC LIMIT 50`,
        [office],
      );
    const all = () =>
      h.pool.query(`SELECT id FROM materials WHERE dynamic_fields ->> 'footage_source' = 'handout' ORDER BY created_at DESC, id DESC LIMIT 50`);
    const plan = await h.pool.query(
      `EXPLAIN (FORMAT JSON) SELECT id FROM materials WHERE dynamic_fields ->> 'footage_source' = 'handout' ORDER BY created_at DESC, id DESC LIMIT 50`,
    );
    metrics.dynamic_search_plan_root = String(plan.rows[0]['QUERY PLAN'][0].Plan['Node Type']);
    await measure('dynamic_search_scoped', async () => ((await scoped()).rowCount === null ? 500 : 200), 200);
    await measure('dynamic_search_all', async () => ((await all()).rowCount === null ? 500 : 200), 200);
  });

  scenario('creating a material writes its Outbox event in the same transaction', async () => {
    const office = await officeOfFirstSupervisor();
    const reporter = await loginAs(h, [{ role: 'reporter' }], { officeId: office });
    const body = () => ({
      title: 'perf material',
      material_types: ['report'],
      governorate: 'gaza',
      city: 'gaza',
      priority: 'normal',
      sensitivity: { minors: false, injured: false, graphic: false },
      display_name: { mode: 'network' },
      form_version: formVersion,
      dynamic_fields: { footage_source: 'own' },
    });
    const probe = await call(reporter, 'POST', '/materials', body());
    if (probe.status !== 201) throw new Error(`create_material probe: ${probe.status} ${await probe.text()}`);
    const before = Number((await h.pool.query(`SELECT count(*) AS n FROM outbox_events WHERE published_at IS NULL`)).rows[0].n);
    await measure('create_material', async () => (await call(reporter, 'POST', '/materials', body())).status, 201);
    const pending = Number((await h.pool.query(`SELECT count(*) AS n FROM outbox_events WHERE published_at IS NULL`)).rows[0].n);
    metrics.create_material_outbox_events = pending - before;
    if (pending - before < R) failures.push(`create_material: ${pending - before} Outbox events for ${R} materials`);
    await h.app.get(OutboxDispatcher).dispatchBatch(10_000);
  });

  scenario('delivering a notification through one admin rule', async () => {
    const office = await officeOfFirstSupervisor();
    const admin = await loginAs(h, [{ role: 'system_admin' }]);
    const reporter = await loginAs(h, [{ role: 'reporter' }], { officeId: office });
    const rule = await call(admin, 'POST', '/notification-rules', {
      name: 'perf',
      event_type: 'material.created',
      scope_kind: 'office',
      scope_id: office,
      recipient_roles: ['supervisor'],
      channels: ['in_app'],
      assignment: true,
    });
    if (rule.status !== 201) throw new Error(`rule: ${rule.status}`);
    const dispatcher = h.app.get(OutboxDispatcher);
    const times: number[] = [];
    // تسلسلي: لكل مادة زمن الإنشاء ثم دفعة مُرسل حتى يظهر إشعار القاعدة
    for (let i = 0; i < Math.min(R, 100); i++) {
      const t0 = performance.now();
      const res = await call(reporter, 'POST', '/materials', {
        title: 'perf material',
        material_types: ['report'],
        governorate: 'gaza',
        city: 'gaza',
        priority: 'urgent',
        sensitivity: { minors: false, injured: false, graphic: false },
        display_name: { mode: 'network' },
        form_version: formVersion,
        dynamic_fields: { footage_source: 'own' },
      });
      if (res.status !== 201) throw new Error(`rule_delivery create: ${res.status}`);
      const id = ((await res.json()) as { id: string }).id;
      for (let tries = 0; tries < 50; tries++) {
        await dispatcher.dispatchBatch();
        const { rows } = await h.pool.query(`SELECT 1 FROM notifications WHERE material_id = $1 AND rule_id IS NOT NULL LIMIT 1`, [id]);
        if (rows.length) break;
        if (tries === 49) throw new Error('rule_delivery: no notification after 50 dispatcher batches');
      }
      times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    const pct = (p: number) => Math.round(times[Math.min(times.length - 1, Math.ceil((p / 100) * times.length) - 1)]!);
    metrics.rule_delivery_ms_p50 = pct(50);
    metrics.rule_delivery_ms_p95 = pct(95);
    metrics.rule_delivery_ms_p99 = pct(99);
    // الحد: «خلال زمن مقيس (≤ 10 ثوانٍ)» في قبول إشعار الاستلام
    if (pct(95) > 10_000) failures.push(`rule_delivery p95 ${pct(95)} ms > 10000`);
  });
});
