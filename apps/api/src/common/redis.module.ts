import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import Redis from 'ioredis';
import type { Logger } from 'pino';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { LOGGER } from './logger';

export const REDIS = Symbol('REDIS');

@Global()
@Module({
  providers: [
    {
      provide: REDIS,
      inject: [APP_CONFIG, LOGGER],
      // أوامر لا تنتظر Redis معطّلًا: تفشل فورًا ويتراجع المستدعي إلى احتياطه
      useFactory: (config: AppConfig, logger: Logger): Redis | null => {
        if (!config.REDIS_URL) {
          logger.warn('REDIS_URL is not set: login rate limits are per instance (not allowed in production)');
          return null;
        }
        const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: 1, enableOfflineQueue: false });
        let lastLog = 0;
        redis.on('error', (err: Error) => {
          // محاولات إعادة الاتصال تتكرر؛ سطر واحد في الدقيقة يكفي
          if (Date.now() - lastLog < 60_000) return;
          lastLog = Date.now();
          logger.warn({ err_name: err.name }, 'redis connection error');
        });
        return redis;
      },
    },
  ],
  exports: [REDIS],
})
export class RedisModule implements OnApplicationShutdown {
  constructor(@Inject(REDIS) private readonly redis: Redis | null) {}

  async onApplicationShutdown(): Promise<void> {
    await this.redis?.quit().catch(() => this.redis?.disconnect());
  }
}
