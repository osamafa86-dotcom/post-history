import { createHash, randomBytes } from 'node:crypto';
import { totp } from '../../src/common/crypto';
import { fieldKeyring } from '../../src/config/config';
import { DB, type Database } from '../../src/database/database.module';
import { AdminRecoveryError, type Approver } from '../../src/identity/admin-recovery';
import { setAdminStatus } from '../../src/identity/admin-status';
import { parseStatusCliArgs } from '../../src/cli/set-admin-status';
import { createHarness, type Harness, loginAs, seedUser } from './harness';

describe('admin account suspend/reactivate (CLI, two-person confirmation)', () => {
  let h: Harness;
  let db: Database;
  const vaultToken = randomBytes(32).toString('base64url');
  const vaultHash = createHash('sha256').update(vaultToken).digest('hex');
  beforeAll(async () => {
    h = await createHarness();
    db = h.app.get(DB);
  });
  afterAll(() => h.close());

  const deps = () => ({ keyring: fieldKeyring(h.config), breakGlassTokenSha256: vaultHash });
  const person = async (role: string) => seedUser(h, { totp: true, roles: [{ role }] });
  const code = (u: { totpSecret?: Buffer }) => totp(u.totpSecret!, Date.now());
  const statusOf = async (id: string) => (await h.pool.query(`SELECT status FROM users WHERE id = $1`, [id])).rows[0].status;
  const audits = async (targetId: string) =>
    (await h.pool.query(`SELECT actor_id, action, details FROM audit_log WHERE target_id = $1 ORDER BY id`, [targetId])).rows;
  const refused = async (p: Promise<unknown>, codeName: string) => {
    const err = await p.then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(AdminRecoveryError);
    expect((err as AdminRecoveryError).code).toBe(codeName);
  };

  it('two other admins suspend an admin (sessions revoked, audited, event) and reactivate it', async () => {
    const target = await loginAs(h, [{ role: 'system_admin' }]);
    const [a, b] = [await person('system_admin'), await person('system_admin')];
    const approvers = () => [{ userId: a.id, totp: code(a) }, { userId: b.id, totp: code(b) }] as [Approver, Approver];
    const done = await setAdminStatus(db, deps(), { mode: 'two_admins', userId: target.id, status: 'suspended', approvers: approvers() });
    expect(done).toEqual({ userId: target.id, status: 'suspended', changed: true, actorId: a.id });
    expect(await statusOf(target.id)).toBe('suspended');
    const { rows } = await h.pool.query(`SELECT count(*)::int AS n FROM refresh_tokens WHERE user_id = $1 AND revoked_at IS NULL`, [target.id]);
    expect(rows[0].n).toBe(0);
    expect(await audits(target.id)).toEqual([
      { actor_id: a.id, action: 'user.suspended', details: { target_user_id: target.id, reason_code: 'suspended' } },
      { actor_id: b.id, action: 'user.status_confirmed', details: { target_user_id: target.id, reason_code: 'cli_two_admins' } },
    ]);
    const { rows: ev } = await h.pool.query(`SELECT payload FROM outbox_events WHERE type = 'user.status_changed' AND payload->>'user_id' = $1`, [target.id]);
    expect(ev.map((e) => e.payload.status)).toEqual(['suspended']);

    // الحالة القائمة: بلا أثر
    expect((await setAdminStatus(db, deps(), { mode: 'two_admins', userId: target.id, status: 'suspended', approvers: approvers() })).changed).toBe(false);
    const back = await setAdminStatus(db, deps(), { mode: 'two_admins', userId: target.id, status: 'active', approvers: approvers() });
    expect(back.changed).toBe(true);
    expect(await statusOf(target.id)).toBe('active');
  });

  it('vault token plus an editor-in-chief confirmation suspends an admin', async () => {
    const target = await person('system_admin');
    const eic = await person('editor_in_chief');
    await setAdminStatus(db, deps(), { mode: 'vault', userId: target.id, status: 'suspended', vaultToken, confirmer: { userId: eic.id, totp: code(eic) } });
    expect(await statusOf(target.id)).toBe('suspended');
  });

  it('a bad code or vault token changes nothing and is audited', async () => {
    const target = await person('system_admin');
    const [a, b] = [await person('system_admin'), await person('system_admin')];
    await refused(
      setAdminStatus(db, deps(), { mode: 'two_admins', userId: target.id, status: 'suspended', approvers: [{ userId: a.id, totp: code(a) }, { userId: b.id, totp: '000000' }] }),
      'verification_failed',
    );
    await refused(
      setAdminStatus(db, deps(), { mode: 'vault', userId: target.id, status: 'suspended', vaultToken: 'wrong', confirmer: { userId: a.id, totp: code(a) } }),
      'verification_failed',
    );
    expect(await statusOf(target.id)).toBe('active');
    expect((await audits(target.id)).map((r) => [r.actor_id, r.action, r.details.reason_code])).toEqual([
      [null, 'user.status_cli_rejected', 'cli_two_admins'],
      [null, 'user.status_cli_rejected', 'cli_vault'],
    ]);
  });

  it('refuses a non-admin target, the owner or a repeated approver, and a non-admin approver', async () => {
    const editor = await person('supervisor');
    const target = await person('system_admin');
    const [a, eic] = [await person('system_admin'), await person('editor_in_chief')];
    await refused(
      setAdminStatus(db, deps(), { mode: 'two_admins', userId: editor.id, status: 'suspended', approvers: [{ userId: a.id, totp: code(a) }, { userId: target.id, totp: code(target) }] }),
      'not_admin_target',
    );
    await refused(
      setAdminStatus(db, deps(), { mode: 'two_admins', userId: target.id, status: 'suspended', approvers: [{ userId: a.id, totp: code(a) }, { userId: target.id, totp: code(target) }] }),
      'invalid_approvers',
    );
    await refused(
      setAdminStatus(db, deps(), { mode: 'two_admins', userId: target.id, status: 'suspended', approvers: [{ userId: a.id, totp: code(a) }, { userId: a.id, totp: code(a) }] }),
      'invalid_approvers',
    );
    await refused(
      setAdminStatus(db, deps(), { mode: 'two_admins', userId: target.id, status: 'suspended', approvers: [{ userId: a.id, totp: code(a) }, { userId: eic.id, totp: code(eic) }] }),
      'invalid_approvers',
    );
    expect(await statusOf(target.id)).toBe('active');
  });

  it('parses the CLI arguments', () => {
    const id = '7d8f4c1e-2b3a-4c5d-8e9f-0a1b2c3d4e5f';
    expect(parseStatusCliArgs(['--user', id, '--status', 'suspended', '--mode', 'vault', '--approver', id])).toEqual({
      userId: id, status: 'suspended', mode: 'vault', approverIds: [id],
    });
    expect(() => parseStatusCliArgs(['--user', id, '--status', 'deleted', '--mode', 'vault', '--approver', id])).toThrow('--status');
    expect(() => parseStatusCliArgs(['--user', id, '--status', 'active', '--mode', 'two-admins', '--approver', id])).toThrow('two --approver');
  });
});
