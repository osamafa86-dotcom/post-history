import { Inject, Injectable } from '@nestjs/common';
import { hash as argon2Hash, verify as argon2Verify } from '@node-rs/argon2';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { decryptField, randomToken, verifyTotp } from '../common/crypto';
import { ApiError } from '../common/errors';
import { DB, type Database } from '../database/database.module';
import { userPermissions, userRoles, users } from '../database/schema/schema';
import type { components } from '../generated/api';
import type Redis from 'ioredis';
import type { Logger } from 'pino';
import { LOGGER } from '../common/logger';
import { REDIS } from '../common/redis.module';
import { MemoryRateLimiter, rateLimitKeyMaterial, RedisRateLimiter, ResilientRateLimiter, type RateLimiter } from './rate-limiter';
import { auditLog } from '../database/schema/schema';
import { SessionService } from './session.service';

type Session = components['schemas']['Session'];
type Me = components['schemas']['Me'];
type Role = components['schemas']['Role'];
type LoginRequest = components['schemas']['LoginRequest'];

@Injectable()
export class AuthService {
  // المحاولات الفاشلة لكل (بريد، عنوان)، ولكل عنوان بحد أعلى ضد رش كلمات المرور على حسابات كثيرة
  private readonly byIp: RateLimiter;
  private readonly byEmailIp: RateLimiter;
  private readonly fieldKey: Buffer;
  // يُتحقق منه عند غياب المستخدم حتى لا يكشف زمن الاستجابة وجود البريد
  private readonly dummyHash: Promise<string>;

  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(APP_CONFIG) config: AppConfig,
    private readonly sessions: SessionService,
    @Inject(REDIS) redis: Redis | null,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {
    const windowMs = config.LOGIN_RATE_LIMIT_WINDOW_SECONDS * 1000;
    // الحدّان يتشاركان حالة صحة Redis: نوبة التعطل تُبلَّغ مرة واحدة
    const health = this.limiterHealth();
    const keyMaterial = rateLimitKeyMaterial(config.JWT_SECRET);
    const limiter = (name: string, max: number): RateLimiter =>
      redis
        ? new ResilientRateLimiter(new RedisRateLimiter(redis, name, max, windowMs, keyMaterial), new MemoryRateLimiter(max, windowMs), health)
        : new MemoryRateLimiter(max, windowMs);
    this.byIp = limiter('login-ip', config.LOGIN_RATE_LIMIT_IP_MAX);
    this.byEmailIp = limiter('login-email-ip', config.LOGIN_RATE_LIMIT_MAX);
    this.fieldKey = Buffer.from(config.FIELD_ENCRYPTION_KEY, 'base64');
    this.dummyHash = argon2Hash(randomToken());
  }

  async login(body: LoginRequest, ip: string): Promise<Session> {
    const email = body.email.trim().toLowerCase();
    const ipKey = ip;
    const pairKey = `${email}|${ip}`;
    const wait = Math.max(await this.byIp.retryAfter(ipKey), await this.byEmailIp.retryAfter(pairKey));
    if (wait > 0) {
      throw new ApiError(429, 'rate_limited', 'Too many attempts.', undefined, { 'Retry-After': String(wait) });
    }

    const [user] = await this.db
      .select({
        id: users.id,
        passwordHash: users.passwordHash,
        status: users.status,
        totpEnabled: users.totpEnabled,
        totpSecretEnc: users.totpSecretEnc,
      })
      .from(users)
      .where(sql`lower(${users.email}) = ${email}`);

    const fail = async (): Promise<never> => {
      await Promise.all([this.byIp.record(ipKey), this.byEmailIp.record(pairKey)]);
      throw ApiError.unauthorized();
    };

    const passwordOk = await argon2Verify(user?.passwordHash ?? (await this.dummyHash), body.password).catch(() => false);
    if (!user || !passwordOk || user.status !== 'active') await fail();

    if (user!.totpEnabled) {
      // غياب الرمز بعد كلمة مرور صحيحة ليس تخمينًا فلا يُعد فشلًا
      if (!body.totp_code) throw new ApiError(401, 'totp_required', 'TOTP code required.');
      const secret = decryptField(this.fieldKey, user!.totpSecretEnc!);
      if (!verifyTotp(secret, body.totp_code)) await fail();
    }
    await this.byEmailIp.reset(pairKey);

    return this.db.transaction(async (tx) => {
      const issued = await this.sessions.issue(tx, user!.id);
      await tx.update(users).set({ lastLoginAt: sql`now()` }).where(eq(users.id, user!.id));
      return {
        access_token: issued.accessToken,
        refresh_token: issued.refreshToken,
        expires_at: issued.accessExpiresAt.toISOString(),
        user_id: user!.id,
        roles: await this.roles(user!.id),
      };
    });
  }

