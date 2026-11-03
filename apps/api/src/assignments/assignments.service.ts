import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { pgError } from '../common/db-errors';
import { ApiError } from '../common/errors';
import { DB, type Database, type Executor } from '../database/database.module';
import { auditLog, materialAssignments, materials } from '../database/schema/schema';
import type { components } from '../generated/api';
import type { Principal } from '../identity/principal';
import { findScoped } from '../materials/material-store';
import { PRODUCTION_VISIBLE_STATES } from '../materials/transitions';
import { writeOutboxEvent } from '../outbox/outbox';
import {
  applyAssignmentTransition,
  assignmentSelection,
  type AssignmentState,
  assignmentTransitionOwners,
  type AssignmentView,
  canAssign,
  CLOSED_STATES,
  lockAssignment,
  type MaterialAssignmentDto,
  materialPriority,
  OPEN_STATES,
  readAssignment,
  toAssignmentDto,
} from './assignment-store';

type AssignmentCreate = components['schemas']['MaterialAssignmentCreate'];
type AssignmentTransition = components['schemas']['AssignmentTransition'];
type MyAssignmentPage = components['schemas']['MyAssignmentPage'];
type AssignmentCandidate = components['schemas']['AssignmentCandidate'];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// الموعد في 30 يومًا على الأكثر (MaterialAssignmentCreate.due_at)
const MAX_DUE_MS = 30 * 24 * 3600 * 1000;

/**
 * إسناد المادة إلى المونتير و«مهامي» (ADR 0096). كل كتابة في معاملة واحدة مع حدثها في Outbox وسطر تدقيقها، والملاحظة لا
 * تدخل حدثًا ولا سجلًا. الإسناد لا يغيّر أيًّا من الحالات الثلاث للمادة ولا حجزها.
 */
@Injectable()
export class AssignmentsService {
  constructor(@Inject(DB) private readonly db: Database) {}

  async listForMaterial(p: Principal, materialId: string, limit = 20): Promise<MaterialAssignmentDto[]> {
    const m = await findScoped(this.db, p, materialId);
    if (!m) throw ApiError.notFound();
    const rows = await this.db
      .select(assignmentSelection)
      .from(materialAssignments)
      .innerJoin(materials, eq(materials.id, materialAssignments.materialId))
      .where(eq(materialAssignments.materialId, materialId))
      .orderBy(desc(materialAssignments.createdAt), desc(materialAssignments.id))
      .limit(limit);
    return (rows as AssignmentView[]).map((r) => toAssignmentDto(p, r));
  }

  /** المسنَدة إليه يراها دائمًا؛ وغيره بنطاق رؤيته للمادة، وإلا 404 بلا تفريق عن المفقودة. */
  async get(p: Principal, id: string): Promise<MaterialAssignmentDto> {
    if (!UUID.test(id)) throw ApiError.notFound();
    const a = await readAssignment(this.db, id);
    if (!a || !(await this.visible(this.db, p, a))) throw ApiError.notFound();
    return toAssignmentDto(p, a);
  }

