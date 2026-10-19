import pino from 'pino';
import request from 'supertest';
import { createHarness, type Harness, seedUploadSession, seedUser } from './harness';

// السجلات لا تحمل رمز الخطّاف ولا ترويسة Authorization ولا كلمات مرور ولا رموز جلسات (SEC-06، CLAUDE.md §5).
describe('structured logs carry no secrets', () => {
  const lines: string[] = [];
  let h: Harness;
  beforeAll(async () => {
    const logger = pino({ level: 'debug' }, { write: (line: string) => void lines.push(line) });
    h = await createHarness({ logger });
  });
  afterAll(() => h.close());

  it('redacts the hook token and never logs headers or bodies', async () => {
    const user = await seedUser(h);
    const http = () => request(h.app.getHttpServer());
    const { body: session } = await http().post('/v1/auth/login').send({ email: user.email, password: user.password }).expect(200);
    await http().get('/v1/auth/me').set('Authorization', `Bearer ${session.access_token}`).expect(200);
    await http().post('/v1/auth/login').send({ email: user.email, password: 'wrong-password-value' }).expect(401);

    const upload = await seedUploadSession(h, user.id);
    await http()
      .post(`/internal/tusd-hooks/${h.config.TUSD_HOOK_SECRET}`)
      .send({
        Type: 'pre-create',
        Event: {
          Upload: { Size: 1000, MetaData: { upload_session_id: upload.id } },
          HTTPRequest: { Header: { Authorization: [`Bearer ${upload.uploadToken}`] } },
        },
      })
      .expect(200);

    const log = lines.join('\n');
    expect(log).toContain('/internal/tusd-hooks/:hook_token');
    for (const secret of [
      h.config.TUSD_HOOK_SECRET,
      upload.uploadToken,
      user.password,
      'wrong-password-value',
      session.access_token,
      session.refresh_token,
      user.email,
    ]) {
      expect(log).not.toContain(secret);
    }
  });
});
