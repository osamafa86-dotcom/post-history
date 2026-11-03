import { Inject, Injectable } from '@nestjs/common';
import { and, count, desc, eq, inArray } from 'drizzle-orm';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { componentSchema } from '../common/contract';
import { ApiError } from '../common/errors';
import { DB, type Database, type Executor } from '../database/database.module';
import { materialFiles, materialRenders } from '../database/schema/schema';
import type { components } from '../generated/api';
import { hasRole, type Principal } from '../identity/principal';
import { writeOutboxEvent } from '../outbox/outbox';
import { findScoped, iso, type MaterialRow, roleCovers } from './material-store';
import { APPROVED_STATES, PRODUCTION_VISIBLE_STATES } from './transitions';

type MaterialRender = components['schemas']['MaterialRender'];
type RenderRequest = components['schemas']['MaterialRenderRequest'];

// ثلاث نسخ غير منتهية على الأكثر للمادة الواحدة (ADR 0091 البند 2)
const MAX_UNFINISHED = 3;
const UNFINISHED = ['requested', 'rendering'];
// المكان يُرسم في كبسولة واحدة: 44 نقطة ترميز مقيسة على إطارات القالب (MaterialRender.location_text في العقد)
const LOCATION_MAX = 44;
const BLOCKED_RIGHTS: readonly string[] = ['blocked', 'withdrawn'];

/**
 * من يطلب النسخة ويقرؤها وينزّلها: أدوار الطلب ضمن نطاقها (x-roles على POST /materials/{id}/renders). رئيس التحرير كل
 * المواد، والمشرف ما يغطيه نطاقه، والإنتاج ما يراه. غيرهم 404 بلا تفريق عن المادة المفقودة.
 */
export function canRequestRender(p: Principal, m: MaterialRow): boolean {
  return (
    hasRole(p, 'editor_in_chief') ||
    roleCovers(p, 'supervisor', m) ||
    (hasRole(p, 'producer') && (PRODUCTION_VISIBLE_STATES as readonly string[]).includes(m.editorialState))
  );
}

/** شرطا النسخة التحريري والحقوقي (البند 2)؛ يرثهما المشتق فيسقط رابطه بسقوطهما. الحساسية لا تمنع. */
export function renderStateFailures(m: MaterialRow): string[] {
  const failed: string[] = [];
  if (!(APPROVED_STATES as readonly string[]).includes(m.editorialState)) failed.push('editorial_state');
  if (BLOCKED_RIGHTS.includes(m.rightsState)) failed.push('rights_state');
  return failed;
}

export const renderNotAllowed = (failed: string[], extra: Record<string, unknown> = {}) =>
  new ApiError(409, 'render_not_allowed', 'The material does not meet the render conditions.', { failed, ...extra });

let locationRule: RegExp | undefined;

/**
 * «المدينة، المحافظة» من حقلي المادة وحدهما (والمدينة وحدها إن ساوت المحافظة)، ولا يُقرأ gps أبدًا. قاعدة النص قاعدة
 * سطر العنوان نفسها من العقد (RenderTitleLine)، والطول بنقاط الترميز. ما لا يصلح null.
 */
export function renderLocation(city: string, governorate: string): string | null {
  const text = city === governorate ? city : `${city}، ${governorate}`;
  locationRule ??= new RegExp(componentSchema('RenderTitleLine').pattern as string, 'u');
  return [...text].length <= LOCATION_MAX && locationRule.test(text) ? text : null;
}

/**
 * نسخ المادة على قالب «مواد متداولة» (ADR 0091): طلب واحد لا محرر. صف النسخة وحدث render.requested بالمعرّفات وحدها في
 * معاملة واحدة، والعنوان والمكان لا يدخلان حدثًا ولا سجلًا. الحالات الثلاث للمادة وإصدارها لا تتغيّر.
 */
