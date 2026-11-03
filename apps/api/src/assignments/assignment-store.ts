import { and, eq, getTableColumns, isNull, sql } from 'drizzle-orm';
import { maySeeWorkNames, staffWorkName } from '../common/design-fields';
import type { Executor, Tx } from '../database/database.module';
import { auditLog, materialAssignments, materials, notifications } from '../database/schema/schema';
import type { components } from '../generated/api';
import { hasRole, type Principal } from '../identity/principal';
import { iso, type MaterialRow, roleCovers } from '../materials/material-store';
import { writeOutboxEvent } from '../outbox/outbox';

export type AssignmentState = components['schemas']['MaterialAssignmentState'];
export type MaterialAssignmentDto = components['schemas']['MaterialAssignment'];
export type AssignmentRow = typeof materialAssignments.$inferSelect;

/** المفتوحة: مهمة واحدة منها لكل مادة (الفهرس الجزئي material_assignments_open_key). */
export const OPEN_STATES: readonly AssignmentState[] = ['assigned', 'acknowledged', 'in_progress'];
export const CLOSED_STATES: readonly AssignmentState[] = ['done', 'returned'];

/** المونتير المسنَدة إليه، أو من يملك الإسناد على المادة (المشرف في نطاقه ورئيس التحرير). */
export type AssignmentActor = 'assignee' | 'manager';

/**
 * جدول انتقالات المهمة (ADR 0096). ما ليس هنا = 409 invalid_transition. لا دورة فيه، فكل (مهمة، حالة هدف) يقع مرة واحدة
 * على الأكثر، ومنه مفتاح حدثه الحتمي.
 */
export const ASSIGNMENT_TRANSITIONS: ReadonlyArray<{ from: AssignmentState; to: AssignmentState; by: readonly AssignmentActor[] }> = [
  { from: 'assigned', to: 'acknowledged', by: ['assignee'] },
  { from: 'assigned', to: 'in_progress', by: ['assignee'] },
  { from: 'assigned', to: 'returned', by: ['assignee', 'manager'] },
  { from: 'acknowledged', to: 'in_progress', by: ['assignee'] },
  { from: 'acknowledged', to: 'returned', by: ['assignee', 'manager'] },
  { from: 'in_progress', to: 'done', by: ['assignee'] },
  { from: 'in_progress', to: 'returned', by: ['assignee', 'manager'] },
];

export function assignmentTransitionOwners(from: string, to: string): readonly AssignmentActor[] | undefined {
  return ASSIGNMENT_TRANSITIONS.find((t) => t.from === from && t.to === to)?.by;
}

/** من يملك الإسناد على المادة: رئيس التحرير لكل المواد، والمشرف لما يغطيه نطاقه. */
export function canAssign(p: Principal, m: MaterialRow): boolean {
  return hasRole(p, 'editor_in_chief') || roleCovers(p, 'supervisor', m);
}

/** المهمة بما تعرضه الاستجابة: أولوية المادة الحالية، واسما العمل، والتأخر محسوبًا على ساعة القاعدة. */
export const assignmentSelection = {
  ...getTableColumns(materialAssignments),
  priority: materials.priority,
  assigneeName: staffWorkName(sql`${materialAssignments.assigneeId}`),
  assignedByName: staffWorkName(sql`${materialAssignments.assignedBy}`),
  overdue: sql<boolean>`(${materialAssignments.state} IN ('assigned', 'acknowledged', 'in_progress') AND ${materialAssignments.dueAt} < now())`,
};

export type AssignmentView = AssignmentRow & { priority: string; assigneeName: string | null; assignedByName: string | null; overdue: boolean };

export async function readAssignment(executor: Executor, id: string): Promise<AssignmentView | undefined> {
  const [row] = await executor
    .select(assignmentSelection)
    .from(materialAssignments)
    .innerJoin(materials, eq(materials.id, materialAssignments.materialId))
    .where(eq(materialAssignments.id, id));
  return row as AssignmentView | undefined;
}

/** يقفل صف المهمة حتى نهاية المعاملة؛ الانتقالات المتزامنة عليها تتسلسل فيرى الثاني حالة الأول. */
export async function lockAssignment(tx: Tx, id: string): Promise<AssignmentRow | undefined> {
  const [row] = await tx.select().from(materialAssignments).where(eq(materialAssignments.id, id)).for('update');
  return row;
}

