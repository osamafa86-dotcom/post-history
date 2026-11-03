import { and, eq, sql } from 'drizzle-orm';
import type { Tx } from '../database/database.module';
import { licenses, materialAssignments, materialRenders, materials, notificationRuleEscalations, notifications, offices, userRoles, users } from '../database/schema/schema';
import { isReporterAccount } from '../identity/principal';
import type { OutboxRow } from '../outbox/outbox.dispatcher';
import { enqueuePush } from '../push/push-delivery.worker';
import { materialRef, notificationTitle, type Locale } from './messages';
import { applyRules, enabledRules, ruleMatches } from './rule-fanout';

type Audience = 'supervisors' | 'producers' | 'reporter' | 'escalated_to';

export interface FanOutOptions {
  locale: Locale;
  /** مهلة الإقرار قبل التصعيد بالثواني لكل أولوية؛ العادية لا تُصعَّد. */
  escalationSeconds: { urgent: number; important: number };
  /** PUSH_DELIVERY_ENABLED: يُوضع تسليم الدفع للإشعارات التي تطلبه قاعدتها */
  push?: boolean;
}

/**
 * من يُشعَر بكل نوع حدث، وهل هي مهمة («أُسند» ثم «أقرّ الاستلام»)، وهل يُدفع إلى الهاتف (جدول «الاستلام والتنبيهات» في
 * الخطة؛ قبول الإنتاج داخل المنصة واللوحة وحدهما). ما ليس هنا لا يولّد إشعارًا. القواعد التي تضبطها الإدارة تحل محل
 * هذا الجدول حين يدخل جدولها (v0.2).
 */
const RULES: Record<string, { audience: Audience; assignment: boolean; push: boolean; skipUrgent?: boolean }> = {
  // المادة العاجلة تصل بحدثين؛ إشعار واحد من urgent_received
  'material.created': { audience: 'supervisors', assignment: true, push: true, skipUrgent: true },
  'material.urgent_received': { audience: 'supervisors', assignment: true, push: true },
  'material.acknowledged': { audience: 'reporter', assignment: false, push: true },
  'material.change_requested': { audience: 'reporter', assignment: false, push: true },
  'material.accepted_for_production': { audience: 'producers', assignment: true, push: false },
  'material.published': { audience: 'reporter', assignment: false, push: true },
  // إشعار الاستلام: يصل حين يتحقق الأصل ويصدر رقم الإيصال
  'upload.verified': { audience: 'reporter', assignment: false, push: true },
  // التصعيد يصل المستخدم المسمّى في الحدث؛ لا يُصعَّد هو نفسه (السلسلة تتقدم على الإشعار الأصلي)
  'notification.escalated': { audience: 'escalated_to', assignment: true, push: true },
};

/**
 * يحوّل حدث Outbox إلى إشعارات في صندوق الوارد داخل معاملة المُرسل نفسها. ذاتي التكرار: (user_id, event_id) فريد،
 * فإعادة إرسال الحدث لا تكرر الإشعار. يعيد عدد الإشعارات الجديدة.
 */
