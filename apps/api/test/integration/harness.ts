import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { hash } from '@node-rs/argon2';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import type { Logger } from 'pino';
import { AppModule, configureApp } from '../../src/app.module';
import { createLogger } from '../../src/common/logger';
import { encryptField, randomToken, sha256 } from '../../src/common/crypto';
import { type AppConfig, loadConfig } from '../../src/config/config';

export interface Harness {
  app: INestApplication;
  config: AppConfig;
  pool: Pool;
  close(): Promise<void>;
}

export async function createHarness(
  extra: { controllers?: unknown[]; logger?: Logger; env?: Record<string, string>; overrides?: Array<[unknown, unknown]> } = {},
): Promise<Harness> {
  const config = loadConfig({ ...process.env, ...extra.env });
  const logger = extra.logger ?? createLogger('silent');
  let builder = Test.createTestingModule({
    imports: [AppModule.forRoot(config, logger)],
    controllers: (extra.controllers ?? []) as never[],
  });
  for (const [token, value] of extra.overrides ?? []) builder = builder.overrideProvider(token as never).useValue(value);
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication({ logger: false });
  configureApp(app, config, logger);
  await app.init();
  const pool = new Pool({ connectionString: config.DATABASE_URL, max: 4 });
  return {
    app,
    config,
    pool,
    async close() {
      await pool.end();
      await app.close();
    },
  };
}

export interface SeededUser {
  id: string;
  email: string;
  password: string;
  totpSecret?: Buffer;
}

export async function seedUser(
  h: Harness,
  opts: { totp?: boolean; status?: string; roles?: Array<{ role: string; scopeKind?: string; scopeId?: string }> } = {},
): Promise<SeededUser> {
  const email = `user-${randomUUID()}@example.test`;
  const password = randomToken(12);
  const totpSecret = opts.totp ? Buffer.from(randomToken(20)) : undefined;
  const key = Buffer.from(h.config.FIELD_ENCRYPTION_KEY, 'base64');
  const { rows } = await h.pool.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, totp_enabled, totp_secret_enc, status)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [email, await hash(password), !!totpSecret, totpSecret ? encryptField(key, totpSecret) : null, opts.status ?? 'active'],
  );
  const id = rows[0]!.id;
  for (const r of opts.roles ?? [{ role: 'reporter' }]) {
    await h.pool.query(`INSERT INTO user_roles (user_id, role, scope_kind, scope_id) VALUES ($1, $2, $3, $4)`, [
      id,
      r.role,
      r.scopeKind ?? 'all',
      r.scopeId ?? '',
    ]);
  }
  return { id, email, password, totpSecret };
}

export async function ensureForm(h: Harness): Promise<void> {
  await h.pool.query(
    `INSERT INTO upload_forms (version, schema) VALUES (1, '{"version": 1, "fields": []}') ON CONFLICT DO NOTHING`,
  );
}

export async function seedUploadSession(
  h: Harness,
  reporterId: string,
  opts: { kind?: string; size?: number; state?: string; expiresInSeconds?: number } = {},
): Promise<{ id: string; materialId: string; uploadToken: string }> {
  await ensureForm(h);
  const { rows: m } = await h.pool.query<{ id: string }>(
    `INSERT INTO materials (reporter_id, title, material_types, governorate, city, priority,
       sensitivity_minors, sensitivity_injured, sensitivity_graphic, display_name_mode, form_version)
     VALUES ($1, 'test', '{report}', 'gaza', 'gaza', 'normal', false, false, false, 'network', 1) RETURNING id`,
    [reporterId],
  );
  const uploadToken = randomToken();
  const { rows } = await h.pool.query<{ id: string }>(
    `INSERT INTO upload_sessions (material_id, created_by, kind, state, size_bytes, filename, part_size_bytes,
       upload_token_hash, expires_at)
     VALUES ($1, $2, $3, $4, $5, 'clip.mp4', 16777216, $6, now() + make_interval(secs => $7)) RETURNING id`,
    [m[0]!.id, reporterId, opts.kind ?? 'original', opts.state ?? 'created', opts.size ?? 1000, sha256(uploadToken), opts.expiresInSeconds ?? 3600],
  );
  return { id: rows[0]!.id, materialId: m[0]!.id, uploadToken };
}

export async function loginAs(
  h: Harness,
  roles: Array<{ role: string; scopeKind?: string; scopeId?: string }>,
  opts: { officeId?: string } = {},
): Promise<SeededUser & { token: string }> {
  const user = await seedUser(h, { roles });
  if (opts.officeId) await h.pool.query(`UPDATE users SET office_id = $2 WHERE id = $1`, [user.id, opts.officeId]);
  const { default: request } = await import('supertest');
  const res = await request(h.app.getHttpServer()).post('/v1/auth/login').send({ email: user.email, password: user.password });
  if (res.status !== 200) throw new Error(`login failed: ${res.status}`);
  return { ...user, token: res.body.access_token };
}

export async function currentFormVersion(h: Harness): Promise<number> {
  const { rows } = await h.pool.query<{ v: number | null }>(`SELECT max(version) AS v FROM upload_forms`);
  return rows[0]!.v ?? 0;
}
