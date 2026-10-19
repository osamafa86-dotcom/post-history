import { createHash, randomBytes } from 'node:crypto';
import { totp } from '../../src/common/crypto';
import { fieldKeyring } from '../../src/config/config';
import { DB, type Database } from '../../src/database/database.module';
import { AdminRecoveryError, approveAdminRecovery } from '../../src/identity/admin-recovery';
import { parseCliArgs } from '../../src/cli/approve-admin-recovery';
import { createHarness, type Harness, loginAs, seedUser } from './harness';

describe('break-glass admin recovery (CLI, two-person confirmation)', () => {
  let h: Harness;
  let db: Database;
  const vaultToken = randomBytes(32).toString('base64url');
  const vaultHash = createHash('sha256').update(vaultToken).digest('hex');
  beforeAll(async () => {
    h = await createHarness();
    db = h.app.get(DB);
  });
  afterAll(() => h.close());

  const deps = (withVault = true) => ({ keyring: fieldKeyring(h.config), breakGlassTokenSha256: withVault ? vaultHash : undefined });
  const person = async (role: string) => seedUser(h, { totp: true, roles: [{ role }] });
  const code = (u: { totpSecret?: Buffer }) => totp(u.totpSecret!, Date.now());
  const pending = async (userId: string) =>
    (
      await h.pool.query<{ id: string }>(
        `INSERT INTO recovery_requests (user_id, expires_at) VALUES ($1, now() + interval '1 hour') RETURNING id`,
        [userId],
      )
    ).rows[0]!.id;
  const state = async (id: string) => (await h.pool.query(`SELECT state, approved_by FROM recovery_requests WHERE id = $1`, [id])).rows[0];
  const audits = async (targetId: string) =>
    (await h.pool.query(`SELECT actor_id, action, details FROM audit_log WHERE target_id = $1 ORDER BY id`, [targetId])).rows;
  const refused = async (p: Promise<unknown>, codeName: string) => {
    const err = await p.then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(AdminRecoveryError);
    expect((err as AdminRecoveryError).code).toBe(codeName);
  };

  it('two other admins with valid TOTP codes approve it: sessions revoked, both audited, event written', async () => {
    const target = await loginAs(h, [{ role: 'system_admin' }]);
    const [a, b] = [await person('system_admin'), await person('system_admin')];
    const id = await pending(target.id);
    const done = await approveAdminRecovery(db, deps(), {
      mode: 'two_admins',
      requestId: id,
      note: 'verified in person at the office',
      approvers: [
        { userId: a.id, totp: code(a) },
        { userId: b.id, totp: code(b) },
      ],
    });
    expect(done).toEqual({ requestId: id, targetUserId: target.id, approvedBy: a.id });
    expect(await state(id)).toEqual({ state: 'approved', approved_by: a.id });
    const { rows } = await h.pool.query(`SELECT count(*)::int AS n FROM refresh_tokens WHERE user_id = $1 AND revoked_at IS NULL`, [target.id]);
    expect(rows[0].n).toBe(0);
    expect(await audits(target.id)).toEqual([
      { actor_id: a.id, action: 'auth.recovery_approved', details: { recovery_request_id: id, target_user_id: target.id, reason_code: 'cli_two_admins' } },
      { actor_id: b.id, action: 'auth.recovery_confirmed', details: { recovery_request_id: id, target_user_id: target.id, reason_code: 'cli_two_admins' } },
    ]);
    const { rows: ev } = await h.pool.query(`SELECT type, actor_id FROM outbox_events WHERE idempotency_key = $1`, [`auth.recovery_approved:${id}`]);
    expect(ev).toEqual([{ type: 'auth.recovery_approved', actor_id: a.id }]);
    // لا يُعتمد مرتين
    await refused(
      approveAdminRecovery(db, deps(), { mode: 'two_admins', requestId: id, note: 'x', approvers: [{ userId: a.id, totp: code(a) }, { userId: b.id, totp: code(b) }] }),
      'not_pending',
    );
  });

  it('a wrong code changes nothing and leaves a rejected-attempt audit row', async () => {
    const target = await person('system_admin');
    const [a, b] = [await person('system_admin'), await person('system_admin')];
    const id = await pending(target.id);
    await refused(
      approveAdminRecovery(db, deps(), { mode: 'two_admins', requestId: id, note: 'x', approvers: [{ userId: a.id, totp: code(a) }, { userId: b.id, totp: '000000' === code(b) ? '111111' : '000000' }] }),
      'verification_failed',
    );
    expect((await state(id)).state).toBe('pending_approval');
    expect(await audits(target.id)).toEqual([
      { actor_id: null, action: 'auth.recovery_cli_rejected', details: { recovery_request_id: id, target_user_id: target.id, reason_code: 'cli_two_admins' } },
    ]);
  });

  it('refuses the same person twice, the owner as approver, a non-admin approver and a non-admin target', async () => {
    const target = await person('system_admin');
    const [a, editor] = [await person('system_admin'), await person('editor_in_chief')];
    const id = await pending(target.id);
    const two = (x: { id: string; totpSecret?: Buffer }, y: { id: string; totpSecret?: Buffer }, requestId = id) =>
      approveAdminRecovery(db, deps(), { mode: 'two_admins', requestId, note: 'x', approvers: [{ userId: x.id, totp: code(x) }, { userId: y.id, totp: code(y) }] });
    await refused(two(a, a), 'invalid_approvers');
    await refused(two(a, target), 'invalid_approvers');
    await refused(two(a, editor), 'invalid_approvers');
    const reporter = await person('reporter');
    await refused(two(a, editor, await pending(reporter.id)), 'not_admin_target');
    expect((await state(id)).state).toBe('pending_approval');
  });

  it('vault mode: the vault token plus a confirming editor-in-chief; disabled without the configured hash; a wrong token fails', async () => {
    const target = await person('system_admin');
    const editor = await person('editor_in_chief');
    const id = await pending(target.id);
    const vault = (token: string, withVault = true) =>
      approveAdminRecovery(db, deps(withVault), { mode: 'vault', requestId: id, note: 'verified by phone call', vaultToken: token, confirmer: { userId: editor.id, totp: code(editor) } });
    await refused(vault(vaultToken, false), 'vault_disabled');
    await refused(vault('not-the-vault-token'), 'verification_failed');
    expect((await state(id)).state).toBe('pending_approval');
    await vault(vaultToken);
    expect(await state(id)).toEqual({ state: 'approved', approved_by: editor.id });
    expect((await audits(target.id)).map((r) => [r.action, r.details.reason_code])).toEqual([
      ['auth.recovery_cli_rejected', 'cli_vault'],
      ['auth.recovery_approved', 'cli_vault'],
    ]);
  });

  it('parses the command line: secrets are never arguments', () => {
    const r = '11111111-1111-4111-8111-111111111111';
    const u = '22222222-2222-4222-8222-222222222222';
    const v = '33333333-3333-4333-8333-333333333333';
    expect(parseCliArgs(['--request', r, '--mode', 'two-admins', '--approver', u, '--approver', v, '--note', 'in person'])).toEqual({
      requestId: r,
      mode: 'two_admins',
      approverIds: [u, v],
      note: 'in person',
    });
    expect(parseCliArgs(['--request', r, '--mode', 'vault', '--approver', u, '--note', 'n']).mode).toBe('vault');
    expect(() => parseCliArgs(['--request', r, '--mode', 'two-admins', '--approver', u, '--note', 'n'])).toThrow('two --approver');
    expect(() => parseCliArgs(['--request', r, '--mode', 'vault', '--approver', u])).toThrow('--note');
    expect(() => parseCliArgs(['--request', r, '--mode', 'vault', '--approver', u, '--note', 'n', '--token', 'x'])).toThrow();
    expect(() => parseCliArgs(['--request', 'nope', '--mode', 'vault', '--approver', u, '--note', 'n'])).toThrow('--request');
  });
});
