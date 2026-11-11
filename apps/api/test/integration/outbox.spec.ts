import { randomUUID } from 'node:crypto';
import { DB, type Database } from '../../src/database/database.module';
import { OUTBOX_PUBLISHER, OutboxDispatcher, type OutboxPublisher, type OutboxRow } from '../../src/outbox/outbox.dispatcher';
import { writeOutboxEvent } from '../../src/outbox/outbox';
import pino from 'pino';
import { createHarness, type Harness } from './harness';

describe('outbox', () => {
  let h: Harness;
  let db: Database;
  let dispatcher: OutboxDispatcher;
  let publisher: OutboxPublisher;

  beforeAll(async () => {
    h = await createHarness();
    db = h.app.get(DB);
    dispatcher = h.app.get(OutboxDispatcher);
    publisher = h.app.get(OUTBOX_PUBLISHER);
  });
  afterAll(() => h.close());
  afterEach(() => jest.restoreAllMocks());

  const event = (aggregateId = randomUUID()) => ({
    type: 'form.published' as const,
    aggregateType: 'form' as const,
    aggregateId,
    idempotencyKey: `form.published:${aggregateId}`,
    payload: { version: 1 },
  });

  const row = async (key: string) =>
    (await h.pool.query(`SELECT * FROM outbox_events WHERE idempotency_key = $1`, [key])).rows[0];

  // يعزل الاختبار عن أحداث الملفات الأخرى: كل ما سبق يُعلَّم منشورًا
  beforeEach(() => h.pool.query(`UPDATE outbox_events SET published_at = now() WHERE published_at IS NULL`));

  it('writes inside the caller transaction: a rollback leaves no event', async () => {
    const e = event();
    await expect(
      db.transaction(async (tx) => {
        await writeOutboxEvent(tx, e);
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    expect(await row(e.idempotencyKey)).toBeUndefined();
  });

  it('is idempotent on idempotency_key', async () => {
    const e = event();
    const first = await db.transaction((tx) => writeOutboxEvent(tx, e));
    const second = await db.transaction((tx) => writeOutboxEvent(tx, e));
    expect([first, second]).toEqual([true, false]);
  });

  it('rejects payload keys outside the whitelist (DB constraint, SEC-03)', async () => {
    const e = { ...event(), payload: { version: 1, gps: '31.5,34.4' } };
    await expect(db.transaction((tx) => writeOutboxEvent(tx, e))).rejects.toThrow();
  });

  it('dispatches pending events once and marks them published', async () => {
    const e = event();
    await db.transaction((tx) => writeOutboxEvent(tx, e));
    const seen: string[] = [];
    jest.spyOn(publisher, 'publish').mockImplementation(async (ev: OutboxRow) => {
      seen.push(ev.idempotencyKey);
    });
    expect(await dispatcher.dispatchBatch()).toBe(1);
    expect(await dispatcher.dispatchBatch()).toBe(0);
    expect(seen).toEqual([e.idempotencyKey]);
    expect((await row(e.idempotencyKey)).published_at).not.toBeNull();
  });

  it('concurrent dispatchers skip locked rows instead of double-publishing', async () => {
    const events = Array.from({ length: 6 }, () => event());
    for (const e of events) await db.transaction((tx) => writeOutboxEvent(tx, e));
    const seen: string[] = [];
    jest.spyOn(publisher, 'publish').mockImplementation(async (ev: OutboxRow) => {
      seen.push(ev.idempotencyKey);
      await new Promise((r) => setTimeout(r, 20));
    });
    const counts = await Promise.all([dispatcher.dispatchBatch(3), dispatcher.dispatchBatch(3), dispatcher.dispatchBatch(3)]);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(6);
    expect(new Set(seen).size).toBe(6);
    expect(seen).toHaveLength(6);
  });

  it('records failures with backoff and retries later', async () => {
    const e = event();
    await db.transaction((tx) => writeOutboxEvent(tx, e));
    jest.spyOn(publisher, 'publish').mockRejectedValue(new TypeError('secret detail 31.5,34.4'));
    expect(await dispatcher.dispatchBatch()).toBe(0);
    const failed = await row(e.idempotencyKey);
    expect(failed.attempts).toBe(1);
    expect(failed.last_error).toBe('TypeError');
    expect(failed.published_at).toBeNull();
    expect(new Date(failed.next_attempt_at).getTime()).toBeGreaterThan(Date.now());
  });
});

// ADR 0005 (تعديل 2026-11-11، مُرسل Outbox): الدفعة الممتلئة تتبعها التالية بلا انتظار، والحدث الذي يفشل نشره دائمًا يُعزل بحدّ محاولات
describe('outbox dispatcher: backlog and poison events', () => {
  const lines: string[] = [];
  let h: Harness;
  let db: Database;
  let dispatcher: OutboxDispatcher;
  let publisher: OutboxPublisher;

  beforeAll(async () => {
    const logger = pino({ level: 'warn' }, { write: (line: string) => void lines.push(line) });
    h = await createHarness({ logger, env: { OUTBOX_MAX_ATTEMPTS: '3' } });
    db = h.app.get(DB);
    dispatcher = h.app.get(OutboxDispatcher);
    publisher = h.app.get(OUTBOX_PUBLISHER);
  });
  afterAll(() => h.close());
  afterEach(() => jest.restoreAllMocks());
  beforeEach(() => h.pool.query(`UPDATE outbox_events SET published_at = now() WHERE published_at IS NULL`));

  const event = (aggregateId = randomUUID()) => ({
    type: 'form.published' as const,
    aggregateType: 'form' as const,
    aggregateId,
    idempotencyKey: `form.published:${aggregateId}`,
    payload: { version: 1 },
  });
  const row = async (key: string) => (await h.pool.query(`SELECT * FROM outbox_events WHERE idempotency_key = $1`, [key])).rows[0];

  it('marks an event dead after the attempt limit, logs it once without its payload, and never claims it again', async () => {
    const poison = event();
    const healthy = event();
    await db.transaction((tx) => writeOutboxEvent(tx, poison));
    await db.transaction((tx) => writeOutboxEvent(tx, healthy));
    const publish = publisher.publish.bind(publisher);
    const spy = jest
      .spyOn(publisher, 'publish')
      .mockImplementation((e: OutboxRow, tx) => (e.idempotencyKey === poison.idempotencyKey ? Promise.reject(new RangeError('detail 31.5,34.4')) : publish(e, tx)));
    const due = () => h.pool.query(`UPDATE outbox_events SET next_attempt_at = now() WHERE idempotency_key = $1`, [poison.idempotencyKey]);

    // الحدث السليم يُنشر في الدفعة الأولى مع فشل جاره
    expect(await dispatcher.dispatchBatch()).toBe(1);
    expect((await row(healthy.idempotencyKey)).published_at).not.toBeNull();
    expect(await row(poison.idempotencyKey)).toMatchObject({ attempts: 1, dead_at: null });
    await due();
    await dispatcher.dispatchBatch();
    expect(await row(poison.idempotencyKey)).toMatchObject({ attempts: 2, dead_at: null });
    await due();
    await dispatcher.dispatchBatch();
    const dead = await row(poison.idempotencyKey);
    expect(dead).toMatchObject({ attempts: 3, published_at: null, last_error: 'RangeError' });
    expect(dead.dead_at).not.toBeNull();

    // ميت: لا يُطالَب به ولو حان موعده
    const calls = spy.mock.calls.length;
    await due();
    expect(await dispatcher.dispatchBatch()).toBe(0);
    expect(spy.mock.calls.length).toBe(calls);

    const logged = lines
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((l) => l.msg === 'outbox event dead')
      .map(({ level: _l, time: _t, pid: _p, hostname: _h, msg: _m, ...fields }) => fields);
    expect(logged).toEqual([{ event_id: Number(dead.id), type: 'form.published', attempts: 3, err_name: 'RangeError' }]);
  });

  it('drains a backlog of several full batches without waiting a poll interval between them', async () => {
    const run = randomUUID();
    await h.pool.query(
      `INSERT INTO outbox_events (type, aggregate_type, aggregate_id, idempotency_key, payload)
       SELECT 'form.published', 'form', gen_random_uuid(), 'form.published:' || g || ':' || $1, '{"version": 1}' FROM generate_series(1, 300) g`,
      [run],
    );
    const pending = async () => Number((await h.pool.query(`SELECT count(*) AS n FROM outbox_events WHERE idempotency_key LIKE $1 AND published_at IS NULL`, [`%:${run}`])).rows[0].n);
    // مُرسل يعمل بمؤقته: ست دفعات ممتلئة من 50، ومهلة الاستطلاع ثانية
    const live = await createHarness({ env: { OUTBOX_DISPATCHER_ENABLED: 'true', OUTBOX_POLL_INTERVAL_MS: '1000', OUTBOX_BATCH_SIZE: '50' } });
    try {
      const started = Date.now();
      while ((await pending()) > 0 && Date.now() - started < 8000) await new Promise((r) => setTimeout(r, 50));
      expect(await pending()).toBe(0);
      expect(Date.now() - started).toBeLessThan(3500);
    } finally {
      await live.close();
    }
  }, 15_000);
});