export function toAssignmentDto(p: Principal, a: AssignmentView): MaterialAssignmentDto {
  const names = maySeeWorkNames(p) ? { assignee_name: a.assigneeName ?? null, assigned_by_name: a.assignedByName ?? null } : {};
  return {
    id: a.id,
    material_id: a.materialId,
    priority: a.priority as MaterialAssignmentDto['priority'],
    assignee_id: a.assigneeId,
    assigned_by: a.assignedBy,
    ...names,
    state: a.state as AssignmentState,
    due_at: iso(a.dueAt)!,
    overdue: Boolean(a.overdue),
    note: a.note,
    returned_by: a.returnedBy,
    return_note: a.returnNote,
    created_at: iso(a.createdAt)!,
    acknowledged_at: iso(a.acknowledgedAt),
    started_at: iso(a.startedAt),
    closed_at: iso(a.closedAt),
    produced_file_id: a.producedFileId,
    updated_at: iso(a.updatedAt)!,
  };
}

/**
 * يطبّق انتقالًا مسموحًا (تحقق المستدعي من الجدول ومالكه، والصف مقفول) في المعاملة نفسها: الصف، وإشعار المهمة،
 * وحدث assignment.state_changed بالمعرّفات وحدها، وسطر تدقيق. الحالات الثلاث للمادة لا تُمس.
 *
 * الإشعار: الإقرار أو بدء العمل يقرّ إشعار «أُسندت» للمونتير ويوقف تصعيده؛ والإغلاق يوقف التصعيد إن بقي.
 */
export async function applyAssignmentTransition(
  tx: Tx,
  row: AssignmentRow,
  to: AssignmentState,
  actorId: string,
  opts: { priority: string; note?: string | null; producedFileId?: string | null },
): Promise<void> {
  const at = sql`now()`;
  const closing = to === 'done' || to === 'returned';
  await tx
    .update(materialAssignments)
    .set({
      state: to,
      // in_progress من assigned يقرّ الاستلام ضمنًا
      ...(to === 'acknowledged' || (to === 'in_progress' && row.acknowledgedAt === null) ? { acknowledgedAt: at } : {}),
      ...(to === 'in_progress' ? { startedAt: at } : {}),
      ...(closing ? { closedAt: at } : {}),
      ...(to === 'returned' ? { returnedBy: actorId, returnNote: opts.note ?? null } : {}),
      // «سلّمت المهمة» بالنسخة المُنتَجة (ADR 0104)؛ القيد يحصرها في done
      ...(to === 'done' && opts.producedFileId ? { producedFileId: opts.producedFileId } : {}),
    })
    .where(eq(materialAssignments.id, row.id));

  const task = and(eq(notifications.assignmentId, row.id), eq(notifications.type, 'assignment.created'), isNull(notifications.acknowledgedAt));
  if (to === 'acknowledged' || to === 'in_progress') {
    await tx
      .update(notifications)
      .set({
        state: 'acknowledged',
        readAt: sql`COALESCE(${notifications.readAt}, now())`,
        acknowledgedAt: sql`now()`,
        assignmentState: 'acknowledged',
        escalateAt: null,
      })
      .where(and(task, eq(notifications.userId, row.assigneeId)));
  } else {
    await tx.update(notifications).set({ escalateAt: null }).where(task);
  }

  await writeOutboxEvent(tx, {
    type: 'assignment.state_changed',
    aggregateType: 'material',
    aggregateId: row.materialId,
    idempotencyKey: `assignment.state_changed:${row.id}:${to}`,
    actorId,
    payload: {
      material_id: row.materialId,
      assignment_id: row.id,
      priority: opts.priority,
      assignee_id: row.assigneeId,
      from: row.state,
      to,
    },
  });
  await tx.insert(auditLog).values({
    actorId,
    action: 'assignment.transitioned',
    targetType: 'material_assignment',
    targetId: row.id,
    details: { assignment_id: row.id, material_id: row.materialId, from: row.state, to, ...(to === 'done' && opts.producedFileId ? { file_id: opts.producedFileId } : {}) },
    hash: Buffer.alloc(32),
  });
}

/** أولوية المادة الحالية لحمولة الحدث (بلا نطاق: المستدعي تحقق من المهمة قبلها). */
export async function materialPriority(executor: Executor, materialId: string): Promise<string> {
  const [m] = await executor.select({ priority: materials.priority }).from(materials).where(eq(materials.id, materialId));
  return m?.priority ?? 'normal';
}
