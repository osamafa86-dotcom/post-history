import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createHarness, type Harness, loginAs } from './harness';

describe('push devices (/v1/push-devices)', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(() => h.close());

  const call = (token: string, method: 'put' | 'delete', url: string, body?: object) =>
    request(h.app.getHttpServer())[method](url).set('Authorization', `Bearer ${token}`).set('Idempotency-Key', randomUUID()).send(body);
  const device = async (id: string) => (await h.pool.query(`SELECT * FROM push_devices WHERE installation_id = $1`, [id])).rows[0];

  it('registers with the token encrypted, updates on re-register, and unregisters', async () => {
    const a = await loginAs(h, [{ role: 'reporter' }]);
    const id = randomUUID();
    await call(a.token, 'put', '/v1/push-devices', { installation_id: id, platform: 'ios', token: 'apns-token-value-1' }).expect(204);
    let row = await device(id);
    expect(row.user_id).toBe(a.id);
    expect(row.token_enc.toString()).not.toContain('apns-token-value-1');
    await call(a.token, 'put', '/v1/push-devices', { installation_id: id, platform: 'ios', token: 'apns-token-value-2', app_version: '1.2.0' }).expect(204);
    row = await device(id);
    expect(row.app_version).toBe('1.2.0');
    await call(a.token, 'delete', `/v1/push-devices/${id}`).expect(204);
    expect((await device(id)).revoked_at).not.toBeNull();
    await call(a.token, 'delete', `/v1/push-devices/${id}`).expect(204);
  });

  it("validates the body and cannot unregister another user's device", async () => {
    const a = await loginAs(h, [{ role: 'reporter' }]);
    const b = await loginAs(h, [{ role: 'reporter' }]);
    const id = randomUUID();
    await call(a.token, 'put', '/v1/push-devices', { installation_id: id, platform: 'symbian', token: 'x' }).expect(422);
    await call(a.token, 'put', '/v1/push-devices', { installation_id: id, platform: 'android', token: 'fcm' }).expect(204);
    await call(b.token, 'delete', `/v1/push-devices/${id}`).expect(404);
    await call(b.token, 'delete', '/v1/push-devices/not-a-uuid').expect(404);
    expect((await device(id)).revoked_at).toBeNull();
  });

  it('logout from all sessions revokes the devices too (lost phone)', async () => {
    const a = await loginAs(h, [{ role: 'reporter' }]);
    const id = randomUUID();
    await call(a.token, 'put', '/v1/push-devices', { installation_id: id, platform: 'android', token: 'fcm' }).expect(204);
    await request(h.app.getHttpServer()).post('/v1/auth/logout').set('Authorization', `Bearer ${a.token}`).send({ all_sessions: true }).expect(204);
    expect((await device(id)).revoked_at).not.toBeNull();
  });
});