  async assign(p: Principal, materialId: string, body: AssignmentCreate): Promise<MaterialAssignmentDto> {
    const due = Date.parse(body.due_at);
    const now = Date.now();
    if (!(due > now) || due - now > MAX_DUE_MS) throw ApiError.validation({ fields: ['/due_at'] });
    return this.db.transaction(async (tx) => {
      // قفل صف المادة يسلسل الإسنادين المتزامنين عليها، فيرى الثاني مهمة الأول المفتوحة
      const m = await findScoped(tx, p, materialId, { forUpdate: true });
      if (!m || !canAssign(p, m)) throw ApiError.notFound();
      if (!(PRODUCTION_VISIBLE_STATES as readonly string[]).includes(m.editorialState)) {
        throw new ApiError(409, 'assignment_not_allowed', 'Only materials accepted for production can be assigned.', {
          failed: ['editorial_state'],
        });
      }
      if (!(await eligibleAssignee(tx, body.assignee_id))) {
        throw new ApiError(422, 'assignee_not_eligible', 'The assignee must be an active member of the production team.');
      }
      const [open] = await tx
        .select({ id: materialAssignments.id })
        .from(materialAssignments)
        .where(and(eq(materialAssignments.materialId, materialId), inArray(materialAssignments.state, [...OPEN_STATES])));
      if (open) throw assignmentOpen(open.id);

      let id: string;
      try {
        const [row] = await tx
          .insert(materialAssignments)
          .values({ materialId, assigneeId: body.assignee_id, assignedBy: p.userId, dueAt: body.due_at, note: body.note ?? null })
          .returning({ id: materialAssignments.id });
        id = row!.id;
      } catch (err) {
        const e = pgError(err);
        if (e.code === '23505' && e.constraint === 'material_assignments_open_key') throw assignmentOpen(null);
        // الموعد بعد وقت الإنشاء بساعة القاعدة نفسها
        if (e.code === '23514' && e.constraint === 'material_assignments_due_after_created') throw ApiError.validation({ fields: ['/due_at'] });
        throw err;
      }
      await writeOutboxEvent(tx, {
        type: 'assignment.created',
        aggregateType: 'material',
        aggregateId: materialId,
        idempotencyKey: `assignment.created:${id}`,
        actorId: p.userId,
        payload: { material_id: materialId, assignment_id: id, priority: m.priority, assignee_id: body.assignee_id, assigned_by: p.userId },
      });
      await tx.insert(auditLog).values({
        actorId: p.userId,
        action: 'assignment.created',
        targetType: 'material_assignment',
        targetId: id,
        details: { assignment_id: id, material_id: materialId, target_user_id: body.assignee_id, to: 'assigned' },
        hash: Buffer.alloc(32),
      });
      return toAssignmentDto(p, (await readAssignment(tx, id))!);
    });
  }

  async transition(p: Principal, id: string, body: AssignmentTransition): Promise<MaterialAssignmentDto> {
    if (!UUID.test(id)) throw ApiError.notFound();
    if (body.note !== undefined && body.to !== 'returned') throw ApiError.validation({ fields: ['/note'] });
    return this.db.transaction(async (tx) => {
      const row = await lockAssignment(tx, id);
      if (!row) throw ApiError.notFound();
      const isAssignee = row.assigneeId === p.userId;
      const m = await findScoped(tx, p, row.materialId);
      if (!isAssignee && !m) throw ApiError.notFound();
      const owners = assignmentTransitionOwners(row.state, body.to);
      if (!owners) {
        throw new ApiError(409, 'invalid_transition', `Assignment transition ${row.state} → ${body.to} is not allowed.`, {
          from: row.state,
          to: body.to,
        });
      }
      const allowed = (owners.includes('assignee') && isAssignee) || (owners.includes('manager') && m !== undefined && canAssign(p, m));
      if (!allowed) throw new ApiError(403, 'forbidden_scope', 'This transition belongs to the assignee or to whoever manages the assignment.');
      await applyAssignmentTransition(tx, row, body.to as AssignmentState, p.userId, {
        priority: m?.priority ?? (await materialPriority(tx, row.materialId)),
        note: body.note ?? null,
      });
      return toAssignmentDto(p, (await readAssignment(tx, id))!);
    });
  }

  /** «مهامي»: المفتوحة بالأقرب موعدًا (فالمتأخر أولًا)، والمغلقة بالأحدث إغلاقًا؛ والملخص على كل مهام المستدعي. */
  async mine(p: Principal, q: { status?: 'active' | 'closed'; cursor?: string; limit?: number }): Promise<MyAssignmentPage> {
    const open = (q.status ?? 'active') === 'active';
    const limit = q.limit ?? 50;
    const where: SQL[] = [
      eq(materialAssignments.assigneeId, p.userId),
      inArray(materialAssignments.state, [...(open ? OPEN_STATES : CLOSED_STATES)]),
    ];
    const key = open ? materialAssignments.dueAt : materialAssignments.closedAt;
    if (q.cursor) {
      const c = decodeCursor(q.cursor);
      where.push(
        open
          ? sql`(${key}, ${materialAssignments.id}) > (${c.at}::timestamptz, ${c.id}::uuid)`
          : sql`(${key}, ${materialAssignments.id}) < (${c.at}::timestamptz, ${c.id}::uuid)`,
      );
    }
    const order = open ? [asc(key), asc(materialAssignments.id)] : [desc(key), desc(materialAssignments.id)];
    const rows = (await this.db
      .select(assignmentSelection)
      .from(materialAssignments)
      .innerJoin(materials, eq(materials.id, materialAssignments.materialId))
      .where(and(...where))
      .orderBy(...order)
      .limit(limit + 1)) as AssignmentView[];
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    const lastKey = last ? (open ? last.dueAt : last.closedAt) : null;
    const [summary] = (await this.db.execute(sql`
      SELECT count(*) FILTER (WHERE state IN ('assigned', 'acknowledged', 'in_progress'))::int AS active,
             count(*) FILTER (WHERE state IN ('assigned', 'acknowledged', 'in_progress') AND due_at < now())::int AS overdue,
             count(*) FILTER (WHERE state = 'done' AND closed_at >= now() - interval '7 days')::int AS done_last_7_days
        FROM material_assignments WHERE assignee_id = ${p.userId}`)).rows as Array<{ active: number; overdue: number; done_last_7_days: number }>;
    return {
      items: page.map((r) => toAssignmentDto(p, r)),
      next_cursor: rows.length > limit && last && lastKey ? Buffer.from(JSON.stringify([lastKey, last.id])).toString('base64url') : null,
      summary: { active: summary?.active ?? 0, overdue: summary?.overdue ?? 0, done_last_7_days: summary?.done_last_7_days ?? 0 },
    };
  }

