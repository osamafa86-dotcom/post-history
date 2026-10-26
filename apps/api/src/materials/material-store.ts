import { and, asc, eq, getTableColumns, inArray, sql, type SQL } from 'drizzle-orm';
import type { Executor, Tx } from '../database/database.module';
import { auditLog, materialContributors, materialFiles, materials, materialTransitions, offices, uploadForms, users } from '../database/schema/schema';
import type { FieldKeyring } from '../common/crypto';
import type { UploadForm } from '../forms/dynamic-fields';
import type { components } from '../generated/api';
import type { Permission, Principal, RoleName } from '../identity/principal';
import { suspendListing } from '../commerce/listing-store';
import { writeOutboxEvent, type OutboxEventType } from '../outbox/outbox';
import { redactDynamicFields } from './redaction';
import { PRODUCTION_VISIBLE_STATES, STATE_COLUMN, type Track } from './transitions';

export type MaterialRow = typeof materials.$inferSelect & { officeGovernorate: string | null };
export type MaterialDto = components['schemas']['Material'];

/**
 * نطاق الرؤية في طبقة الاستعلام (العقد، ADR SEC-03): المراسل مواده، المشرف مواد نطاقه (مكتب أو محافظة المكتب)،
 * الإنتاج المواد المقبولة فما بعدها، ورئيس التحرير ومدير النظام ومسؤول الحقوق كل المواد. اتحاد أدوار المستخدم.
 */
export function scopeCondition(p: Principal): SQL {
  // المنشئ يرى ما أنشأه أيًّا كان دوره (رفع الطاقم من الويب، #88)، وفوقه نطاق دوره
  const parts: SQL[] = [sql`${materials.reporterId} = ${p.userId}`];
  for (const r of p.roles) {
    switch (r.role) {
      case 'editor_in_chief':
      case 'system_admin':
      case 'rights_officer':
        return sql`true`;
      case 'reporter':
        break;
      case 'producer':
        parts.push(sql`${materials.editorialState} IN (${sql.join(PRODUCTION_VISIBLE_STATES.map((s) => sql`${s}`), sql`, `)})`);
        break;
      case 'supervisor':
        if (r.scopeKind === 'all') return sql`true`;
        parts.push(
          r.scopeKind === 'office'
            ? sql`${materials.officeId}::text = ${r.scopeId}`
            : sql`${offices.governorate} = ${r.scopeId}`,
        );
        break;
      default:
        break;
    }
  }
  return parts.length ? sql`(${sql.join(parts, sql` OR `)})` : sql`false`;
}

/** هل يغطي دور بعينه (ضمن نطاقه) هذه المادة؟ لصلاحيات الفعل لا الرؤية. */
export function roleCovers(p: Principal, role: RoleName, m: MaterialRow): boolean {
  return p.roles.some(
    (r) =>
      r.role === role &&
      (r.scopeKind === 'all' ||
        (r.scopeKind === 'office' && r.scopeId === m.officeId) ||
        (r.scopeKind === 'governorate' && r.scopeId === m.officeGovernorate)),
  );
}

/** من يملك تعديل المادة: مراسلها، ومشرف يغطيها، ورئيس التحرير ومدير النظام (PATCH /materials/{id}). */
/**
 * التفريغ والترجمة حساسان افتراضيًا (R11، threat-model §9.1): لا يراهما في قائمة الملفات ولا يصدر رابطهما إلا من يملك
 * تعديل المادة، وغيره لا يُلمَّح له بوجودهما.
 */
// shot_list يحمل مقتطفات من التفريغ (الوكيل 5)، فحكمه حكمهما
// حزمة التصدير برابطها الخاص، ومعاينة المشتري المائية برابط الكتالوج وحده (v0.3)
const HIDDEN_FROM_FILES: readonly string[] = ['export', 'watermarked_preview'];

export const EDITOR_ONLY_KINDS: readonly string[] = ['transcript', 'captions', 'shot_list'];

export function canEditMaterial(p: Principal, m: MaterialRow): boolean {
  return (
    (p.roles.some((r) => r.role === 'reporter') && m.reporterId === p.userId) ||
    roleCovers(p, 'supervisor', m) ||
    p.roles.some((r) => r.role === 'editor_in_chief' || r.role === 'system_admin')
  );
}

const selection = { ...getTableColumns(materials), officeGovernorate: offices.governorate };

/** يقرأ مادة ضمن نطاق المستخدم؛ خارج النطاق = undefined (404). forUpdate يقفل الصف حتى نهاية المعاملة. */
export async function findScoped(
  executor: Executor,
  p: Principal,
  id: string,
  opts: { forUpdate?: boolean } = {},
): Promise<MaterialRow | undefined> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return undefined;
  const q = executor
    .select(selection)
    .from(materials)
    .leftJoin(offices, eq(offices.id, materials.officeId))
    .where(and(eq(materials.id, id), scopeCondition(p)));
  const [row] = await (opts.forUpdate ? q.for('update', { of: materials }) : q);
  return row as MaterialRow | undefined;
}

export const materialSelection = selection;

