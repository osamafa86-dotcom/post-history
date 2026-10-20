import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { PushDeliveryWorker } from '../../src/push/push-delivery.worker';
import { APNS_SENDER, FCM_SENDER, type PushPayload, type PushResult, type PushSender } from '../../src/push/push-senders';
import { createHarness, drainOutbox, ensureForm, type Harness, loginAs } from './harness';

type Actor = Awaited<ReturnType<typeof loginAs>>;

class FakeSender implements PushSender {
  sent: Array<{ token: string; payload: PushPayload }> = [];
  results = new Map<string, PushResult>();
  async send(token: string, payload: PushPayload): Promise<PushResult> {
    this.sent.push({ token, payload });
    return this.results.get(token) ?? 'ok';
  }
}

describe('push delivery to registered devices', () => {
  const apns = new FakeSender();
  const fcm = new FakeSender();
  let h: Harness;
  let worker: PushDeliveryWorker;
  let reporter: Actor;
  let supervisor: Actor;
  beforeAll(async () => {
    h = await createHarness({ env: { PUSH_DELIVERY_ENABLED: 'true' }, overrides: [[APNS_SENDER, apns], [FCM_SENDER, fcm]] });
    worker = h.app.get(PushDeliveryWorker);
    await ensureForm(h);
    const office = (await h.pool.query<{ id: string }>(`INSERT INTO offices (name_ar, name_en) VALUES ('م', 'o') RETURNING id`)).rows[0]!.id;
    reporter = await loginAs(h, [{ role: 'reporter' }], { officeId: office });
    supervisor = await loginAs(h, [{ role: 'supervisor', scopeKind: 'office', scopeId: office }]);
  });
  afterAll(() => h.close());

  const http = () => request(h.app.getHttpServer());
  const device = (a: Actor, platform: 'ios' | 'android', token: string) =>
    http().put('/v1/push-devices').set('Authorization', `Bearer ${a.token}`).set('Idempotency-Key', randomUUID())
      .send({ installation_id: randomUUID(), platform, token }).expect(204);
  const material = async (title: string, priority = 'urgent') => {
    const res = await http()
      .post('/v1/materials')
      .set('Authorization', `Bearer ${reporter.token}`)
      .set('Idempotency-Key', randomUUID())
      .send({
        title,
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
    await drainOutbox(h);
    return res.body.id as string;
  };
  const deliveries = async (userId: string) =>
    (
      await h.pool.query(
        `SELECT d.channel, d.status, d.attempts, d.last_error FROM notification_deliveries d JOIN notifications n ON n.id = d.notification_id
          WHERE n.user_id = $1 ORDER BY d.channel`,
        [userId],
      )
    ).rows;
  const drain = async () => {
    while ((await worker.deliverBatch()) > 0) {
      /* حتى لا يبقى مستحق */
    }
  };

  it('pushes a whitelisted payload to each active device platform and marks the delivery sent', async () => {
    await device(supervisor, 'android', 'fcm-sup-1');
    await device(supervisor, 'ios', 'apns-sup-1');
    const id = await material('Sensitive title that must never be pushed');
    await drain();
    expect((await deliveries(supervisor.id)).map((d) => [d.channel, d.status])).toEqual([
      ['apns', 'sent'],
      ['fcm', 'sent'],
    ]);
    const pushed = [...apns.sent, ...fcm.sent].filter((s) => s.payload.material_id === id);
    expect(pushed.map((s) => s.token).sort()).toEqual(['apns-sup-1', 'fcm-sup-1']);
    for (const { payload } of pushed) {
      expect(Object.keys(payload).sort()).toEqual(['material_id', 'notification_id', 'priority', 'title', 'type']);
      expect(payload).toMatchObject({ type: 'material.urgent_received', priority: 'urgent' });
      expect(JSON.stringify(payload)).not.toContain('Sensitive title');
    }
  });

  it('an invalid token revokes its device for good; a provider outage is retried; a user without devices gets no delivery row', async () => {
    const office = (await h.pool.query<{ office_id: string }>(`SELECT office_id FROM users WHERE id = $1`, [reporter.id])).rows[0]!.office_id;
    const second = await loginAs(h, [{ role: 'supervisor', scopeKind: 'office', scopeId: office }]);
    await device(second, 'android', 'fcm-dead');
    fcm.results.set('fcm-dead', 'invalid_token');
    fcm.results.set('fcm-sup-1', 'retry');
    await material('Second urgent material');
    await worker.deliverBatch();

    expect(await deliveries(second.id)).toEqual([{ channel: 'fcm', status: 'failed', attempts: h.config.PUSH_MAX_ATTEMPTS, last_error: 'invalid_token' }]);
    expect((await h.pool.query(`SELECT revoked_at FROM push_devices WHERE user_id = $1`, [second.id])).rows[0].revoked_at).not.toBeNull();
    const flaky = (await deliveries(supervisor.id)).filter((d) => d.channel === 'fcm' && d.status === 'failed');
    expect(flaky).toEqual([{ channel: 'fcm', status: 'failed', attempts: 1, last_error: 'provider_unavailable' }]);
    expect(await deliveries(reporter.id)).toEqual([]);
    fcm.results.clear();
  });

  it('events whose rule is in-platform only (accepted for production) create no delivery', async () => {
    const producer = await loginAs(h, [{ role: 'producer' }]);
    await device(producer, 'ios', 'apns-producer');
    const event = await h.pool.query(
      `INSERT INTO outbox_events (type, aggregate_type, aggregate_id, idempotency_key, payload)
       SELECT 'material.accepted_for_production', 'material', id, 'test.accepted:' || gen_random_uuid(), jsonb_build_object('material_id', id) FROM materials LIMIT 1 RETURNING id`,
    );
    expect(event.rowCount).toBe(1);
    await drainOutbox(h);
    const after = (await h.pool.query(`SELECT count(*)::int AS n FROM notification_deliveries d JOIN notifications n ON n.id = d.notification_id WHERE n.user_id = $1`, [producer.id])).rows[0].n;
    expect(after).toBe(0);
    expect((await h.pool.query(`SELECT count(*)::int AS n FROM notifications WHERE user_id = $1`, [producer.id])).rows[0].n).toBe(1);
  });
});