export async function fanOut(tx: Tx, event: OutboxRow, opts: FanOutOptions): Promise<number> {
  // تقدّم الرفع للوحة وحدها (ADR 0024): لا إشعار ولا قاعدة تنبيه
  if (event.type === 'upload.progress') return 0;
  const payload = event.payload as Record<string, unknown>;
  // رفع النسخة المُنتَجة لا يصير إشعارًا ولا يطلق قاعدة تنبيه (ADR 0104): التسليم يُعلَم بانتقال المهمة
  if (event.type.startsWith('upload.') && payload.kind === 'produced') return 0;
  if (event.type === 'auth.recovery_requested') return recoveryRequested(tx, event, payload, opts);
  if (event.type === 'auth.recovery_completed') return ownerAlert(tx, event, 'auth.recovery_completed', opts);
  // تغيّر وسائل الدخول (ADR 0107): صاحب الحساب يُنبَّه على أجهزته، والعنوان قالب ثابت بلا معرّف
  if (event.type === 'auth.passkey_added' || event.type === 'auth.recovery_codes_generated') return ownerAlert(tx, event, event.type, opts);
  if (event.type === 'setting.changed') return settingChanged(tx, event, opts);
  if (event.type === 'license.revoked') return licenseRevoked(tx, event, payload, opts);
  if (event.type === 'render.completed' || event.type === 'render.failed') return renderFinished(tx, event, payload, opts);
  if (event.type === 'assignment.created' || event.type === 'assignment.state_changed') return assignmentEvent(tx, event, payload, opts);
  const materialId = typeof payload.material_id === 'string' ? payload.material_id : undefined;
  const receipt = typeof payload.receipt_number === 'string' ? payload.receipt_number : undefined;
  const custom = materialId && RULEABLE.test(event.type) ? await enabledRules(tx, event.type) : [];
  const rule = RULES[event.type];
  if ((!rule && custom.length === 0) || !materialId) return 0;

  const [m] = await tx
    .select({
      id: materials.id,
      reporterId: materials.reporterId,
      officeId: materials.officeId,
      priority: materials.priority,
      materialTypes: materials.materialTypes,
      governorate: offices.governorate,
    })
    .from(materials)
    .leftJoin(offices, eq(offices.id, materials.officeId))
    .where(eq(materials.id, materialId));
  if (!m) return 0;
  // القواعد تحل محل الافتراضي للمادة التي تنطبق عليها وحدها، وما لا تنطبق عليه قاعدة يبقى على الافتراضي
  const matching = custom.filter((r) => ruleMatches(r, m));
  if (matching.length > 0) return applyRules(tx, event, m, matching, { locale: opts.locale, push: opts.push, receipt });
  if (!rule) return 0;
  if (event.type === 'upload.verified' && (payload.kind !== 'original' || !receipt)) return 0;
  if (rule.skipUrgent && m.priority === 'urgent') return 0;
  if (event.type === 'notification.escalated') return escalated(tx, event, payload, m, opts);

  const recipients = await audience(tx, rule.audience as Exclude<Audience, 'escalated_to'>, m);
  if (recipients.length === 0) return 0;
  const delay = rule.assignment && rule.audience !== 'escalated_to' ? opts.escalationSeconds[m.priority as 'urgent'] : undefined;
  const title = notificationTitle(event.type, opts.locale, { ref: materialRef(m.id), receipt });
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
        assignmentState: rule.assignment ? 'assigned' : null,
        escalateAt: delay ? sql`now() + make_interval(secs => ${delay})` : null,
      })),
    )
    .onConflictDoNothing({ target: [notifications.userId, notifications.eventId] })
    .returning({ id: notifications.id });
  if (opts.push && rule.push) await enqueuePush(tx, rows.map((r) => r.id));
  return rows.length;
}

// الأحداث التي تقبل قواعد الإدارة (notification_rules_event_type_check)
const RULEABLE = /^(material|upload|ai)\./;

/**
 * إشعار التصعيد للمستخدم المسمّى في الحدث، بمستوى التصعيد. إن جاء من سلسلة قاعدة فالقاعدة نفسها، والدفع على قنوات
 * مستواها وحدها؛ وإلا فسلم التصعيد الافتراضي بالدفع.
 */
async function escalated(
  tx: Tx,
  event: OutboxRow,
  payload: Record<string, unknown>,
  m: { id: string; priority: string },
  opts: FanOutOptions,
): Promise<number> {
  const to = typeof payload.escalated_to === 'string' ? payload.escalated_to : undefined;
  const level = typeof payload.escalation_level === 'number' ? payload.escalation_level : 0;
  const originalId = typeof payload.notification_id === 'string' ? payload.notification_id : undefined;
  if (!to) return 0;
  const [original] = originalId ? await tx.select({ ruleId: notifications.ruleId }).from(notifications).where(eq(notifications.id, originalId)) : [];
  const ruleId = original?.ruleId ?? null;
  const [step] = ruleId
    ? await tx
        .select({ channels: notificationRuleEscalations.channels })
        .from(notificationRuleEscalations)
        .where(and(eq(notificationRuleEscalations.ruleId, ruleId), eq(notificationRuleEscalations.level, level)))
    : [];
  const rows = await tx
    .insert(notifications)
    .values({
      userId: to,
      eventId: event.id,
      type: event.type,
      materialId: m.id,
      title: notificationTitle(event.type, opts.locale, { ref: materialRef(m.id) }),
      priority: m.priority,
      ruleId,
      assignmentState: 'assigned',
      escalationLevel: level,
    })
    .onConflictDoNothing({ target: [notifications.userId, notifications.eventId] })
    .returning({ id: notifications.id });
  if (opts.push) await enqueuePush(tx, rows.map((r) => r.id), step ? { channels: step.channels } : {});
  return rows.length;
}

