import { randomUUID } from 'node:crypto';
import { DB, type Database } from '../../src/database/database.module';
import { OUTBOX_PUBLISHER, OutboxDispatcher, type OutboxPublisher, type OutboxRow } from '../../src/outbox/outbox.dispatcher';
import { writeOutboxEvent } from '../../src/outbox/outbox';
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
