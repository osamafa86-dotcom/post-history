import type { FieldKeyring } from '../../src/common/crypto';
import type { Database } from '../../src/database/database.module';
import { AdminRecoveryError } from '../../src/identity/admin-recovery';
import { setAdminStatus } from '../../src/identity/admin-status';

describe('setAdminStatus quorum refusal', () => {
  const input = {
    mode: 'vault' as const,
    userId: '7d8f4c1e-2b3a-4c5d-8e9f-0a1b2c3d4e5f',
    status: 'suspended' as const,
    vaultToken: 'x',
    confirmer: { userId: '1d8f4c1e-2b3a-4c5d-8e9f-0a1b2c3d4e5f', totp: '000000' },
  };
  const failingDb = (err: unknown) => ({ transaction: () => Promise.reject(err) }) as unknown as Database;
  const deps = { keyring: {} as FieldKeyring };

  // drizzle يلفّ خطأ Postgres في cause؛ محفّز النصاب يجب أن يصل quorum في الحالتين
  it.each([
    ['bare', { code: '23514', constraint: 'admin_quorum_min_two' }],
    ['wrapped by drizzle', Object.assign(new Error('Failed query'), { cause: { code: '23514', constraint: 'admin_quorum_min_two' } })],
  ])('maps the admin_quorum_min_two trigger (%s) to refused (quorum)', async (_label, err) => {
    const got = await setAdminStatus(failingDb(err), deps, input).then(() => null, (e: unknown) => e);
    expect(got).toBeInstanceOf(AdminRecoveryError);
    expect((got as AdminRecoveryError).code).toBe('quorum');
  });

  it('rethrows any other database error unchanged', async () => {
    const err = Object.assign(new Error('Failed query'), { cause: { code: '40001' } });
    await expect(setAdminStatus(failingDb(err), deps, input)).rejects.toBe(err);
  });
});
