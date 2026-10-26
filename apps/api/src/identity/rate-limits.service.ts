import { Inject, Injectable } from '@nestjs/common';
import type Redis from 'ioredis';
import { createHmac } from 'node:crypto';
import type { Logger } from 'pino';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { LOGGER } from '../common/logger';
import { REDIS } from '../common/redis.module';
import { DB, type Database } from '../database/database.module';
import { auditLog } from '../database/schema/schema';
import { MemoryRateLimiter, type RateLimiter, rateLimitKeyMaterial, RedisRateLimiter, ResilientRateLimiter } from './rate-limiter';

/**
 * يصنع محدّدات المعدل لمسارات الهوية (الدخول، الاستعادة): Redis مشترك بين النسخ، وعند تعطله احتياط في الذاكرة
 * بالحدود نفسها لا fail-open (قرار المنسّق؛ ADR 0005). كل المحدّدات تتشارك حالة صحة واحدة فتُبلَّغ نوبة التعطل مرة.
 */
@Injectable()
export class RateLimitsService {
  private readonly keyMaterial: Buffer;
  private readonly health: { degraded(err: unknown): void; recovered(): void };

  constructor(
    @Inject(REDIS) private readonly redis: Redis | null,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(DB) private readonly db: Database,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {
    this.keyMaterial = rateLimitKeyMaterial(config.JWT_SECRET);
    this.health = this.healthReporter();
  }

  create(name: string, max: number): RateLimiter {
    const windowMs = this.config.LOGIN_RATE_LIMIT_WINDOW_SECONDS * 1000;
    return this.redis
      ? new ResilientRateLimiter(
          new RedisRateLimiter(this.redis, name, max, windowMs, this.keyMaterial),
          new MemoryRateLimiter(max, windowMs),
          this.health,
        )
      : new MemoryRateLimiter(max, windowMs);
  }

  private readonly used = new Map<string, number>();

  /**
   * أول استعمال لمفتاح خلال ttlMs: true مرة واحدة ثم false حتى تنقضي المدة (رمز TOTP لا يُعاد في نافذته). المفتاح
   * HMAC كمفاتيح الحد، وفي Redis بـ SET NX مشتركًا بين النسخ، وفي ذاكرة النسخة إن تعطل Redis.
   */
  async firstUse(name: string, raw: string, ttlMs: number): Promise<boolean> {
    const key = `once:${name}:${createHmac('sha256', this.keyMaterial).update(raw).digest('hex')}`;
    if (this.redis) {
      try {
        return (await this.redis.set(key, '1', 'PX', ttlMs, 'NX')) === 'OK';
      } catch (err) {
        this.health.degraded(err);
      }
    }
    const now = Date.now();
    for (const [k, until] of this.used) if (until <= now) this.used.delete(k);
    if ((this.used.get(key) ?? 0) > now) return false;
    this.used.set(key, now + ttlMs);
    return true;
  }

  /** حال حد المعدل لـ /health (عقد v0.1): redis، أو degraded حين يعمل في ذاكرة العملية (Redis معطل أو غير مضبوط). */
  mode(): 'redis' | 'degraded' {
    return this.redis && !this.degradedNow ? 'redis' : 'degraded';
  }

  private degradedNow = false;

  private healthReporter(): { degraded(err: unknown): void; recovered(): void } {
    const audit = (action: string) =>
      this.db
        .insert(auditLog)
        .values({ action, targetType: 'system', details: { reason_code: 'redis_unavailable' }, hash: Buffer.alloc(32) })
        .catch((err: unknown) => this.logger.error({ err_name: (err as Error)?.name }, 'audit write failed'));
    return {
      degraded: (err) => {
        if (this.degradedNow) return;
        this.degradedNow = true;
        this.logger.warn({ err_name: (err as Error)?.name }, 'rate limiter degraded to in-memory');
        void audit('rate_limiter.degraded');
      },
      recovered: () => {
        if (!this.degradedNow) return;
        this.degradedNow = false;
        this.logger.info('rate limiter recovered (redis)');
        void audit('rate_limiter.recovered');
      },
    };
  }
}