async function audience(
  tx: Tx,
  who: Exclude<Audience, 'escalated_to'>,
  m: { reporterId: string; officeId: string | null; governorate: string | null },
): Promise<string[]> {
  if (who === 'reporter') return [m.reporterId];
  const role = who === 'supervisors' ? 'supervisor' : 'producer';
  // المشرف يُشعَر بما في نطاقه فقط (كل شيء، أو مكتب المادة، أو محافظة مكتبها)
  const inScope =
    who === 'supervisors'
      ? sql`(${userRoles.scopeKind} = 'all'
            OR (${userRoles.scopeKind} = 'office' AND ${userRoles.scopeId} = ${m.officeId ?? ''})
            OR (${userRoles.scopeKind} = 'governorate' AND ${userRoles.scopeId} = ${m.governorate ?? ''}))`
      : sql`true`;
  const rows = await tx
    .selectDistinct({ userId: userRoles.userId })
    .from(userRoles)
    .innerJoin(users, eq(users.id, userRoles.userId))
    .where(and(eq(userRoles.role, role), eq(users.status, 'active'), inScope));
  return rows.map((r) => r.userId);
}


/**
 * طلب استعادة: مهمة لمن يملك اعتماده بمعرّف الطلب، وتنبيه لصاحب الحساب على أجهزته القائمة. بلا مادة.
 * من يملك الاعتماد (ADR 0113): مشرفو نطاق صاحب الحساب إن كان حساب مراسل وحده، وإلا (مشترٍ، أو طاقم بأي دور غير المراسل) مديرو
 * النظام وحدهم (غير صاحب الحساب نفسه)، كما يقرر `approveRecovery`.
 */
async function recoveryRequested(tx: Tx, event: OutboxRow, payload: Record<string, unknown>, opts: FanOutOptions): Promise<number> {
  const requestId = typeof payload.recovery_request_id === 'string' ? payload.recovery_request_id : undefined;
  if (!requestId) return 0;
  const [owner] = await tx
    .select({ id: users.id, officeId: users.officeId, organizationId: users.organizationId, governorate: offices.governorate })
    .from(users)
    .leftJoin(offices, eq(offices.id, users.officeId))
    .where(eq(users.id, event.aggregateId));
  if (!owner) return 0;
  const ownerRoles = await tx.select({ role: userRoles.role }).from(userRoles).where(eq(userRoles.userId, owner.id));
  const approvers = isReporterAccount(ownerRoles.map((r) => r.role), owner.organizationId)
    ? await audience(tx, 'supervisors', { reporterId: owner.id, officeId: owner.officeId, governorate: owner.governorate })
    : await systemAdmins(tx);
  const rows = [
    ...approvers
      .filter((id) => id !== owner.id)
      .map((userId) => ({
        userId,
        title: notificationTitle('auth.recovery_requested', opts.locale, { ref: requestId }),
        assignmentState: 'assigned' as const,
        // v0.1: المعتمِد يفتح الطلب من هذا الحقل (العنوان يبقى يحمله لعملاء v0)
        recoveryRequestId: requestId,
      })),
    // صاحب الحساب يُنبَّه بلا معرّف الطلب: لا شيء له يفعله به، وقد يكون جهازه المفقود هو من يقرأ
    { userId: owner.id, title: notificationTitle('auth.recovery_requested.self', opts.locale, { ref: '' }), assignmentState: null, recoveryRequestId: null },
  ];
  const inserted = await tx
    .insert(notifications)
    .values(rows.map((r) => ({ ...r, eventId: event.id, type: event.type, materialId: null, priority: 'important' })))
    .onConflictDoNothing({ target: [notifications.userId, notifications.eventId] })
    .returning({ id: notifications.id });
  if (opts.push) await enqueuePush(tx, inserted.map((r) => r.id));
  return inserted.length;
}

/**
 * ترخيص أبطله سحب حقوق المادة أو حجبها أو وسمها بالحساسية (ADR 0114): أعضاء مؤسسته الفاعلون يُنبَّهون داخل المنصة برقم الترخيص
 * وحده، بلا المادة ولا السبب ولا دفع. إبطال الاسترداد (`refunded`) يعرفه المشتري من طلبه فلا يُنبَّه هنا.
 */
