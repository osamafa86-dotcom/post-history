import { Body, Controller, Delete, HttpCode, Inject, Param, Put, Req } from '@nestjs/common';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Request } from 'express';
import { APP_CONFIG, type AppConfig, fieldKeyring } from '../config/config';
import { validateBody } from '../common/contract';
import type { FieldKeyring } from '../common/crypto';
import { ApiError } from '../common/errors';
import { DB, type Database } from '../database/database.module';
import { pushDevices } from '../database/schema/schema';
import type { components } from '../generated/api';
import { Roles } from '../identity/principal';

/**
 * تسجيل أجهزة الإشعار (تسجيل وإلغاء فقط؛ الإرسال الفعلي لاحقًا). رمز الدفع يُحفظ مشفرًا ولا يُعاد في أي استجابة
 * ولا يدخل أي حمولة. installation_id يولّده التطبيق؛ التثبيت نفسه إن سجّل به مستخدم آخر يُنقل إليه (دخول جديد).
 */
@Controller('push-devices')
export class PushDevicesController {
  private readonly fieldKeys: FieldKeyring;

  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(APP_CONFIG) config: AppConfig,
  ) {
    this.fieldKeys = fieldKeyring(config);
  }

  @Put()
  @HttpCode(204)
  @Roles('authenticated')
  async register(@Body() body: unknown, @Req() req: Request): Promise<void> {
    const input = validateBody<components['schemas']['PushDeviceRegistration']>('/push-devices', 'put', body);
    const values = {
      userId: req.auth!.userId,
      platform: input.platform,
      tokenEnc: this.fieldKeys.encrypt(Buffer.from(input.token, 'utf8')),
      appVersion: input.app_version ?? null,
      revokedAt: null,
    };
    await this.db
      .insert(pushDevices)
      .values({ installationId: input.installation_id, ...values })
      .onConflictDoUpdate({ target: pushDevices.installationId, set: values });
  }

  @Delete(':installation_id')
  @HttpCode(204)
  @Roles('authenticated')
  async unregister(@Param('installation_id') installationId: string, @Req() req: Request): Promise<void> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(installationId)) throw ApiError.notFound();
    const [device] = await this.db
      .select({ revokedAt: pushDevices.revokedAt })
      .from(pushDevices)
      .where(and(eq(pushDevices.installationId, installationId), eq(pushDevices.userId, req.auth!.userId)));
    if (!device) throw ApiError.notFound();
    await this.db
      .update(pushDevices)
      .set({ revokedAt: sql`now()` })
      .where(and(eq(pushDevices.installationId, installationId), isNull(pushDevices.revokedAt)));
  }
}
