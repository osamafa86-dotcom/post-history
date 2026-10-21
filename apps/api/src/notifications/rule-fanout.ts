import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Tx } from '../database/database.module';
import { notificationRuleEscalations, notificationRules, notifications, userPermissions, userRoles, users } from '../database/schema/schema';
import type { OutboxRow } from '../outbox/outbox.dispatcher';
import { enqueuePush } from '../push/push-delivery.worker';
import { materialRef, notificationTitle, type Locale } from './messages';

/** المادة كما يحتاجها التوزيع: النطاق (المكتب ومحافظته) والأولوية والأنواع، بلا أي حقل حر. */
export interface FanOutMaterial {
  id: string;
  reporterId: string;
  officeId: string | null;
  governorate: string | null;
  priority: string;
  materialTypes: string[];
}

type Rule = typeof notificationRules.$inferSelect;

export async function enabledRules(tx: Tx, eventType: string): Promise<Rule[]> {
  return tx
    .select()
    .from(notificationRules)
    .where(and(eq(notificationRules.eventType, eventType), eq(notificationRules.enabled, true)))
    .orderBy(asc(notificationRules.createdAt), asc(notificationRules.id));
}

/**
 * قواعد الإدارة (v0.2) تحل محل الجدول الافتراضي للمادة حين تنطبق عليها قاعدة مفعّلة لنوع الحدث؛ مادة لا تنطبق عليها
 * أي قاعدة (نطاق آخر، أولوية أو نوع آخر) تبقى على الجدول الافتراضي فلا يُسكت إشعارها. لكل قاعدة تنطبق على المادة
 * (الأولوية، والنوع، والنطاق): إشعار في صندوق الوارد لكل مستلم (دور ضمن نطاق المادة أو صلاحية فاعلة)، وإن كانت مهمة
 * فموعد أول تصعيد من سلسلتها، والدفع إلى الهاتف على قنوات apns/fcm في القاعدة بعد تأخيرها وساعات هدوئها (لغير
 * العاجل). القاعدة الأولى تكسب عند تعدد القواعد لمستلم واحد ((user_id, event_id) فريد). الملخص الدوري لم يُنفَّذ بعد:
 * قاعدته لغير العاجل تبقى في صندوق الوارد بلا دفع فردي. القنوات الخارجية (البريد وتيليغرام وواتساب والرسائل) لا مرسِل
 * لها بعد فلا يغادر إليها شيء.
 */
export async function applyRules(
  tx: Tx,
  event: OutboxRow,
  m: FanOutMaterial,
  rules: Rule[],
  opts: { locale: Locale; push?: boolean; receipt?: string },
  now = new Date(),
): Promise<number> {
  let created = 0;
  const title = notificationTitle(event.type, opts.locale, { ref: materialRef(m.id), receipt: opts.receipt });
  for (const rule of rules.filter((r) => ruleMatches(r, m))) {
    const recipients = await ruleRecipients(tx, rule.recipientRoles, rule.recipientPermissions, m);
    if (recipients.length === 0) continue;
    const [first] = rule.assignment
      ? await tx
          .select({ afterSeconds: notificationRuleEscalations.afterSeconds })
          .from(notificationRuleEscalations)
          .where(and(eq(notificationRuleEscalations.ruleId, rule.id), eq(notificationRuleEscalations.level, 1)))
      : [];
    const rows = await tx
      .insert(notifications)
      .values(
        recipients.map((userId) => ({
          userId,
          eventId: event.id,
          type: event.type,
          materialId: m.id,
          title,
          priority: m.priority,
          ruleId: rule.id,
          assignmentState: rule.assignment ? 'assigned' : null,
          escalateAt: first ? sql`now() + make_interval(secs => ${first.afterSeconds})` : null,
        })),
      )
      .onConflictDoNothing({ target: [notifications.userId, notifications.eventId] })
      .returning({ id: notifications.id });
    created += rows.length;
    const urgent = m.priority === 'urgent';
    if (opts.push && (urgent || rule.digestIntervalMinutes === null)) {
      const wait = rule.delaySeconds + (urgent ? 0 : quietHoursWait(rule, now));
      await enqueuePush(tx, rows.map((r) => r.id), { channels: rule.channels, notBeforeSeconds: wait });
    }
  }
  return created;
}

