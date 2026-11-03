import { randomInt, randomUUID } from 'node:crypto';
import request from 'supertest';
import { CLIENT_ADDRESS_HEADER } from '../../src/common/client-address';
import { createHarness, freshTotp, type Harness, seedUser } from './harness';

// عنوان عشوائي لكل طلب: سلال حد المعدل في Redis تبقى بين التشغيلات
const v4 = () => `10.${randomInt(256)}.${randomInt(256)}.${randomInt(1, 255)}`;
const net64 = () => `2001:db8:${randomInt(65536).toString(16)}:${randomInt(65536).toString(16)}`;

/**
 * ADR 0117: حدود الدخول كانت بالعنوان الخام وحده، فالتخمين الموزّع على عناوين كثيرة بلا حد. الآن: كل حد بالعنوان على سلة /64،
 * وعدّادا فشل لكل حساب مستقلان عن العنوان (كلمة المرور ورمز TOTP) بتأخير متضاعف، والبريد غير الموجود يُعدّ كالموجود.
 */
describe('per-account failure counters and address buckets (ADR 0117)', () => {
  let h: Harness;
  beforeAll(async () => {
    // الاتصال من الحلقة المحلية «عنوان الـBFF»، فترويسة العنوان تعطي كل طلب عنوانًا مختلفًا كما في هجوم موزّع
    h = await createHarness({
      env: {
        BFF_SOURCE_ADDRESSES: '127.0.0.1/32,::1/128',
        LOGIN_RATE_LIMIT_MAX: '100',
        LOGIN_RATE_LIMIT_IP_MAX: '3',
        LOGIN_BACKOFF_FREE_ATTEMPTS: '3',
        LOGIN_BACKOFF_BASE_SECONDS: '60',
      },
    });
  });
  afterAll(() => h.close());

  const login = (body: object, from = v4()) =>
    request(h.app.getHttpServer()).post('/v1/auth/login').set(CLIENT_ADDRESS_HEADER, from).send(body);

  it('a password guessed from many addresses is held back per account, even with the right password, once the free attempts are spent', async () => {
    const user = await seedUser(h);
    for (let i = 0; i < 3; i++) await login({ email: user.email, password: `wrong-${i}-password` }).expect(401);
    // الرابعة تُعدّ وتبدأ التأخير، وما بعدها 429 من أي عنوان قبل فحص كلمة المرور
    await login({ email: user.email, password: 'wrong-4-password' }).expect(401);
    const held = await login({ email: user.email, password: user.password }).expect(429);
    expect(held.body.code).toBe('rate_limited');
    expect(Number(held.headers['retry-after'])).toBeGreaterThan(30);
    await login({ email: user.email.toUpperCase(), password: user.password }).expect(429);
    // حساب آخر من العنوان نفسه غير متأثر
    const other = await seedUser(h);
    await login({ email: other.email, password: other.password }).expect(200);
  });

  it('an unknown email is counted and held back exactly like an existing one', async () => {
    const user = await seedUser(h);
    const ghost = `nobody-${randomUUID()}@example.test`;
    const run = async (email: string) => {
      const out: Array<[number, string]> = [];
      for (let i = 0; i < 5; i++) {
        const res = await login({ email, password: `wrong-${i}-password` });
        out.push([res.status, res.body.code]);
      }
      return out;
    };
    const real = await run(user.email);
    expect(await run(ghost)).toEqual(real);
    expect(real.map(([s]) => s)).toEqual([401, 401, 401, 401, 429]);
  });

  it('the TOTP step has its own per-account counter, and an accepted code is not accepted again', async () => {
    const user = await seedUser(h, { totp: true });
    const code = freshTotp(user.id, user.totpSecret!);
    await login({ email: user.email, password: user.password, totp_code: code }).expect(200);
    // الرمز نفسه في خطوته يُرفض كالخاطئ، ولو من عنوان آخر
    expect((await login({ email: user.email, password: user.password, totp_code: code }).expect(401)).body.code).toBe('unauthorized');
    await login({ email: user.email, password: user.password, totp_code: freshTotp(user.id, user.totpSecret!) }).expect(200);

    const wrong = (c: string) => (c === '000000' ? '111111' : '000000');
    for (let i = 0; i < 4; i++) await login({ email: user.email, password: user.password, totp_code: wrong(code) }).expect(401);
    const held = await login({ email: user.email, password: user.password, totp_code: freshTotp(user.id, user.totpSecret!) }).expect(429);
    expect(Number(held.headers['retry-after'])).toBeGreaterThan(30);
    // التأخير قبل كلمة المرور أيضًا: لا يُستدل به على صحتها
    await login({ email: user.email, password: 'wrong-password-x' }).expect(429);
  });

  it('address limits count an IPv6 client by its /64', async () => {
    const net = net64();
    const fail = (from: string) => login({ email: `nobody-${randomUUID()}@example.test`, password: 'wrong-password' }, from);
    for (let i = 1; i <= 3; i++) await fail(`${net}::${i}`).expect(401);
    await fail(`${net}:ffff:ffff:ffff:ffff`).expect(429);
    await fail(`${net64()}::1`).expect(401);
  });

  it('account recovery is bucketed by /64 too', async () => {
    const net = net64();
    const start = (from: string) =>
      request(h.app.getHttpServer())
        .post('/v1/auth/recovery')
        .set(CLIENT_ADDRESS_HEADER, from)
        .send({ email: `nobody-${randomUUID()}@example.test`, backup_code: 'NOPENOPE2345' });
    const statuses: number[] = [];
    for (let i = 1; i <= 101; i++) {
      const res = await start(`${net}::${i.toString(16)}`);
      statuses.push(res.status);
      if (res.status === 429) break;
    }
    // LOGIN_RATE_LIMIT_IP_MAX لا يخص الاستعادة؛ حدّها لكل عنوان هو نفسه، فالشبكة كلها سلة واحدة
    expect(statuses.at(-1)).toBe(429);
    expect(statuses.length).toBeLessThanOrEqual(4);
  });
});
