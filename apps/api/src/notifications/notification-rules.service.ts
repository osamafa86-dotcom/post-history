import { Inject, Injectable } from '@nestjs/common';
import { asc, eq, sql } from 'drizzle-orm';
import { ApiError } from '../common/errors';
import { assertIfMatch } from '../common/preconditions';
import { DB, type Database, type Executor, type Tx } from '../database/database.module';
import { auditLog, notificationRuleEscalations, notificationRules } from '../database/schema/schema';
import type { components } from '../generated/api';
import { iso } from '../materials/material-store';

export type NotificationRuleInput = components['schemas']['NotificationRuleInput'];
export type NotificationRule = components['schemas']['NotificationRule'];
type Step = components['schemas']['NotificationEscalationStep'];
type RuleRow = typeof notificationRules.$inferSelect;
type StepRow = typeof notificationRuleEscalations.$inferSelect;

// أسماء الأدوار كما في القاعدة (text[])؛ العقد يصفها بـ RoleName
const names = (roles: readonly unknown[]): string[] => roles as string[];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * قواعد التنبيه التي تضبطها الإدارة (عقد v0.2): الاستبدال كامل مع سلسلة التصعيد في معاملة واحدة، بـ If-Match على
 * row_version. التدقيق بـ rule_id وحده (اسم القاعدة إداري ولا يدخل سجلًا ولا إشعارًا).
 */
@Injectable()
export class NotificationRulesService {
  constructor(@Inject(DB) private readonly db: Database) {}

  async list(): Promise<{ items: NotificationRule[] }> {
    const rules = await this.db.select().from(notificationRules).orderBy(asc(notificationRules.createdAt), asc(notificationRules.id));
    const steps = await this.db.select().from(notificationRuleEscalations).orderBy(asc(notificationRuleEscalations.level));
    return { items: rules.map((r) => toDto(r, steps.filter((s) => s.ruleId === r.id))) };
  }

  async get(id: string): Promise<NotificationRule> {
    return read(this.db, id);
  }

  async create(actorId: string, input: NotificationRuleInput): Promise<NotificationRule> {
    const v = normalize(input);
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(notificationRules)
        .values({ ...columns(v), createdBy: actorId, updatedBy: actorId })
        .returning({ id: notificationRules.id });
      await writeSteps(tx, row!.id, v.escalation);
      await audited(tx, actorId, 'notification_rule.created', row!.id);
      return read(tx, row!.id);
    });
  }

  async replace(actorId: string, id: string, input: NotificationRuleInput, ifMatch: string | undefined): Promise<NotificationRule> {
    const v = normalize(input);
    return this.db.transaction(async (tx) => {
      const current = await locked(tx, id);
      assertIfMatch(ifMatch, current.rowVersion);
      await tx
        .update(notificationRules)
        .set({ ...columns(v), updatedBy: actorId, rowVersion: sql`${notificationRules.rowVersion} + 1` })
        .where(eq(notificationRules.id, id));
      await tx.delete(notificationRuleEscalations).where(eq(notificationRuleEscalations.ruleId, id));
      await writeSteps(tx, id, v.escalation);
      await audited(tx, actorId, 'notification_rule.replaced', id);
      return read(tx, id);
    });
  }

  async remove(actorId: string, id: string, ifMatch: string | undefined): Promise<void> {
    await this.db.transaction(async (tx) => {
      const current = await locked(tx, id);
      assertIfMatch(ifMatch, current.rowVersion);
      // الإشعارات التي ولّدتها تبقى و rule_id فيها يصير فارغًا (ON DELETE SET NULL)
      await tx.delete(notificationRules).where(eq(notificationRules.id, id));
      await audited(tx, actorId, 'notification_rule.deleted', id);
    });
  }
}

/**
 * ما لا يعبّر عنه مخطط العقد: مستلم واحد على الأقل، والنطاق متسق، والمنطقة الزمنية معروفة، والتصعيد على مهمة وحدها
 * بمستويات متتالية من 1 و after_seconds متزايد. أي خرق 422 بمسار الحقل.
 */
