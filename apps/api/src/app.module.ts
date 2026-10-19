import { type DynamicModule, type INestApplication, Module, RequestMethod } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import type { Logger } from 'pino';
import { APP_CONFIG, type AppConfig, blockListOf } from './config/config';
import { internalOnly } from './common/internal-only';
import { ErrorFilter } from './common/error.filter';
import { LOGGER, requestLogging } from './common/logger';
import { DatabaseModule } from './database/database.module';
import { HealthController } from './health/health.controller';
import { IdempotencyInterceptor } from './idempotency/idempotency.interceptor';
import { IdentityModule } from './identity/identity.module';
import { OutboxModule } from './outbox/outbox.module';
import { UploadsModule } from './uploads/uploads.module';
import { FormsModule } from './forms/forms.module';
import { MaterialsModule } from './materials/materials.module';

@Module({})
export class AppModule {
  static forRoot(config: AppConfig, logger: Logger): DynamicModule {
    return {
      module: AppModule,
      global: true,
      imports: [DatabaseModule, IdentityModule, OutboxModule, UploadsModule, FormsModule, MaterialsModule],
      controllers: [HealthController],
      providers: [
        { provide: APP_CONFIG, useValue: config },
        { provide: LOGGER, useValue: logger },
        { provide: APP_FILTER, useClass: ErrorFilter },
        { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor },
      ],
      exports: [APP_CONFIG, LOGGER],
    };
  }
}

/** إعداد مشترك بين التشغيل والاختبارات: البادئة /v1، والاستثناءات خارجها، وسجل الطلبات. */
export function configureApp(app: INestApplication, config: AppConfig, logger: Logger): void {
  const express = app.getHttpAdapter().getInstance() as { disable(name: string): void; set(name: string, value: unknown): void };
  express.disable('x-powered-by');
  // X-Forwarded-For يُقبل من الوكلاء الموثوقين وحدهم (نطاقات Cloudflare)؛ وإلا req.ip = عنوان المقبس
  express.set('trust proxy', config.TRUSTED_PROXY_CIDRS.length > 0 ? config.TRUSTED_PROXY_CIDRS : false);
  app.use(requestLogging(logger));
  app.use('/internal', internalOnly(blockListOf(config.INTERNAL_ALLOWED_CIDRS)));
  app.setGlobalPrefix('v1', {
    exclude: [
      { path: 'health', method: RequestMethod.GET },
      { path: 'internal/tusd-hooks/:hook_token', method: RequestMethod.POST },
    ],
  });
  app.enableShutdownHooks();
}
