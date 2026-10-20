import { Inject, Injectable } from '@nestjs/common';
import { and, asc, count, desc, eq, isNotNull, isNull, notInArray, sql } from 'drizzle-orm';
import { DB, type Database } from '../database/database.module';
import { materialFiles, materials, notifications, offices } from '../database/schema/schema';
import type { components } from '../generated/api';
import type { Principal } from '../identity/principal';
import { iso, scopeCondition } from '../materials/material-store';

type NewsroomDashboard = components['schemas']['NewsroomDashboard'];
type Counts = NewsroomDashboard['editorial'];

/**
 * لوحة غرفة الأخبار (عقد v0.2): لقطة مجمّعة ضمن نطاق المستدعي (الشرط نفسه في طبقة الاستعلام). معرّفات وأرقام
 * وحالات فقط: لا عنوان ولا اسم ولا موقع ولا حقل ديناميكي.
 */
@Injectable()
export class DashboardService {
  constructor(@Inject(DB) private readonly db: Database) {}

  async newsroom(p: Principal): Promise<NewsroomDashboard> {
    const scope = scopeCondition(p);
    const counts = async (column: typeof materials.editorialState | typeof materials.technicalState | typeof materials.rightsState): Promise<Counts> =>
      (
        await this.db
          .select({ state: sql<string>`${column}`, count: count() })
          .from(materials)
          .leftJoin(offices, eq(offices.id, materials.officeId))
          .where(scope)
          .groupBy(column)
          .orderBy(asc(column))
      ).map((r) => ({ state: r.state, count: r.count }));

    const [urgent] = await this.db
      .select({ n: count() })
      .from(materials)
      .leftJoin(offices, eq(offices.id, materials.officeId))
      .where(and(scope, eq(materials.priority, 'urgent'), notInArray(materials.editorialState, ['published', 'rejected'])));
    const reserved = await this.db
      .select({
        material_id: materials.id,
        reserved_by: materials.reservedBy,
        reserved_at: materials.reservedAt,
        priority: materials.priority,
        editorial_state: materials.editorialState,
      })
      .from(materials)
      .leftJoin(offices, eq(offices.id, materials.officeId))
      .where(and(scope, isNotNull(materials.reservedBy)))
      .orderBy(asc(materials.reservedAt))
      .limit(50);
    const receipts = await this.db
      .select({
        material_id: materialFiles.materialId,
        receipt_number: materialFiles.receiptNumber,
        verified_at: materialFiles.verifiedAt,
        priority: materials.priority,
      })
      .from(materialFiles)
      .innerJoin(materials, eq(materials.id, materialFiles.materialId))
      .leftJoin(offices, eq(offices.id, materials.officeId))
      .where(and(scope, isNotNull(materialFiles.receiptNumber), isNotNull(materialFiles.verifiedAt)))
      .orderBy(desc(materialFiles.verifiedAt))
      .limit(20);
    // مهام حان تصعيدها (أو صُعِّدت) ولم يُقرّ استلامها، لمواد ضمن النطاق
    const [overdue] = await this.db
      .select({ n: count() })
      .from(notifications)
      .innerJoin(materials, eq(materials.id, notifications.materialId))
      .leftJoin(offices, eq(offices.id, materials.officeId))
      .where(
        and(
          scope,
          eq(notifications.assignmentState, 'assigned'),
          isNull(notifications.acknowledgedAt),
          sql`(${notifications.escalationLevel} > 0 OR ${notifications.escalateAt} <= now())`,
        ),
      );

    return {
      generated_at: new Date().toISOString(),
      editorial: await counts(materials.editorialState),
      technical: await counts(materials.technicalState),
      rights: await counts(materials.rightsState),
      urgent_open: urgent?.n ?? 0,
      reserved: reserved.map((r) => ({
        material_id: r.material_id,
        reserved_by: r.reserved_by!,
        reserved_at: iso(r.reserved_at)!,
        priority: r.priority as NewsroomDashboard['reserved'][number]['priority'],
        editorial_state: r.editorial_state as NewsroomDashboard['reserved'][number]['editorial_state'],
      })),
      recent_receipts: receipts.map((r) => ({
        material_id: r.material_id,
        receipt_number: r.receipt_number!,
        verified_at: iso(r.verified_at)!,
        priority: r.priority as NewsroomDashboard['recent_receipts'][number]['priority'],
      })),
      overdue_acknowledgements: overdue?.n ?? 0,
    };
  }
}