/** قراءة الخادم نفسه (خطّافات الرفع) بلا نطاق مستخدم، مقفولة حتى نهاية المعاملة. */
export async function lockMaterial(tx: Tx, id: string): Promise<MaterialRow | undefined> {
  const [row] = await tx
    .select(selection)
    .from(materials)
    .leftJoin(offices, eq(offices.id, materials.officeId))
    .where(eq(materials.id, id))
    .for('update', { of: materials });
  return row as MaterialRow | undefined;
}

/** الحالة الفنية التي يبلغها وصول ملف من نوع معيّن، إن كان الانتقال مسموحًا من الحالة الحالية (المالك: الخادم). */
export function technicalTargetOnReceive(kind: string, current: string): string | undefined {
  if (kind === 'proxy' && current === 'pending') return 'proxy_received';
  if (kind === 'original' && (current === 'pending' || current === 'proxy_received')) return 'original_received';
  return undefined;
}

/**
 * يبني استجابات Material لعدة صفوف دفعة واحدة، مع الحجب وتسجيل كل قراءة غير محجوبة لحقل حساس. الاسم الحقيقي للمراسل
 * (v0.2) لحامل الصلاحية التي يحددها الإعداد الإداري (`legalName.permission`، ADR 0021) ويغيب مفتاحه لغيره؛ يُفك بالحلقة
 * ويُسجَّل مع بقية الحقول المكشوفة.
 */
export async function toMaterialDtos(
  executor: Executor,
  p: Principal,
  rows: MaterialRow[],
  idleSeconds: number,
  legalName?: { keyring: FieldKeyring; permission: Permission },
): Promise<MaterialDto[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const legalNames = new Map<string, string | null>();
  if (legalName && p.permissions.has(legalName.permission)) {
    const reporters = [...new Set(rows.map((r) => r.reporterId))];
    for (const u of await executor.select({ id: users.id, enc: users.legalNameEnc }).from(users).where(inArray(users.id, reporters))) {
      legalNames.set(u.id, u.enc ? legalName.keyring.decrypt(u.enc).toString('utf8') : null);
    }
  }
  const files = await executor.select().from(materialFiles).where(inArray(materialFiles.materialId, ids)).orderBy(asc(materialFiles.createdAt));
  const contributors = await executor
    .select()
    .from(materialContributors)
    .where(inArray(materialContributors.materialId, ids))
    .orderBy(asc(materialContributors.userId));
  const versions = [...new Set(rows.map((r) => r.formVersion))];
  const forms = new Map(
    (await executor.select().from(uploadForms).where(inArray(uploadForms.version, versions))).map((f) => [f.version, f.schema as UploadForm]),
  );

  const dtos: MaterialDto[] = [];
  for (const m of rows) {
    const { fields, redacted, disclosed } = redactDynamicFields(forms.get(m.formVersion), m.dynamicFields as Record<string, unknown>, p.permissions);
    const legalName = legalNames.get(m.reporterId);
    if (legalName != null) disclosed.push('reporter_legal_name');
    if (disclosed.length > 0) {
      await executor.insert(auditLog).values({
        actorId: p.userId,
        action: 'material.sensitive_read',
        targetType: 'material',
        targetId: m.id,
        details: { material_id: m.id, field_keys: disclosed },
        hash: Buffer.alloc(32), // يحسبه محفّز سلسلة التجزئة
      });
    }
    const editor = canEditMaterial(p, m);
    const reservationLive = m.reservedAt !== null && Date.parse(m.reservedAt) + idleSeconds * 1000 > Date.now();
    dtos.push({
      id: m.id,
      version: m.version,
      reporter_id: m.reporterId,
      office_id: m.officeId,
      title: m.title,
      material_types: m.materialTypes as MaterialDto['material_types'],
      governorate: m.governorate,
      city: m.city,
      shot_at: iso(m.shotAt),
      priority: m.priority as MaterialDto['priority'],
      sensitivity: { minors: m.sensitivityMinors, injured: m.sensitivityInjured, graphic: m.sensitivityGraphic },
      display_name: { mode: m.displayNameMode as 'real_name' | 'pseudonym' | 'network', pseudonym: m.displayNamePseudonym },
      form_version: m.formVersion,
      dynamic_fields: fields,
      redacted_field_keys: redacted,
      contributors: contributors
        .filter((c) => c.materialId === m.id)
        .map((c) => ({ user_id: c.userId, role: c.role as 'reporter', share_percent: Number(c.sharePercent) })),
      voice_note_upload_id: null,
      technical_state: m.technicalState as MaterialDto['technical_state'],
      editorial_state: m.editorialState as MaterialDto['editorial_state'],
      rights_state: m.rightsState as MaterialDto['rights_state'],
      reserved_by: reservationLive ? m.reservedBy : null,
      reserved_at: reservationLive ? iso(m.reservedAt) : null,
      acknowledged_by: m.acknowledgedBy,
      acknowledged_at: iso(m.acknowledgedAt),
      ...(legalNames.has(m.reporterId) ? { reporter_legal_name: legalName ?? null } : {}),
      files: files
        // حزمة التصدير ليست MaterialFile في العقد؛ حالتها من /materials/{id}/export
        .filter((f) => f.materialId === m.id && !HIDDEN_FROM_FILES.includes(f.kind) && (editor || !EDITOR_ONLY_KINDS.includes(f.kind)))
        .map((f) => ({
          id: f.id,
          kind: f.kind as 'original',
          state: f.state as 'received',
          proxy_mode: f.proxyMode as 'normal' | null,
          ...(f.kind === 'proxy' ? { alignment: alignmentOf(f) } : {}),
          size_bytes: f.sizeBytes,
          sha256: f.sha256 ? f.sha256.toString('hex') : null,
          mime_type: f.mimeType,
          duration_ms: f.durationMs,
          start_pts_us: f.startPtsUs,
          width: f.width,
          height: f.height,
          receipt_number: f.receiptNumber,
          created_at: iso(f.createdAt)!,
          verified_at: iso(f.verifiedAt),
        })),
      created_at: iso(m.createdAt)!,
      updated_at: iso(m.updatedAt)!,
      row_version: m.rowVersion,
    });
  }
  return dtos;
}

