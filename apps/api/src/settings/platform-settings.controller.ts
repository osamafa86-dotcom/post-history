import { Body, Controller, Get, Headers, Inject, Injectable, Put, Req, Res } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { Request, Response } from 'express';
import { validateBody } from '../common/contract';
import { assertIfMatch } from '../common/preconditions';
import { DB, type Database, type Tx } from '../database/database.module';
import { auditLog, platformSettings } from '../database/schema/schema';
import type { components } from '../generated/api';
import { Roles } from '../identity/principal';
import { writeOutboxEvent } from '../outbox/outbox';

type PlatformSettings = components['schemas']['PlatformSettings'];
type PlatformSettingsUpdate = components['schemas']['PlatformSettingsUpdate'];
type Row = typeof platformSettings.$inferSelect;
type Field = keyof PlatformSettingsUpdate;

const FIELDS: ReadonlyArray<[Field, 'platformName' | 'appName' | 'watermarkText']> = [
  ['platform_name', 'platformName'],
  ['app_name', 'appName'],
  ['watermark_text', 'watermarkText'],
];

/** الحقول التي تغيّرت بأسمائها في العقد، بترتيب العقد. */
export function changedFields(current: Pick<Row, 'platformName' | 'appName' | 'watermarkText'>, input: PlatformSettingsUpdate): Field[] {
  return FIELDS.filter(([field, column]) => current[column] !== input[field]).map(([field]) => field);
}

/**
 * هوية المنصة (A6، ADR 0099): صف واحد بإصدار هو `ETag`. التغيير في معاملة واحدة مع حدث `platform_settings.changed` وسطر
 * تدقيق، وكلاهما بالإصدار وأسماء الحقول وحدها، بلا نص. القيم نفسها لا تكتب شيئًا.
 */
@Injectable()
export class PlatformSettingsService {
  constructor(@Inject(DB) private readonly db: Database) {}

  async get(): Promise<PlatformSettings> {
    const [row] = await this.db.select().from(platformSettings).where(eq(platformSettings.id, true));
    return toSettings(row!);
  }

  async replace(actorId: string, input: PlatformSettingsUpdate, ifMatch?: string): Promise<PlatformSettings> {
    return this.db.transaction(async (tx) => {
      const current = await lock(tx);
      assertIfMatch(ifMatch, current.version);
      const changed = changedFields(current, input);
      if (changed.length === 0) return toSettings(current);
      const [saved] = await tx
        .update(platformSettings)
        .set({ platformName: input.platform_name, appName: input.app_name, watermarkText: input.watermark_text, version: current.version + 1, updatedBy: actorId })
        .where(eq(platformSettings.id, true))
        .returning();
      await writeOutboxEvent(tx, {
        type: 'platform_settings.changed',
        aggregateType: 'user',
        aggregateId: actorId,
        idempotencyKey: `platform_settings.changed:${saved!.version}`,
        actorId,
        payload: { settings_version: saved!.version, changed_fields: changed },
      });
      await tx.insert(auditLog).values({
        actorId,
        action: 'platform_settings.changed',
        targetType: 'platform_settings',
        targetId: 'platform_settings',
        details: { settings_version: saved!.version, field_keys: changed },
        hash: Buffer.alloc(32), // يحسبه محفّز سلسلة التجزئة
      });
      return toSettings(saved!);
    });
  }
}

async function lock(tx: Tx): Promise<Row> {
  const [row] = await tx.select().from(platformSettings).where(eq(platformSettings.id, true)).for('update');
  return row!;
}

function toSettings(row: Row): PlatformSettings {
  return {
    platform_name: row.platformName,
    app_name: row.appName,
    watermark_text: row.watermarkText,
    version: row.version,
    updated_at: new Date(row.updatedAt).toISOString(),
  };
}

@Controller('platform-settings')
export class PlatformSettingsController {
  constructor(private readonly settings: PlatformSettingsService) {}

  @Get()
  @Roles('system_admin')
  async get(@Res({ passthrough: true }) res: Response): Promise<PlatformSettings> {
    return etag(res, await this.settings.get());
  }

  @Put()
  @Roles('system_admin')
  async replace(
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Headers('if-match') ifMatch?: string,
  ): Promise<PlatformSettings> {
    const input = validateBody<PlatformSettingsUpdate>('/platform-settings', 'put', body);
    return etag(res, await this.settings.replace(req.principal!.userId, input, ifMatch));
  }
}

function etag(res: Response, settings: PlatformSettings): PlatformSettings {
  res.setHeader('ETag', `"${settings.version}"`);
  return settings;
}