async function licenseRevoked(tx: Tx, event: OutboxRow, payload: Record<string, unknown>, opts: FanOutOptions): Promise<number> {
  if (payload.revoked_reason !== 'rights_withdrawn') return 0;
  const [l] = await tx.select({ number: licenses.licenseNumber, organizationId: licenses.organizationId }).from(licenses).where(eq(licenses.id, event.aggregateId));
  if (!l) return 0;
  const members = await tx
    .selectDistinct({ userId: users.id })
    .from(users)
    .innerJoin(userRoles, eq(userRoles.userId, users.id))
    .where(
      and(
        eq(users.organizationId, l.organizationId),
        eq(users.status, 'active'),
        eq(users.membershipSuspended, false),
        sql`${userRoles.role} IN ('buyer_admin', 'buyer_member')`,
      ),
    );
  if (members.length === 0) return 0;
  const title = notificationTitle('license.revoked', opts.locale, { ref: l.number });
  const inserted = await tx
    .insert(notifications)
    .values(members.map((m) => ({ userId: m.userId, eventId: event.id, type: event.type, materialId: null, title, priority: 'important', assignmentState: null })))
    .onConflictDoNothing({ target: [notifications.userId, notifications.eventId] })
    .returning({ id: notifications.id });
  return inserted.length;
}

/** تغيير إعداد مؤسسي (ADR 0021): يُبلَّغ كل مديري النظام الفاعلين، ومنهم من غيّره. العنوان بلا قيمة ولا اسم. */
async function settingChanged(tx: Tx, event: OutboxRow, opts: FanOutOptions): Promise<number> {
  const admins = await systemAdmins(tx);
  if (admins.length === 0) return 0;
  const title = notificationTitle('setting.changed', opts.locale, { ref: '' });
  const inserted = await tx
    .insert(notifications)
    .values(admins.map((userId) => ({ userId, eventId: event.id, type: event.type, materialId: null, title, priority: 'important', assignmentState: null })))
    .onConflictDoNothing({ target: [notifications.userId, notifications.eventId] })
    .returning({ id: notifications.id });
  if (opts.push) await enqueuePush(tx, inserted.map((r) => r.id));
  return inserted.length;
}

async function systemAdmins(tx: Tx): Promise<string[]> {
  const rows = await tx
    .selectDistinct({ userId: userRoles.userId })
    .from(userRoles)
    .innerJoin(users, eq(users.id, userRoles.userId))
    .where(and(eq(userRoles.role, 'system_admin'), eq(users.status, 'active')));
  return rows.map((r) => r.userId);
}

/** إكمال الاستعادة (ضابط ADR 0012): تنبيه لصاحب الحساب وحده بلا معرّف الطلب، فيعرف إن استُولي على حسابه. */
/**
 * نسخة القالب الجاهزة أو الفاشلة تُشعر طالبها وحده داخل المنصة (ADR 0091 البند 6): رقم المادة وحالة النسخة بقالب الخادم،
 * بلا عنوان النسخة ولا مكانها، ولا دفع. لا تدخل قواعد التنبيه الإدارية.
 */
async function renderFinished(tx: Tx, event: OutboxRow, payload: Record<string, unknown>, opts: FanOutOptions): Promise<number> {
  const renderId = typeof payload.render_id === 'string' ? payload.render_id : undefined;
  if (!renderId) return 0;
  const [r] = await tx
    .select({ requestedBy: materialRenders.requestedBy, materialId: materialRenders.materialId, template: materialRenders.template })
    .from(materialRenders)
    .where(eq(materialRenders.id, renderId));
  if (!r) return 0;
  // العنوان يسمّي القالب («الشاهد»، ADR 0109)، ونوع الإشعار هو الحدث نفسه
  const titleKey = r.template === 'witness' ? `${event.type}.witness` : event.type;
  const inserted = await tx
    .insert(notifications)
    .values({
      userId: r.requestedBy,
      eventId: event.id,
      type: event.type,
      materialId: r.materialId,
      priority: 'normal',
      title: notificationTitle(titleKey, opts.locale, { ref: materialRef(r.materialId) }),
      assignmentState: null,
    })
    .onConflictDoNothing({ target: [notifications.userId, notifications.eventId] })
    .returning({ id: notifications.id });
  return inserted.length;
}