  /**
   * Redis معطّل لا يُسقط حد الدخول: يتراجع إلى الذاكرة بالحدود نفسها لكل نسخة، مع تحذير في السجل وصف في
   * سجل التدقيق عند بدء النوبة وعند العودة إلى Redis (قرار المنسّق؛ ADR 0005).
   */
  private limiterHealth(): { degraded(err: unknown): void; recovered(): void } {
    let degraded = false;
    const audit = (action: string) =>
      this.db
        .insert(auditLog)
        .values({ action, targetType: 'system', details: { reason_code: 'redis_unavailable' }, hash: Buffer.alloc(32) })
        .catch((err: unknown) => this.logger.error({ err_name: (err as Error)?.name }, 'audit write failed'));
    return {
      degraded: (err) => {
        if (degraded) return;
        degraded = true;
        this.logger.warn({ err_name: (err as Error)?.name }, 'login rate limiter degraded to in-memory');
        void audit('rate_limiter.degraded');
      },
      recovered: () => {
        if (!degraded) return;
        degraded = false;
        this.logger.info('login rate limiter recovered (redis)');
        void audit('rate_limiter.recovered');
      },
    };
  }

  async refresh(refreshToken: string): Promise<Session> {
    const issued = await this.sessions.refresh(refreshToken);
    if (!issued) throw ApiError.unauthorized();
    return {
      access_token: issued.accessToken,
      refresh_token: issued.refreshToken,
      expires_at: issued.accessExpiresAt.toISOString(),
      user_id: issued.userId,
      roles: await this.roles(issued.userId),
    };
  }

  async logout(userId: string, sessionId: string, allSessions: boolean): Promise<void> {
    await this.db.transaction(async (tx) => {
      if (allSessions) await this.sessions.revokeAll(tx, userId);
      else await this.sessions.revokeChain(tx, sessionId);
    });
  }

  async me(userId: string): Promise<Me> {
    const [user] = await this.db
      .select({ id: users.id, email: users.email, officeId: users.officeId, totpEnabled: users.totpEnabled })
      .from(users)
      .where(eq(users.id, userId));
    if (!user) throw ApiError.unauthorized();
    const perms = await this.db
      .select({ permission: userPermissions.permission })
      .from(userPermissions)
      .where(and(eq(userPermissions.userId, userId), isNull(userPermissions.revokedAt)));
    return {
      user_id: user.id,
      email: user.email,
      office_id: user.officeId,
      totp_enabled: user.totpEnabled,
      roles: await this.roles(userId),
      permissions: perms.map((p) => p.permission as Me['permissions'][number]),
    };
  }

  private async roles(userId: string): Promise<Role[]> {
    const rows = await this.db
      .select({ role: userRoles.role, scopeKind: userRoles.scopeKind, scopeId: userRoles.scopeId })
      .from(userRoles)
      .where(eq(userRoles.userId, userId))
      .orderBy(userRoles.role, userRoles.scopeKind, userRoles.scopeId);
    const byName = new Map<string, Role>();
    for (const r of rows) {
      const role = byName.get(r.role) ?? { name: r.role as Role['name'], scopes: [] };
      byName.set(r.role, role);
      if (r.scopeKind !== 'all') role.scopes.push({ kind: r.scopeKind as 'office' | 'governorate', id: r.scopeId });
    }
    // دور بنطاق 'all' يرى كل شيء: قائمة نطاقات فارغة (العقد)
    for (const r of rows) if (r.scopeKind === 'all') byName.get(r.role)!.scopes = [];
    return [...byName.values()];
  }
}
