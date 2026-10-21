import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DB, type Database, type Executor } from '../database/database.module';
import { auditLog, systemSettings } from '../database/schema/schema';
import type { components } from '../generated/api';
import type { Permission } from '../identity/principal';
import { writeOutboxEvent } from '../outbox/outbox';

type Access = components['schemas']['ReporterIdentityAccess'];
type Setting = components['schemas']['ReporterIdentitySetting'];
type Update = components['schemas']['ReporterIdentitySettingUpdate'];

const KEY = 'reporter_legal_name_access';
/** نسخ الخادم الأخرى ترى التغيير خلال هذه المدة على الأكثر؛ النسخة التي غيّرته تراه فورًا. */
const CACHE_MS = 5000;

/** الصلاحية التي تكشف الاسم الحقيقي للمراسل بحسب الإعداد (ADR 0021). */
export function legalNamePermission(access: Access): Permission {
  return access === 'protected_source' ? 'protected_source:read' : 'reporter_identity:read';
}

/**
 * إعداد `reporter_legal_name_access` (ADR 0021): يُقرأ في كل استجابة مادة، فيُخزَّن مؤقتًا ≤ 5 ث ويُبطَل عند التغيير.
 * التغيير في معاملة واحدة: الصف، ثم التدقيق (`setting`، `value`، `reason_code`)، ثم حدث `setting.changed` يُبلَّغ به مديرو
 * النظام. القيمة نفسها مرة ثانية لا تكتب شيئًا.
 */
@Injectable()
export class ReporterIdentitySettings {
  private cached: { access: Access; at: number } | undefined;

  constructor(@Inject(DB) private readonly db: Database) {}

  async access(executor: Executor = this.db): Promise<Access> {
    if (this.cached && Date.now() - this.cached.at < CACHE_MS) return this.cached.access;
    const access = (await this.row(executor)).access;
    this.cached = { access, at: Date.now() };
    return access;
  }

  get(): Promise<Setting> {
    return this.row(this.db);
  }

  async update(actorId: string, input: Update): Promise<Setting> {
    const result = await this.db.transaction(async (tx) => {
      const [current] = await tx.select().from(systemSettings).where(eq(systemSettings.key, KEY)).for('update');
      if (current && current.value === input.access) return toSetting(current);
      const [row] = await tx
        .update(systemSettings)
        .set({ value: input.access, updatedBy: actorId })
        .where(eq(systemSettings.key, KEY))
        .returning();
      // الهدف هو الإعداد نفسه (فهرس الهدف يغطي سجل تغييراته)، كما في ADR 0021
      await tx.insert(auditLog).values({
        actorId,
        action: 'setting.changed',
        targetType: 'setting',
        targetId: KEY,
        details: { setting: KEY, value: input.access, reason_code: input.reason_code },
        hash: Buffer.alloc(32), // يحسبه محفّز سلسلة التجزئة
      });
      const occurredAt = new Date(row!.updatedAt).toISOString();
      await writeOutboxEvent(tx, {
        type: 'setting.changed',
        aggregateType: 'user',
        aggregateId: actorId,
        idempotencyKey: `setting.changed:${KEY}:${occurredAt}`,
        actorId,
        payload: { setting: KEY, value: input.access, actor_id: actorId, reason_code: input.reason_code, occurred_at: occurredAt },
      });
      return toSetting(row!);
    });
    this.cached = undefined;
    return result;
  }

  private async row(executor: Executor): Promise<Setting> {
    const [row] = await executor.select().from(systemSettings).where(eq(systemSettings.key, KEY));
    // الترحيل يبذر الصف؛ غيابه يعني الأضيق
    return row ? toSetting(row) : { access: 'separate', updated_at: new Date(0).toISOString(), updated_by: null };
  }
}

function toSetting(row: typeof systemSettings.$inferSelect): Setting {
  return { access: row.value as Access, updated_at: new Date(row.updatedAt).toISOString(), updated_by: row.updatedBy };
}