/**
 * إسناد المادة (ADR 0096) بآلية مهام الإشعارات القائمة: «أُسندت» إشعار مهمة للمونتير (assignment_state = assigned) بسلّم
 * التصعيد الافتراضي للعاجل والمهم وبدفع، ومعرّف المهمة فيه. فإن أقرّها قبل أن يصل المُرسل إلى الحدث وصل الإشعار مُقرًّا بلا
 * تصعيد. والتسليم والإعادة يُعلمان الطرف الآخر داخل المنصة، والإعادة بدفع كذلك. العنوان رقم المادة وحده بقالب الخادم، بلا
 * ملاحظة ولا موعد ولا اسم. لا تدخل قواعد التنبيه الإدارية.
 */
async function assignmentEvent(tx: Tx, event: OutboxRow, payload: Record<string, unknown>, opts: FanOutOptions): Promise<number> {
  const assignmentId = typeof payload.assignment_id === 'string' ? payload.assignment_id : undefined;
  if (!assignmentId) return 0;
  const [a] = await tx
    .select({
      id: materialAssignments.id,
      materialId: materialAssignments.materialId,
      assigneeId: materialAssignments.assigneeId,
      assignedBy: materialAssignments.assignedBy,
      state: materialAssignments.state,
      priority: materials.priority,
    })
    .from(materialAssignments)
    .innerJoin(materials, eq(materials.id, materialAssignments.materialId))
    .where(eq(materialAssignments.id, assignmentId))
    // قفل مشترك: انتقال متزامن (قفل كامل) ينتظر حتى يُثبَّت الإشعار فيقرّه، أو يسبقه فيُقرأ بعده بحالته الجديدة
    .for('share', { of: materialAssignments });
  if (!a) return 0;
  const ref = materialRef(a.materialId);
  if (event.type === 'assignment.created') {
    const pending = a.state === 'assigned';
    const delay = pending ? opts.escalationSeconds[a.priority as 'urgent'] : undefined;
    const rows = await tx
      .insert(notifications)
      .values({
        userId: a.assigneeId,
        eventId: event.id,
        type: event.type,
        materialId: a.materialId,
        title: notificationTitle(event.type, opts.locale, { ref }),
        priority: a.priority,
        assignmentState: pending ? 'assigned' : 'acknowledged',
        ...(pending ? {} : { state: 'acknowledged', readAt: sql`now()`, acknowledgedAt: sql`now()` }),
        escalateAt: delay ? sql`now() + make_interval(secs => ${delay})` : null,
        assignmentId: a.id,
      })
      .onConflictDoNothing({ target: [notifications.userId, notifications.eventId] })
      .returning({ id: notifications.id });
    if (opts.push && pending) await enqueuePush(tx, rows.map((r) => r.id));
    return rows.length;
  }
  const to = payload.to;
  if (to !== 'done' && to !== 'returned') return 0;
  const recipients = [...new Set([a.assigneeId, a.assignedBy])].filter((id) => id !== event.actorId);
  if (recipients.length === 0) return 0;
  const title = notificationTitle(`assignment.${to}`, opts.locale, { ref });
  const rows = await tx
    .insert(notifications)
    .values(
      recipients.map((userId) => ({
        userId,
        eventId: event.id,
        type: event.type,
        materialId: a.materialId,
        title,
        priority: a.priority,
        assignmentState: null,
        assignmentId: a.id,
      })),
    )
    .onConflictDoNothing({ target: [notifications.userId, notifications.eventId] })
    .returning({ id: notifications.id });
  if (opts.push && to === 'returned') await enqueuePush(tx, rows.map((r) => r.id));
  return rows.length;
}

/** تنبيه لصاحب الحساب وحده بقالب ثابت (إكمال الاستعادة، وإضافة مفتاح مرور، وتوليد رموز احتياطية). */
async function ownerAlert(tx: Tx, event: OutboxRow, titleKey: string, opts: FanOutOptions): Promise<number> {
  const inserted = await tx
    .insert(notifications)
    .values({
      userId: event.aggregateId,
      eventId: event.id,
      type: event.type,
      materialId: null,
      priority: 'important',
      title: notificationTitle(titleKey, opts.locale, { ref: '' }),
      assignmentState: null,
      recoveryRequestId: null,
    })
    .onConflictDoNothing({ target: [notifications.userId, notifications.eventId] })
    .returning({ id: notifications.id });
  if (opts.push) await enqueuePush(tx, inserted.map((r) => r.id));
  return inserted.length;
}