@Injectable()
export class RendersService {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async list(p: Principal, materialId: string, limit = 20): Promise<MaterialRender[]> {
    const m = await findScoped(this.db, p, materialId);
    if (!m || !canRequestRender(p, m)) throw ApiError.notFound();
    const rows = await this.db
      .select()
      .from(materialRenders)
      .where(eq(materialRenders.materialId, materialId))
      .orderBy(desc(materialRenders.requestedAt), desc(materialRenders.id))
      .limit(limit);
    return rows.map(toDto);
  }

  async request(p: Principal, materialId: string, body: RenderRequest): Promise<MaterialRender> {
    return this.db.transaction(async (tx) => {
      // قفل صف المادة يسلسل الطلبات المتزامنة عليها، فيرى العدّ بعده كل نسخة ثُبّتت قبله (حدّ الطابور)
      const m = await findScoped(tx, p, materialId, { forUpdate: true });
      if (!m || !canRequestRender(p, m)) throw ApiError.notFound();

      const max = this.config.MEDIA_RENDER_MAX_SOURCE_MS;
      const source = await verifiedOriginal(tx, materialId);
      const usable = source && typeof (source.technical as Record<string, unknown> | null)?.video_codec === 'string' && source.durationMs !== null;
      const tooLong = Boolean(usable && source!.durationMs! > max);
      const failed = [...(!usable || tooLong ? ['source'] : []), ...renderStateFailures(m)];
      if (failed.length > 0) throw renderNotAllowed(failed, tooLong ? { max_source_duration_ms: max } : {});

      const locationText = body.show_location ? renderLocation(m.city, m.governorate) : null;
      if (body.show_location && locationText === null) {
        throw new ApiError(422, 'render_location_unusable', 'The material location cannot be drawn; turn it off or correct the city and governorate.');
      }

      const [{ n }] = (await tx
        .select({ n: count() })
        .from(materialRenders)
        .where(and(eq(materialRenders.materialId, materialId), inArray(materialRenders.state, UNFINISHED)))) as [{ n: number }];
      if (n >= MAX_UNFINISHED) throw new ApiError(409, 'render_limit_reached', 'This material already has the maximum number of renders in progress.');

      const [row] = await tx
        .insert(materialRenders)
        .values({
          materialId,
          materialVersion: m.version,
          sourceFileId: source!.id,
          template: body.template,
          aspect: body.aspect,
          titleLines: body.title_lines,
          locationText,
          label: body.label,
          requestedBy: p.userId,
        })
        .returning();
      await writeOutboxEvent(tx, {
        type: 'render.requested',
        aggregateType: 'material',
        aggregateId: materialId,
        idempotencyKey: `render.requested:${row!.id}`,
        actorId: p.userId,
        payload: { material_id: materialId, render_id: row!.id, source_file_id: source!.id, requested_by: p.userId },
      });
      return toDto(row!);
    });
  }
}

/** أصل المادة المتحقق (واحد لكل مادة، ADR 0081؛ الأحدث إن تعدد) بما يلزم شرط المصدر. */
async function verifiedOriginal(executor: Executor, materialId: string) {
  const [f] = await executor
    .select({ id: materialFiles.id, durationMs: materialFiles.durationMs, technical: materialFiles.technical })
    .from(materialFiles)
    .where(and(eq(materialFiles.materialId, materialId), eq(materialFiles.kind, 'original'), eq(materialFiles.state, 'verified')))
    .orderBy(desc(materialFiles.verifiedAt), desc(materialFiles.id))
    .limit(1);
  return f;
}

function toDto(r: typeof materialRenders.$inferSelect): MaterialRender {
  return {
    id: r.id,
    material_id: r.materialId,
    material_version: r.materialVersion,
    source_file_id: r.sourceFileId,
    template: r.template as MaterialRender['template'],
    aspect: r.aspect as MaterialRender['aspect'],
    title_lines: r.titleLines,
    show_location: r.locationText !== null,
    location_text: r.locationText,
    label: r.label as MaterialRender['label'],
    state: r.state as MaterialRender['state'],
    file_id: r.fileId,
    failure_reason: r.failureReason as MaterialRender['failure_reason'],
    requested_by: r.requestedBy,
    requested_at: iso(r.requestedAt)!,
    started_at: iso(r.startedAt),
    completed_at: iso(r.completedAt),
  };
}
