import { staffWorkName, workNameFor } from '../common/design-fields';
import { Inject, Injectable } from '@nestjs/common';
import { and, asc, count, desc, eq, isNotNull, isNull, notInArray, sql } from 'drizzle-orm';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { DB, type Database } from '../database/database.module';
import { materialFiles, materials, notifications, offices, uploadSessions } from '../database/schema/schema';
import type { components } from '../generated/api';
import type { Principal } from '../identity/principal';
import { iso, scopeCondition } from '../materials/material-store';

type NewsroomDashboard = components['schemas']['NewsroomDashboard'];
type Counts = NewsroomDashboard['editorial'];
type Inflight = NonNullable<NewsroomDashboard['uploads_in_progress']>[number];

/**
 * لوحة غرفة الأخبار (عقد v0.2): لقطة مجمّعة ضمن نطاق المستدعي (الشرط نفسه في طبقة الاستعلام). معرّفات وأرقام
 * وحالات فقط: لا عنوان ولا اسم ولا موقع ولا حقل ديناميكي. اللقطة تُعاد لصاحبها ونطاقه نفسيهما ≤ DASHBOARD_SNAPSHOT_MS
 * (`generated_at` وقت حسابها)، وطلبات متزامنة لمفتاح واحد تنتظر حسابًا واحدًا؛ التحديث الحي من /events.
 */
@Injectable()
export class DashboardService {
  private readonly snapshots = new Map<string, { at: number; value: Promise<NewsroomDashboard> }>();

  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  newsroom(p: Principal): Promise<NewsroomDashboard> {
    const ttl = this.config.DASHBOARD_SNAPSHOT_MS;
    if (ttl === 0) return this.compute(p);
    // المفتاح: المستخدم وأدواره بنطاقاتها، فهما كل ما يحدد النطاق (ومنه ما أنشأه المستخدم نفسه)
    const key = `${p.userId}|${p.roles.map((r) => `${r.role}:${r.scopeKind}:${r.scopeId}`).sort().join(',')}`;
    const now = Date.now();
    const hit = this.snapshots.get(key);
    if (hit && now - hit.at < ttl) return hit.value;
    if (this.snapshots.size > 1000) for (const [k, v] of this.snapshots) if (now - v.at >= ttl) this.snapshots.delete(k);
    const value = this.compute(p);
    this.snapshots.set(key, { at: now, value });
    value.catch(() => this.snapshots.delete(key));
    return value;
  }

  private async compute(p: Principal): Promise<NewsroomDashboard> {
    const scope = scopeCondition(p);
    // الحالات الثلاث والعاجل المفتوح في مسح واحد للمواد ضمن النطاق (GROUPING SETS)، وبقية القراءات بالتوازي معه
    const tallies = this.db.execute<{ editorial: string | null; technical: string | null; rights: string | null; g: number; n: number; urgent: number }>(sql`
      SELECT ${materials.editorialState} AS editorial, ${materials.technicalState} AS technical, ${materials.rightsState} AS rights,
             GROUPING(${materials.editorialState}, ${materials.technicalState}, ${materials.rightsState})::int AS g,
             count(*)::int AS n,
             (count(*) FILTER (WHERE ${materials.priority} = 'urgent' AND ${materials.editorialState} NOT IN ('published', 'rejected')))::int AS urgent
        FROM ${materials} LEFT JOIN ${offices} ON ${offices.id} = ${materials.officeId}
       WHERE ${scope}
       GROUP BY GROUPING SETS ((${materials.editorialState}), (${materials.technicalState}), (${materials.rightsState}), ())`);
    const reservedQuery = this.db
      .select({
        material_id: materials.id,
        reserved_by: materials.reservedBy,
        reserved_by_name: staffWorkName(sql`${materials.reservedBy}`),
        reserved_at: materials.reservedAt,
        priority: materials.priority,
        editorial_state: materials.editorialState,
      })
      .from(materials)
      .leftJoin(offices, eq(offices.id, materials.officeId))
      .where(and(scope, isNotNull(materials.reservedBy)))
      .orderBy(asc(materials.reservedAt))
      .limit(50);
    const receiptsQuery = this.db
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
    const overdueQuery = this.db
      .select({ n: count(), oldest: sql<string | null>`min(${notifications.escalateAt}) FILTER (WHERE ${notifications.escalateAt} <= now())` })
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
    // «الوارد الآن» (ADR 0024): الجلسات الجارية غير المنتهية لمواد ضمن النطاق، العاجل أولًا ثم الأحدث تقدّمًا.
    // معرّفات وأرقام فقط: لا اسم ملف ولا مراسل ولا جهاز
    const inflightQuery = this.db
      .select({
        upload_session_id: uploadSessions.id,
        material_id: uploadSessions.materialId,
        kind: uploadSessions.kind,
        priority: materials.priority,
        state: uploadSessions.state,
        size_bytes: uploadSessions.sizeBytes,
        bytes_received: uploadSessions.bytesReceived,
        updated_at: uploadSessions.updatedAt,
      })
      .from(uploadSessions)
      .innerJoin(materials, eq(materials.id, uploadSessions.materialId))
      .leftJoin(offices, eq(offices.id, materials.officeId))
      .where(and(scope, sql`${uploadSessions.state} IN ('created', 'in_progress')`, sql`${uploadSessions.expiresAt} > now()`))
      .orderBy(sql`(${materials.priority} = 'urgent') DESC`, desc(uploadSessions.updatedAt))
      .limit(50);
    const [{ rows }, reserved, receipts, [overdue], inflight] = await Promise.all([
      tallies,
      reservedQuery,
      receiptsQuery,
      overdueQuery,
      inflightQuery,
    ]);

    // GROUPING: البت 4 = الحالة التحريرية مجمّعة، 2 = الفنية، 1 = الحقوق؛ 7 = المجموع
    const by = (mask: number, pick: (r: (typeof rows)[number]) => string | null): Counts =>
      rows
        .filter((r) => Number(r.g) === mask)
        .map((r) => ({ state: pick(r)!, count: Number(r.n) }))
        .sort((x, y) => (x.state < y.state ? -1 : x.state > y.state ? 1 : 0));
    const total = rows.find((r) => Number(r.g) === 7);

    return {
      generated_at: new Date().toISOString(),
      editorial: by(3, (r) => r.editorial),
      technical: by(5, (r) => r.technical),
      rights: by(6, (r) => r.rights),
      urgent_open: Number(total?.urgent ?? 0),
      reserved: reserved.map((r) => ({
        material_id: r.material_id,
        reserved_by: r.reserved_by!,
        reserved_by_name: workNameFor(p, r.reserved_by_name),
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
      oldest_overdue_acknowledgement_at: iso(overdue?.oldest ?? null),
      uploads_in_progress: inflight.map((u) => ({
        upload_session_id: u.upload_session_id,
        material_id: u.material_id,
        kind: u.kind as Inflight['kind'],
        priority: u.priority as Inflight['priority'],
        state: u.state as Inflight['state'],
        size_bytes: Number(u.size_bytes),
        bytes_received: Number(u.bytes_received),
        updated_at: iso(u.updated_at)!,
      })),
    };
  }
}
