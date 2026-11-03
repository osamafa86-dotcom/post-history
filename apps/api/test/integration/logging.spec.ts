import { sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import pino from 'pino';
import request from 'supertest';
import { ErrorFilter, toErrorResponse } from '../../src/common/error.filter';
import { LOGGER } from '../../src/common/logger';
import { DB, type Database } from '../../src/database/database.module';
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

// ADR 0115: خطأ استعلام Drizzle يحمل «params: <كل القيم المربوطة>» في رسالته ومكدّسه؛ السجل يأخذ اسم الخطأ ورمز Postgres والقيد وحدها
describe('5xx logs carry no bound query values', () => {
  const lines: string[] = [];
  let h: Harness;
  let db: Database;
  beforeAll(async () => {
    const logger = pino({ level: 'debug' }, { write: (line: string) => void lines.push(line) });
    h = await createHarness({ logger });
    db = h.app.get(DB);
  });
  afterAll(() => h.close());

  const failure = async (run: () => Promise<unknown>): Promise<unknown> => {
    try {
      await run();
    } catch (err) {
      return err;
    }
    throw new Error('expected the query to fail');
  };
  const context = (req: object) => {
    const res = {
      statusCode: 0,
      body: undefined as unknown,
      setHeader: () => res,
      status: (s: number) => ((res.statusCode = s), res),
      json: (b: unknown) => ((res.body = b), res),
      end: () => res,
    };
    return { res, host: { switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }) } };
  };

  it('logs err_name, the pg code and the constraint, never the params, the message or the stack', async () => {
    const marker = `marker-${randomUUID()}`;
    const err = await failure(() => db.execute(sql`SELECT 1 / 0 WHERE ${marker}::text IS NOT NULL`));
    expect(String((err as Error).message)).toContain(marker);
    const { res, host } = context({ id: 'req-1', originalUrl: '/v1/materials?x=1' });
    new ErrorFilter(h.app.get(LOGGER)).catch(err, host as never);
    expect(res.statusCode).toBe(500);
    const log = lines.join('\n');
    expect(log).toContain('"pg_code":"22012"');
    expect(log).toContain('"err_name":"DrizzleQueryError"');
    expect(log).not.toContain(marker);
    expect(log).not.toContain('params');
    expect(log).not.toContain('stack');
  });

  it('answers 422, not 500, for a value the database rejects as input (NUL, unparsable text), and logs nothing of it', async () => {
    const marker = `marker-${randomUUID()}`;
    for (const query of [sql`SELECT ${`${marker}\u0000`}::text`, sql`SELECT ${marker}::int`]) {
      const err = await failure(() => db.execute(query));
      expect(toErrorResponse(err, 'r')).toMatchObject({ status: 422, body: { code: 'validation_failed' } });
    }
    const before = lines.length;
    const user = await seedUser(h);
    const res = await request(h.app.getHttpServer()).post('/v1/auth/login').send({ email: user.email, password: `${marker}\u0000x` });
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ code: 'validation_failed', details: { fields: ['/password'] } });
    expect(lines.slice(before).join('\n')).not.toContain(marker);
  });
});
