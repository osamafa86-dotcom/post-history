import { schemaFileValidator } from '../../src/common/contract';
import { generateKeyPairSync } from 'node:crypto';
import { FcmSender, type PushPayload } from '../../src/push/push-senders';

describe('FCM sender', () => {
  const account = Buffer.from(
    JSON.stringify({
      client_email: 'push@example.iam.gserviceaccount.com',
      private_key: generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ format: 'pem', type: 'pkcs8' }),
      token_uri: 'https://oauth.test/token',
    }),
  ).toString('base64');
  const payload: PushPayload = { channel: 'fcm', notification_id: 'n1', type: 'material.urgent_received', material_id: 'm1', priority: 'urgent', title: 'مادة عاجلة واردة #m1' };
  const sender = (status: number, body: object = {}, seen: string[] = []) =>
    new FcmSender('proj', account, (async (url: string, init: RequestInit) => {
      if (url.includes('oauth.test')) return new Response(JSON.stringify({ access_token: 'at' }), { status: 200 });
      seen.push(String(init.body));
      return new Response(JSON.stringify(body), { status });
    }) as unknown as typeof fetch);

  it('sends only the whitelisted fields, high priority for urgent', async () => {
    const seen: string[] = [];
    expect(await sender(200, {}, seen).send('tok', payload)).toBe('ok');
    const message = JSON.parse(seen[0]!).message;
    expect(message).toEqual({
      token: 'tok',
      notification: { title: payload.title },
      data: { notification_id: 'n1', type: 'material.urgent_received', material_id: 'm1', priority: 'urgent' },
      android: { priority: 'HIGH' },
    });
  });

  it('maps unregistered and invalid tokens to invalid_token, and outages to retry', async () => {
    expect(await sender(404).send('t', payload)).toBe('invalid_token');
    expect(await sender(400, { error: { status: 'INVALID_ARGUMENT' } }).send('t', payload)).toBe('invalid_token');
    expect(await sender(503).send('t', payload)).toBe('retry');
    expect(await sender(429).send('t', payload)).toBe('retry');
  });

  it('the payload matches the channel whitelist of the contract, and a revealing key is refused', () => {
    const valid = schemaFileValidator('notification-channel-payload.json');
    const real = { ...payload, notification_id: '7d8f4c1e-2b3a-4c5d-8e9f-0a1b2c3d4e5f', material_id: '1d8f4c1e-2b3a-4c5d-8e9f-0a1b2c3d4e5f' };
    expect(valid(real)).toBe(true);
    expect(valid({ ...real, escalation_level: 2 })).toBe(true);
    expect(valid({ ...real, gps: '31.5,34.4' })).toBe(false);
    expect(valid({ ...real, channel: 'sms', escalation_level: 1 })).toBe(false);
    expect(valid({ ...real, title: 'x'.repeat(121) })).toBe(false);
  });
});
