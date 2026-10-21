import { createHash, randomBytes, randomUUID } from 'node:crypto';
import request from 'supertest';
import { base32Decode, totp } from '../../src/common/crypto';
import { fieldKeyring } from '../../src/config/config';
import { DB, type Database } from '../../src/database/database.module';
import { AdminRecoveryError } from '../../src/identity/admin-recovery';
import { type CreateUserInput, createUser } from '../../src/identity/create-user';
import { parseCreateUserCliArgs } from '../../src/cli/create-user';
import { createHarness, type Harness, seedUser } from './harness';

describe('account creation on a real host (cli:create-user, ADR 0030)', () => {
  let h: Harness;
  let db: Database;
  let office: string;
  const vaultToken = randomBytes(32).toString('base64url');
  const vaultHash = createHash('sha256').update(vaultToken).digest('hex');
  beforeAll(async () => {
    h = await createHarness();
    db = h.app.get(DB);
    office = (await h.pool.query<{ id: string }>(`INSERT INTO offices (name_ar, name_en) VALUES ('م', 'o') RETURNING id`)).rows[0]!.id;
  });
  afterAll(() => h.close());

  const deps = () => ({ keyring: fieldKeyring(h.config), breakGlassTokenSha256: vaultHash });
  const person = (role: string) => seedUser(h, { totp: true, roles: [{ role }] });
  const code = (u: { totpSecret?: Buffer }) => totp(u.totpSecret!, Date.now());
  const email = () => `new-${randomUUID()}@example.org`;
  const refused = async (input: CreateUserInput, codeName: string) => {
    const err = await createUser(db, deps(), input).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(AdminRecoveryError);
    expect((err as AdminRecoveryError).code).toBe(codeName);
  };
  const login = (e: string, password: string) => request(h.app.getHttpServer()).post('/v1/auth/login').send({ email: e, password });

  it('one admin creates a reporter: one-time password logs in, role and office stored, audited without the email', async () => {
    const admin = await person('system_admin');
    const e = email();
    const done = await createUser(db, deps(), { email: e, role: 'reporter', scopeKind: 'all', scopeId: '', officeId: office, mode: 'one_admin', approver: { userId: admin.id, totp: code(admin) } });
    expect(done.password.length).toBeGreaterThanOrEqual(24);
    expect(done.otpauthUri).toBeNull();
    expect((await login(e, done.password).expect(200)).body.access_token).toBeTruthy();
    const { rows: roles } = await h.pool.query(`SELECT role, scope_kind, granted_by FROM user_roles WHERE user_id = $1`, [done.userId]);
    expect(roles).toEqual([{ role: 'reporter', scope_kind: 'all', granted_by: admin.id }]);
    expect((await h.pool.query(`SELECT office_id, password_hash FROM users WHERE id = $1`, [done.userId])).rows[0]).toMatchObject({ office_id: office });
    const { rows: audit } = await h.pool.query(`SELECT actor_id, action, details FROM audit_log WHERE target_id = $1`, [done.userId]);
    expect(audit).toEqual([
      { actor_id: admin.id, action: 'user.created', details: { target_user_id: done.userId, role: 'reporter', scope_kind: 'all', scope_id: '', reason_code: 'cli_one_admin' } },
    ]);
    expect(JSON.stringify(audit)).not.toContain(e);
    // كلمة السر لا تُخزَّن صريحة
    expect(JSON.stringify((await h.pool.query(`SELECT * FROM users WHERE id = $1`, [done.userId])).rows)).not.toContain(done.password);
  });

  it('a supervisor with office scope; the same email twice is refused', async () => {
    const admin = await person('system_admin');
    const e = email();
    const base = { email: e, role: 'supervisor' as const, scopeKind: 'office' as const, scopeId: office, mode: 'one_admin' as const };
    await createUser(db, deps(), { ...base, approver: { userId: admin.id, totp: code(admin) } });
    await refused({ ...base, email: e.toUpperCase(), approver: { userId: admin.id, totp: code(admin) } }, 'email_taken');
  });

  it('a system administrator needs two people; one admin, a wrong code or a non-admin approver is refused and nothing is created', async () => {
    const [a, b] = [await person('system_admin'), await person('system_admin')];
    const chief = await person('editor_in_chief');
    const e = email();
    const base = { email: e, role: 'system_admin' as const, scopeKind: 'all' as const, scopeId: '' };
    await refused({ ...base, mode: 'one_admin', approver: { userId: a.id, totp: code(a) } }, 'invalid_input');
    await refused({ ...base, mode: 'two_admins', approvers: [{ userId: a.id, totp: code(a) }, { userId: b.id, totp: '000000' }] }, 'verification_failed');
    await refused({ ...base, mode: 'two_admins', approvers: [{ userId: a.id, totp: code(a) }, { userId: chief.id, totp: code(chief) }] }, 'invalid_approvers');
    await refused({ ...base, role: 'producer', mode: 'one_admin', approver: { userId: chief.id, totp: code(chief) } }, 'invalid_approvers');
    expect((await h.pool.query(`SELECT 1 FROM users WHERE lower(email) = lower($1)`, [e])).rows).toEqual([]);

    const done = await createUser(db, deps(), { ...base, mode: 'two_admins', approvers: [{ userId: a.id, totp: code(a) }, { userId: b.id, totp: code(b) }] });
    // مدير النظام يُسجَّل له TOTP عند الإنشاء: الدخول يطلب الرمز، ويقبل الرمز من سرّ otpauth، ولا بريد في الرابط
    expect(done.otpauthUri).toMatch(/^otpauth:\/\/totp\/PostHistory%3A[0-9a-f-]{36}\?secret=[A-Z2-7]+&issuer=PostHistory/);
    expect(done.otpauthUri).not.toContain('example.org');
    expect((await login(e, done.password).expect(401)).body.code).toBe('totp_required');
    const secret = base32Decode(/secret=([A-Z2-7]+)/.exec(done.otpauthUri!)![1]!);
    await request(h.app.getHttpServer()).post('/v1/auth/login').send({ email: e, password: done.password, totp_code: totp(secret, Date.now()) }).expect(200);
    const { rows } = await h.pool.query(`SELECT actor_id, action FROM audit_log WHERE target_id = $1 ORDER BY id`, [done.userId]);
    expect(rows).toEqual([
      { actor_id: a.id, action: 'user.created' },
      { actor_id: b.id, action: 'user.created_confirmed' },
    ]);
  });

  it('vault mode: the break-glass token plus an editor in chief; bootstrap is closed once two active admins exist', async () => {
    const chief = await person('editor_in_chief');
    const base = { role: 'system_admin' as const, scopeKind: 'all' as const, scopeId: '' };
    await refused({ ...base, email: email(), mode: 'vault', vaultToken: 'wrong', confirmer: { userId: chief.id, totp: code(chief) } }, 'verification_failed');
    const done = await createUser(db, deps(), { ...base, email: email(), mode: 'vault', vaultToken, confirmer: { userId: chief.id, totp: code(chief) } });
    expect(done.actorId).toBe(chief.id);
    // القاعدة المشتركة فيها مديرون فاعلون أكثر من اثنين
    await refused({ ...base, email: email(), mode: 'bootstrap', vaultToken }, 'bootstrap_closed');
    await refused({ ...base, role: 'reporter', email: email(), officeId: office, mode: 'bootstrap', vaultToken }, 'invalid_input');
  });

  it('parses the command line strictly', () => {
    const id = randomUUID();
    expect(parseCreateUserCliArgs(['--email', 'a@b.org', '--role', 'producer', '--mode', 'one-admin', '--approver', id])).toEqual({
      email: 'a@b.org',
      role: 'producer',
      scopeKind: 'all',
      scopeId: '',
      mode: 'one_admin',
      approverIds: [id],
    });
    expect(() => parseCreateUserCliArgs(['--email', 'a@b.org', '--role', 'system_admin', '--mode', 'two-admins', '--approver', id])).toThrow(/2 --approver/);
    expect(() => parseCreateUserCliArgs(['--email', 'a@b.org', '--role', 'system_admin', '--mode', 'bootstrap', '--approver', id])).toThrow(/0 --approver/);
    expect(() => parseCreateUserCliArgs(['--email', 'a@b.org', '--role', 'reporter', '--mode', 'root'])).toThrow(/--mode/);
    expect(() => parseCreateUserCliArgs(['--email', 'a@b.org', '--role', 'reporter', '--mode', 'one-admin', '--approver', id, '--password', 'x'])).toThrow();
  });
});