  /** من يجوز الإسناد إليه بحمل كلٍّ منهم، الأقل حملًا أولًا. اسم العمل وحده، ولا بريد. */
  async candidates(): Promise<AssignmentCandidate[]> {
    const result = await this.db.execute(sql`
      SELECT u.id AS user_id,
             ${staffName(sql`u.id`)} AS work_name,
             count(a.id)::int AS open_count,
             count(a.id) FILTER (WHERE m.priority = 'urgent')::int AS urgent_open_count,
             count(a.id) FILTER (WHERE a.due_at < now())::int AS overdue_count
        FROM users u
        LEFT JOIN material_assignments a ON a.assignee_id = u.id AND a.state IN ('assigned', 'acknowledged', 'in_progress')
        LEFT JOIN materials m ON m.id = a.material_id
       WHERE u.status = 'active' AND u.organization_id IS NULL
         AND EXISTS (SELECT 1 FROM user_roles r WHERE r.user_id = u.id AND r.role = 'producer')
       GROUP BY u.id
       ORDER BY open_count ASC, work_name ASC NULLS LAST, u.id
       LIMIT 200`);
    return result.rows as AssignmentCandidate[];
  }

  private async visible(executor: Executor, p: Principal, a: AssignmentView): Promise<boolean> {
    return a.assigneeId === p.userId || (await findScoped(executor, p, a.materialId)) !== undefined;
  }
}

/** مستخدم طاقم نشط بدور producer؛ لا مشترٍ ولا حساب معلّق. */
async function eligibleAssignee(executor: Executor, userId: string): Promise<boolean> {
  const result = await executor.execute(sql`
    SELECT 1 FROM users u
     WHERE u.id = ${userId} AND u.status = 'active' AND u.organization_id IS NULL
       AND EXISTS (SELECT 1 FROM user_roles r WHERE r.user_id = u.id AND r.role = 'producer')`);
  return result.rows.length > 0;
}

function staffName(userId: SQL): SQL {
  // اسم العمل بشرط الطاقم نفسه (common/design-fields.staffWorkName)
  return sql`(SELECT u2.work_name FROM users u2 WHERE u2.id = ${userId} AND u2.organization_id IS NULL
    AND NOT EXISTS (SELECT 1 FROM user_roles r2 WHERE r2.user_id = u2.id AND r2.role IN ('reporter', 'buyer_admin', 'buyer_member')))`;
}

function assignmentOpen(assignmentId: string | null): ApiError {
  return new ApiError(409, 'assignment_open', 'This material already has an open assignment; return it before assigning again.', {
    ...(assignmentId ? { assignment_id: assignmentId } : {}),
  });
}

function decodeCursor(cursor: string): { at: string; id: string } {
  try {
    const [at, id] = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as [unknown, unknown];
    if (typeof at === 'string' && !Number.isNaN(Date.parse(at)) && typeof id === 'string' && UUID.test(id)) return { at, id };
  } catch {
    // يقع إلى 400 أدناه
  }
  throw new ApiError(400, 'bad_request', 'Invalid cursor.', { params: ['cursor'] });
}