export function ruleMatches(r: Rule, m: FanOutMaterial): boolean {
  if (r.priorities && !r.priorities.includes(m.priority)) return false;
  if (r.materialTypes && !r.materialTypes.some((t) => m.materialTypes.includes(t))) return false;
  if (r.scopeKind === 'office') return r.scopeId === m.officeId;
  if (r.scopeKind === 'governorate') return r.scopeId === m.governorate;
  return true;
}

/**
 * المستلمون: أصحاب الأدوار المذكورة الفاعلون ضمن نطاق المادة (دور «مراسل» = مراسل المادة نفسه، فالمراسل لا يرى إلا
 * مواده)، وحاملو الصلاحيات المذكورة غير المسحوبة.
 */
export async function ruleRecipients(tx: Tx, roles: string[], permissions: string[], m: FanOutMaterial): Promise<string[]> {
  const ids = new Set<string>();
  if (roles.includes('reporter')) {
    const [r] = await tx.select({ id: users.id }).from(users).where(and(eq(users.id, m.reporterId), eq(users.status, 'active')));
    if (r) ids.add(r.id);
  }
  const scoped = roles.filter((r) => r !== 'reporter');
  if (scoped.length > 0) {
    const rows = await tx
      .selectDistinct({ userId: userRoles.userId })
      .from(userRoles)
      .innerJoin(users, eq(users.id, userRoles.userId))
      .where(
        and(
          inArray(userRoles.role, scoped),
          eq(users.status, 'active'),
          sql`(${userRoles.scopeKind} = 'all'
              OR (${userRoles.scopeKind} = 'office' AND ${userRoles.scopeId} = ${m.officeId ?? ''})
              OR (${userRoles.scopeKind} = 'governorate' AND ${userRoles.scopeId} = ${m.governorate ?? ''}))`,
        ),
      );
    for (const r of rows) ids.add(r.userId);
  }
  if (permissions.length > 0) {
    const rows = await tx
      .selectDistinct({ userId: userPermissions.userId })
      .from(userPermissions)
      .innerJoin(users, eq(users.id, userPermissions.userId))
      .where(and(inArray(userPermissions.permission, permissions), isNull(userPermissions.revokedAt), eq(users.status, 'active')));
    for (const r of rows) ids.add(r.userId);
  }
  return [...ids];
}

/** الثواني حتى نهاية ساعات الهدوء إن كانت الساعة الآن داخلها بتوقيت القاعدة، وإلا 0. النافذة قد تعبر منتصف الليل. */
export function quietHoursWait(r: Pick<Rule, 'quietHoursStart' | 'quietHoursEnd' | 'quietHoursTz'>, now: Date): number {
  if (!r.quietHoursStart || !r.quietHoursEnd || !r.quietHoursTz) return 0;
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: r.quietHoursTz, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
    .formatToParts(now)
    .reduce<Record<string, number>>((acc, p) => (p.type === 'literal' ? acc : { ...acc, [p.type]: Number(p.value) }), {});
  const nowSec = (parts.hour ?? 0) * 3600 + (parts.minute ?? 0) * 60 + (parts.second ?? 0);
  const sec = (t: string) => Number(t.slice(0, 2)) * 3600 + Number(t.slice(3, 5)) * 60;
  const start = sec(r.quietHoursStart);
  const end = sec(r.quietHoursEnd);
  if (start === end) return 0;
  const inside = start < end ? nowSec >= start && nowSec < end : nowSec >= start || nowSec < end;
  if (!inside) return 0;
  return (end - nowSec + 86400) % 86400;
}
