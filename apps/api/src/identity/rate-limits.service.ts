import { Inject, Injectable } from '@nestjs/common';
import type Redis from 'ioredis';
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

  private healthReporter(): { degraded(err: unknown): void; recovered(): void } {
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
        this.logger.warn({ err_name: (err as Error)?.name }, 'rate limiter degraded to in-memory');
        void audit('rate_limiter.degraded');
      },
      recovered: () => {
        if (!degraded) return;
        degraded = false;
        this.logger.info('rate limiter recovered (redis)');
        void audit('rate_limiter.recovered');
      },
    };
  }
}