export function iso(v: string | null): string | null {
  return v === null ? null : new Date(v).toISOString();
}

/** مفاتيح حمولة أحداث المادة (القائمة البيضاء في outbox_payload_allowed_keys). */
export function materialPayload(m: MaterialRow): Record<string, string | number> {
  return { material_id: m.id, priority: m.priority, ...(m.officeId ? { office_id: m.officeId } : {}) };
}

const SEMANTIC_EDITORIAL_EVENT: Record<string, OutboxEventType> = {
  acknowledged: 'material.acknowledged',
  needs_changes: 'material.change_requested',
  accepted: 'material.accepted_for_production',
  published: 'material.published',
};

/**
 * يطبّق انتقالًا مسموحًا (تحقق المستدعي من الجدول والمالك) داخل المعاملة: العمود، سجل الانتقال، وحدث Outbox
 * للمسار، وحدث دلالي للحالات التحريرية التي تطلق إشعارات. يعيد الصف بعد التحديث.
 */
export async function applyTransition(
  tx: Tx,
  m: MaterialRow,
  t: { track: Track; to: string; reason: string; actorId: string | null; noteTimecodeMs?: number | null },
  extra: Partial<typeof materials.$inferInsert> = {},
): Promise<MaterialRow> {
  const column = STATE_COLUMN[t.track];
  const from = m[column];
  // إدراج معروض يُعلَّق قبل أن تخرج حقوق مادته من sellable، في المعاملة نفسها (محفّز القاعدة يرفض العكس)
  if (t.track === 'rights' && from === 'sellable' && t.to !== 'sellable') await suspendListing(tx, m.id, 'rights_changed', t.actorId);
  // «اطّلعت» (v0.2): من نقل المادة من inbox إلى acknowledged ومتى، فيراه المراسل
  const seen = t.track === 'editorial' && t.to === 'acknowledged' && t.actorId ? { acknowledgedBy: t.actorId, acknowledgedAt: sql`now()` } : {};
  const [updated] = await tx
    .update(materials)
    .set({ [column]: t.to, ...seen, ...extra })
    .where(eq(materials.id, m.id))
    .returning();
  const [record] = await tx
    .insert(materialTransitions)
    .values({
      materialId: m.id,
      track: t.track,
      fromState: from,
      toState: t.to,
      reason: t.reason,
      noteTimecodeMs: t.noteTimecodeMs ?? null,
      actorId: t.actorId,
    })
    .returning({ id: materialTransitions.id });
  const note: Record<string, number> = t.noteTimecodeMs != null ? { note_timecode_ms: t.noteTimecodeMs } : {};
  await writeOutboxEvent(tx, {
    type: `material.${t.track}_transition` as OutboxEventType,
    aggregateType: 'material',
    aggregateId: m.id,
    idempotencyKey: `material.${t.track}_transition:${record!.id}`,
    actorId: t.actorId,
    payload: { ...materialPayload(m), track: t.track, from, to: t.to, ...note },
  });
  const semantic = t.track === 'editorial' ? SEMANTIC_EDITORIAL_EVENT[t.to] : undefined;
  if (semantic) {
    await writeOutboxEvent(tx, {
      type: semantic,
      aggregateType: 'material',
      aggregateId: m.id,
      idempotencyKey: `${semantic}:${record!.id}`,
      actorId: t.actorId,
      payload: { ...materialPayload(m), editorial_state: t.to, material_version: updated!.version, ...note },
    });
  }
  return { ...updated!, officeGovernorate: m.officeGovernorate };
}

/** محاذاة النسخة الخفيفة كما في العقد (MediaAlignment، v0.3)، أو null قبل القياس. أرقام فقط. */
function alignmentOf(f: typeof materialFiles.$inferSelect): components['schemas']['MediaAlignment'] | null {
  if (f.alignmentOriginalFileId === null || f.alignmentReliable === null) return null;
  return {
    original_file_id: f.alignmentOriginalFileId,
    offset_ms: f.alignmentOffsetMs!,
    confidence: f.alignmentConfidence!,
    margin: f.alignmentMargin!,
    reliable: f.alignmentReliable,
  };
}
