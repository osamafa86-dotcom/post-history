import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { FieldKeyring, totp } from '../../src/common/crypto';
import { reencryptFields } from '../../src/common/reencrypt';
import { parseReencryptArgs } from '../../src/cli/reencrypt-fields';
import { fieldKeyring } from '../../src/config/config';
import { DB, type Database } from '../../src/database/database.module';
import { createHarness, type Harness, seedUploadSession, seedUser } from './harness';

/**
 * تدوير مفتاح الحقول: ما كُتب بالمفتاح القديم يُقرأ عبر الـ API بعد التدوير (القديم في *_PREVIOUS)، وأداة إعادة التشفير
 * تنقله إلى الجديد على دفعات فيُقرأ بعد إزالة القديم. القاعدة مشتركة مع ملفات أخرى بمفاتيحها العشوائية، فالتأكيدات
 * على صفوف هذا الملف فقط.
 */
describe('field key rotation and re-encryption', () => {
  const oldKey = randomBytes(32).toString('base64');
  const newKey = randomBytes(32).toString('base64');
  const env = {
    before: { FIELD_ENCRYPTION_KEY: oldKey, FIELD_ENCRYPTION_KEY_VERSION: '7' },
    during: { FIELD_ENCRYPTION_KEY: newKey, FIELD_ENCRYPTION_KEY_VERSION: '8', FIELD_ENCRYPTION_KEY_PREVIOUS: oldKey, FIELD_ENCRYPTION_KEY_PREVIOUS_VERSION: '7' },
    after: { FIELD_ENCRYPTION_KEY: newKey, FIELD_ENCRYPTION_KEY_VERSION: '8' },
  };
  let before: Harness;
  let during: Harness;
  let after: Harness;
  beforeAll(async () => {
    [before, during, after] = await Promise.all([createHarness({ env: env.before }), createHarness({ env: env.during }), createHarness({ env: env.after })]);
  });
  afterAll(async () => {
    await Promise.all([before.close(), during.close(), after.close()]);
  });

  const loginWithTotp = (h: Harness, u: { email: string; password: string; totpSecret?: Buffer }) =>
    request(h.app.getHttpServer()).post('/v1/auth/login').send({ email: u.email, password: u.password, totp_code: totp(u.totpSecret!, Date.now()) });
  const firstByte = async (sql: string, id: string) => ((await before.pool.query(sql, [id])).rows[0].v as Buffer)[0];

  it('reads old-key values through the API after rotation, re-encrypts them in resumable batches, and reads them without the old key', async () => {
    // قبل التدوير: مستخدم بمصادقة ثنائية، ومادة بإحداثيات، وجهاز إشعار، كلها بالمفتاح 7
    const users = await Promise.all([0, 1, 2].map(() => seedUser(before, { totp: true })));
    const s = await seedUploadSession(before, users[0]!.id);
    const ring7 = fieldKeyring(before.config);
    await before.pool.query(`UPDATE materials SET gps_enc = $2 WHERE id = $1`, [s.materialId, ring7.encrypt(Buffer.from('{"lat":31.5,"lng":34.4}'))]);
    const installation = (
      await before.pool.query<{ id: string }>(
        `INSERT INTO push_devices (installation_id, user_id, platform, token_enc) VALUES (gen_random_uuid(), $1, 'ios', $2) RETURNING installation_id AS id`,
        [users[0]!.id, ring7.encrypt(Buffer.from('apns-token'))],
      )
    ).rows[0]!.id;
    expect(await firstByte(`SELECT totp_secret_enc AS v FROM users WHERE id = $1`, users[0]!.id)).toBe(7);

    // بعد التدوير والقديم سابق: القراءة عبر الـ API تنجح
    await loginWithTotp(during, users[0]!).expect(200);
    // وبلا القديم قبل إعادة التشفير تفشل (الصف لا يُفك)
    expect((await loginWithTotp(after, users[1]!)).status).not.toBe(200);

    const db = during.app.get<Database>(DB);
    const ring = fieldKeyring(during.config);
    const dry = await reencryptFields(db, ring, { dryRun: true });
    expect(dry.find((r) => r.table === 'users')!.stale).toBeGreaterThanOrEqual(3);
    expect(dry.every((r) => r.reencrypted === 0)).toBe(true);
    const report = await reencryptFields(db, ring, { batchSize: 2 });
    expect(report.map((r) => r.table)).toEqual(['users', 'materials', 'push_devices']);
    expect(report.find((r) => r.table === 'users')!.reencrypted).toBeGreaterThanOrEqual(3);

    for (const u of users) expect(await firstByte(`SELECT totp_secret_enc AS v FROM users WHERE id = $1`, u.id)).toBe(8);
    expect(await firstByte(`SELECT gps_enc AS v FROM materials WHERE id = $1`, s.materialId)).toBe(8);
    const token = (await before.pool.query(`SELECT token_enc AS v FROM push_devices WHERE installation_id = $1`, [installation])).rows[0].v as Buffer;
    const only8 = new FieldKeyring({ version: 8, key: Buffer.from(newKey, 'base64') });
    expect(only8.decrypt(token).toString()).toBe('apns-token');
    // بلا القديم الآن: القراءة عبر الـ API تنجح
    for (const u of users.slice(1)) await loginWithTotp(after, u).expect(200);

    // الاستئناف: تشغيل ثانٍ لا يجد من صفوف هذا الملف شيئًا، ولا يمس ما أُعيد تشفيره
    const again = await reencryptFields(db, ring, { batchSize: 2 });
    const mine = await before.pool.query(`SELECT count(*)::int AS n FROM users WHERE id = ANY($1) AND get_byte(totp_secret_enc, 0) <> 8`, [users.map((u) => u.id)]);
    expect(mine.rows[0].n).toBe(0);
    expect(again.find((r) => r.table === 'users')!.reencrypted).toBe(0);
  });

  it('parses its command line', () => {
    expect(parseReencryptArgs([])).toEqual({ dryRun: false, batchSize: 500 });
    expect(parseReencryptArgs(['--dry-run', '--batch', '50'])).toEqual({ dryRun: true, batchSize: 50 });
    expect(() => parseReencryptArgs(['--batch', '0'])).toThrow();
    expect(() => parseReencryptArgs(['--key', 'x'])).toThrow();
  });
});
