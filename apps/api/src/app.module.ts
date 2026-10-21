import { type DynamicModule, type INestApplication, Module, RequestMethod } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import type { Logger } from 'pino';
import { APP_CONFIG, type AppConfig, blockListOf } from './config/config';
import { internalOnly } from './common/internal-only';
import { EtagInterceptor } from './common/preconditions';
import { ErrorFilter } from './common/error.filter';
import { LOGGER, requestLogging } from './common/logger';
import { DatabaseModule } from './database/database.module';
import { RedisModule } from './common/redis.module';
import { HealthController } from './health/health.controller';
import { IdempotencyInterceptor } from './idempotency/idempotency.interceptor';
import { IdentityModule } from './identity/identity.module';
import { OutboxModule } from './outbox/outbox.module';
import { UploadsModule } from './uploads/uploads.module';
import { FormsModule } from './forms/forms.module';
import { MaterialsModule } from './materials/materials.module';
import { NotificationsModule } from './notifications/notifications.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { EventsModule } from './events/events.module';
import { PushDevicesModule } from './push-devices/push-devices.module';
import { VerificationModule } from './verification/verification.module';
import { AttestationModule } from './attestation/attestation.module';
import { MediaModule } from './media/media.module';
import { PushModule } from './push/push.module';
import { PermissionsModule } from './permissions/permissions.module';
import { SettingsModule } from './settings/settings.module';

@Module({})
export class AppModule {
  static forRoot(config: AppConfig, logger: Logger): DynamicModule {
    return {
      module: AppModule,
      global: true,
      imports: [DatabaseModule, RedisModule, IdentityModule, OutboxModule, UploadsModule, FormsModule, MaterialsModule, NotificationsModule, EventsModule, PushDevicesModule, VerificationModule, PermissionsModule, MediaModule, AttestationModule, PushModule, DashboardModule, SettingsModule],
      controllers: [HealthController],
      providers: [
        { provide: APP_CONFIG, useValue: config },
        { provide: LOGGER, useValue: logger },
        { provide: APP_FILTER, useClass: ErrorFilter },
        { provide: APP_INTERCEPTOR, useClass: EtagInterceptor },
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
  // لا ETag تلقائي ضعيف: ETag الوحيد هو row_version للمادة (If-Match، عقد v0.1)، فلا يخلط العميل بينهما
  express.set('etag', false);
  // X-Forwarded-For يُقبل من الوكلاء الموثوقين وحدهم (نطاقات Cloudflare)؛ وإلا req.ip = عنوان المقبس
  express.set('trust proxy', config.TRUSTED_PROXY_CIDRS.length > 0 ? config.TRUSTED_PROXY_CIDRS : false);
  app.use(requestLogging(logger));
  // كل استجابة من /v1 لا تُخزَّن في ذاكرة مؤقتة (متصفح أو وكيل أو حافة): فيها بيانات مصادَق عليها أو رموز
  app.use('/v1', (_req: unknown, res: { setHeader(name: string, value: string): void }, next: () => void) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.use('/internal', internalOnly(blockListOf(config.INTERNAL_ALLOWED_CIDRS), config.INTERNAL_SOURCE_PATHS));
  app.setGlobalPrefix('v1', {
    exclude: [
      { path: 'health', method: RequestMethod.GET },
      { path: 'internal/tusd-hooks/:hook_token', method: RequestMethod.POST },
      { path: 'internal/media/sessions/:id', method: RequestMethod.GET },
      { path: 'internal/ingest/session-status', method: RequestMethod.GET },
      { path: 'internal/media/sessions/:id/verification', method: RequestMethod.POST },
      { path: 'internal/media/files/:file_id/derivatives', method: RequestMethod.POST },
    ],
  });
  app.enableShutdownHooks();
}