function normalize(input: NotificationRuleInput): Required<NotificationRuleInput> {
  const v: Required<NotificationRuleInput> = {
    name: input.name,
    event_type: input.event_type,
    priorities: input.priorities ?? null,
    material_types: input.material_types ?? null,
    scope_kind: input.scope_kind ?? 'all',
    scope_id: input.scope_id ?? '',
    recipient_roles: input.recipient_roles ?? [],
    recipient_permissions: input.recipient_permissions ?? [],
    channels: input.channels,
    delay_seconds: input.delay_seconds ?? 0,
    quiet_hours: input.quiet_hours ?? null,
    digest_interval_minutes: input.digest_interval_minutes ?? null,
    assignment: input.assignment ?? false,
    escalation: input.escalation ?? [],
    enabled: input.enabled ?? true,
  };
  const bad: string[] = [];
  if (v.recipient_roles.length + v.recipient_permissions.length === 0) bad.push('/recipient_roles');
  if ((v.scope_kind === 'all') !== (v.scope_id === '')) bad.push('/scope_id');
  if (v.quiet_hours && !knownTimezone(v.quiet_hours.timezone)) bad.push('/quiet_hours/timezone');
  if (v.escalation.length > 0 && !v.assignment) bad.push('/escalation');
  v.escalation.forEach((s, i) => {
    if (s.level !== i + 1 || (i > 0 && s.after_seconds <= v.escalation[i - 1]!.after_seconds)) bad.push(`/escalation/${i}`);
  });
  if (bad.length > 0) throw ApiError.validation({ fields: bad });
  return v;
}

function knownTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function columns(v: Required<NotificationRuleInput>) {
  return {
    name: v.name,
    eventType: v.event_type,
    priorities: v.priorities,
    materialTypes: v.material_types,
    scopeKind: v.scope_kind,
    scopeId: v.scope_id,
    recipientRoles: names(v.recipient_roles),
    recipientPermissions: v.recipient_permissions,
    channels: v.channels,
    delaySeconds: v.delay_seconds,
    quietHoursStart: v.quiet_hours?.start ?? null,
    quietHoursEnd: v.quiet_hours?.end ?? null,
    quietHoursTz: v.quiet_hours?.timezone ?? null,
    digestIntervalMinutes: v.digest_interval_minutes,
    assignment: v.assignment,
    enabled: v.enabled,
  };
}

async function writeSteps(tx: Tx, ruleId: string, steps: Required<NotificationRuleInput>['escalation']): Promise<void> {
  if (steps.length === 0) return;
  await tx.insert(notificationRuleEscalations).values(
    steps.map((s) => ({ ruleId, level: s.level, afterSeconds: s.after_seconds, recipientRoles: names(s.recipient_roles), channels: s.channels })),
  );
}

async function locked(tx: Tx, id: string): Promise<RuleRow> {
  if (!UUID.test(id)) throw ApiError.notFound();
  const [row] = await tx.select().from(notificationRules).where(eq(notificationRules.id, id)).for('update');
  if (!row) throw ApiError.notFound();
  return row;
}

async function read(executor: Executor, id: string): Promise<NotificationRule> {
  if (!UUID.test(id)) throw ApiError.notFound();
  const [row] = await executor.select().from(notificationRules).where(eq(notificationRules.id, id));
  if (!row) throw ApiError.notFound();
  const steps = await executor
    .select()
    .from(notificationRuleEscalations)
    .where(eq(notificationRuleEscalations.ruleId, id))
    .orderBy(asc(notificationRuleEscalations.level));
  return toDto(row, steps);
}

async function audited(tx: Tx, actorId: string, action: string, ruleId: string): Promise<void> {
  await tx.insert(auditLog).values({ actorId, action, targetType: 'notification_rule', targetId: ruleId, details: { rule_id: ruleId }, hash: Buffer.alloc(32) });
}

const hhmm = (t: string | null) => (t === null ? null : t.slice(0, 5));

function toDto(r: RuleRow, steps: StepRow[]): NotificationRule {
  return {
    id: r.id,
    name: r.name,
    event_type: r.eventType as NotificationRule['event_type'],
    priorities: r.priorities as NotificationRule['priorities'],
    material_types: r.materialTypes as NotificationRule['material_types'],
    scope_kind: r.scopeKind as NotificationRule['scope_kind'],
    scope_id: r.scopeId,
    recipient_roles: r.recipientRoles as unknown as NonNullable<NotificationRule['recipient_roles']>,
    recipient_permissions: r.recipientPermissions as NonNullable<NotificationRule['recipient_permissions']>,
    channels: r.channels as NotificationRule['channels'],
    delay_seconds: r.delaySeconds,
    quiet_hours: r.quietHoursStart ? { start: hhmm(r.quietHoursStart)!, end: hhmm(r.quietHoursEnd)!, timezone: r.quietHoursTz! } : null,
    digest_interval_minutes: r.digestIntervalMinutes,
    assignment: r.assignment,
    escalation: steps.map((s) => ({
      level: s.level,
      after_seconds: s.afterSeconds,
      recipient_roles: s.recipientRoles as unknown as Step['recipient_roles'],
      channels: s.channels as Step['channels'],
    })),
    enabled: r.enabled,
    row_version: r.rowVersion,
    created_by: r.createdBy,
    updated_by: r.updatedBy,
    created_at: iso(r.createdAt)!,
    updated_at: iso(r.updatedAt)!,
  };
}
