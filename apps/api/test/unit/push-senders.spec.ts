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
  const payload: PushPayload = { notification_id: 'n1', type: 'material.urgent_received', material_id: 'm1', priority: 'urgent', title: 'مادة عاجلة واردة #m1' };
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
});
