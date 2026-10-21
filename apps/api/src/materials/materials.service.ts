import { Inject, Injectable, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { and, asc, desc, eq, isNotNull, lt, sql, type SQL } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { Logger } from 'pino';
import { APP_CONFIG, type AppConfig, fieldKeyring } from '../config/config';
import type { FieldKeyring } from '../common/crypto';
import { pgError } from '../common/db-errors';
import { ApiError } from '../common/errors';
import { assertIfMatch } from '../common/preconditions';
import { LOGGER } from '../common/logger';
import { DB, type Database, type Tx } from '../database/database.module';
import { materialContributors, materials, materialTransitions, offices } from '../database/schema/schema';
import { storedDynamicFields, validateDynamicFields } from '../forms/dynamic-fields';
import { FormsService } from '../forms/forms.service';
import type { components } from '../generated/api';
import { hasRole, type Principal } from '../identity/principal';
import { writeOutboxEvent } from '../outbox/outbox';
import {
  applyTransition,
  findScoped,
  canEditMaterial,
  iso,
  materialPayload,
  materialSelection,
  type MaterialDto,
  type MaterialRow,
  roleCovers,
  scopeCondition,
  toMaterialDtos,
} from './material-store';
import { APPROVED_STATES, transitionOwners, STATE_COLUMN, type Track } from './transitions';

type MaterialCreate = components['schemas']['MaterialCreate'];
type MaterialUpdate = components['schemas']['MaterialUpdate'];
type Transition = components['schemas']['Transition'];
type Contributor = components['schemas']['Contributor'];
type Reservation = components['schemas']['Reservation'];
type TransitionRecord = components['schemas']['TransitionRecord'];

export interface ListQuery {
  editorial_state?: string;
  technical_state?: string;
  rights_state?: string;
  priority?: string;
  governorate?: string;
  reporter_id?: string;
  shot_after?: string;
  shot_before?: string;
  sort?: Sort;
  cursor?: string;
  limit?: number;
}

type Sort = 'created_desc' | 'created_asc' | 'shot_desc' | 'updated_desc';

@Injectable()
export class MaterialsService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly fieldKeys: FieldKeyring;
  private sweepTimer: NodeJS.Timeout | undefined;

  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(LOGGER) private readonly logger: Logger,
    private readonly forms: FormsService,
  ) {
    this.fieldKeys = fieldKeyring(config);
  }

  onApplicationBootstrap(): void {
    if (!this.config.RESERVATION_SWEEP_ENABLED) return;
    this.sweepTimer = setInterval(() => {
      this.releaseIdleReservations().catch((err: unknown) =>
        this.logger.error({ err_name: (err as Error)?.name }, 'reservation sweep failed'),
      );
    }, 60_000);
  }

  onApplicationShutdown(): void {
    clearInterval(this.sweepTimer);
  }

  // ---------- القراءة ----------

  async get(p: Principal, id: string): Promise<MaterialDto> {
    const row = await findScoped(this.db, p, id);
    if (!row) throw ApiError.notFound();
    return (await this.dtos(p, [row]))[0]!;
  }

  async list(p: Principal, q: ListQuery): Promise<{ items: MaterialDto[]; next_cursor: string | null }> {
    const limit = q.limit ?? 50;
    const where: SQL[] = [scopeCondition(p)];
    if (q.editorial_state) where.push(eq(materials.editorialState, q.editorial_state));
    if (q.technical_state) where.push(eq(materials.technicalState, q.technical_state));
    if (q.rights_state) where.push(eq(materials.rightsState, q.rights_state));
    if (q.priority) where.push(eq(materials.priority, q.priority));
    if (q.governorate) where.push(eq(materials.governorate, q.governorate));
    if (q.reporter_id) where.push(eq(materials.reporterId, q.reporter_id));
    if (q.shot_after) where.push(sql`${materials.shotAt} >= ${q.shot_after}::timestamptz`);
    if (q.shot_before) where.push(sql`${materials.shotAt} < ${q.shot_before}::timestamptz`);
    const sort = q.sort ?? 'created_desc';
    if (q.cursor) where.push(afterCursor(sort, decodeCursor(q.cursor, sort)));
    const rows = (await this.db
      .select(materialSelection)
      .from(materials)
      .leftJoin(offices, eq(offices.id, materials.officeId))
      .where(and(...where))
      .orderBy(...SORT_ORDER[sort])
      .limit(limit + 1)) as MaterialRow[];
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: await this.dtos(p, page),
      next_cursor: rows.length > limit && last ? encodeCursor(sort, sortValue(sort, last), last.id) : null,
    };
  }

  async transitions(p: Principal, id: string): Promise<TransitionRecord[]> {
    if (!(await findScoped(this.db, p, id))) throw ApiError.notFound();
    const rows = await this.db
      .select()
      .from(materialTransitions)
      .where(eq(materialTransitions.materialId, id))
      .orderBy(asc(materialTransitions.id));
    return rows.map((r) => ({
      id: String(r.id),
      track: r.track as Track,
      from: r.fromState,
      to: r.toState,
      reason: r.reason,
      note_timecode_ms: r.noteTimecodeMs,
      actor_id: r.actorId,
      occurred_at: iso(r.occurredAt)!,
    }));
  }

  // ---------- الإنشاء والتعديل ----------

  async create(p: Principal, body: MaterialCreate): Promise<MaterialDto> {
    const form = await this.forms.byVersion(body.form_version);
    if (!form) throw ApiError.validation({ fields: ['/form_version'] });
    const check = validateDynamicFields(form, body.material_types, body.dynamic_fields);
    if (!check.valid) throw dynamicFieldsInvalid(check.errors);
    const contributors = body.contributors ?? [{ user_id: p.userId, role: 'reporter', share_percent: 100 }];
    assertContributors(contributors);
    const displayName = displayNameColumns(body.display_name);

    return this.write(p, async (tx) => {
      const [created] = await tx
        .insert(materials)
        .values({
          reporterId: p.userId,
          officeId: p.officeId,
          title: body.title,
          materialTypes: body.material_types,
          governorate: body.governorate,
          city: body.city,
          shotAt: body.shot_at ?? null,
          priority: body.priority,
          sensitivityMinors: body.sensitivity.minors,
          sensitivityInjured: body.sensitivity.injured,
          sensitivityGraphic: body.sensitivity.graphic,
          ...displayName,
          gpsEnc: body.gps ? this.fieldKeys.encrypt(Buffer.from(JSON.stringify(body.gps))) : null,
          formVersion: body.form_version,
          dynamicFields: storedDynamicFields(body.dynamic_fields, check.visible),
        })
        .returning();
      const m = { ...created!, officeGovernorate: null };
      await this.replaceContributors(tx, m.id, contributors);
      const payload = { ...materialPayload(m), editorial_state: m.editorialState, technical_state: m.technicalState, rights_state: m.rightsState, material_version: m.version };
      await writeOutboxEvent(tx, { type: 'material.created', aggregateType: 'material', aggregateId: m.id, idempotencyKey: `material.created:${m.id}`, actorId: p.userId, payload });
      if (m.priority === 'urgent') {
        await writeOutboxEvent(tx, { type: 'material.urgent_received', aggregateType: 'material', aggregateId: m.id, idempotencyKey: `material.urgent_received:${m.id}`, actorId: p.userId, payload });
      }
      return m.id;
    });
  }

  async update(p: Principal, id: string, body: MaterialUpdate, ifMatch?: string): Promise<MaterialDto> {
    return this.write(p, async (tx) => {
      const m = await findScoped(tx, p, id, { forUpdate: true });
      if (!m) throw ApiError.notFound();
      assertIfMatch(ifMatch, m.rowVersion);
      if (!canEditMaterial(p, m)) throw new ApiError(403, 'forbidden_scope', 'This role may not edit this material.');

      const materialTypes = body.material_types ?? (m.materialTypes as string[]);
      const formVersion = body.form_version ?? m.formVersion;
      const changes: Partial<typeof materials.$inferInsert> = {};
      if (body.dynamic_fields !== undefined || body.form_version !== undefined || body.material_types !== undefined) {
        const form = await this.forms.byVersion(formVersion, tx);
        if (!form) throw ApiError.validation({ fields: ['/form_version'] });
        const values = body.dynamic_fields ?? (m.dynamicFields as Record<string, unknown>);
        const check = validateDynamicFields(form, materialTypes, values);
        if (!check.valid) throw dynamicFieldsInvalid(check.errors);
        Object.assign(changes, { formVersion, dynamicFields: storedDynamicFields(values, check.visible) });
      }
      if (body.title !== undefined) changes.title = body.title;
      if (body.material_types !== undefined) changes.materialTypes = body.material_types;
      if (body.governorate !== undefined) changes.governorate = body.governorate;
      if (body.city !== undefined) changes.city = body.city;
      if (body.shot_at !== undefined) changes.shotAt = body.shot_at;
      if (body.priority !== undefined) changes.priority = body.priority;
      if (body.sensitivity) {
        Object.assign(changes, {
          sensitivityMinors: body.sensitivity.minors,
          sensitivityInjured: body.sensitivity.injured,
          sensitivityGraphic: body.sensitivity.graphic,
        });
      }
      if (body.display_name) Object.assign(changes, displayNameColumns(body.display_name));

      // تعديل إصدار معتمد: version + 1 وعودة إلى final_review لأن ما يُعتمد إصدار محدد (العقد)
      const approved = (APPROVED_STATES as readonly string[]).includes(m.editorialState);
      if (approved) changes.version = m.version + 1;
      const [saved] = await tx.update(materials).set(changes).where(eq(materials.id, m.id)).returning();
      let current: MaterialRow = { ...saved!, officeGovernorate: m.officeGovernorate };
      if (approved && current.editorialState !== 'final_review') {
        current = await applyTransition(tx, current, {
          track: 'editorial',
          to: 'final_review',
          reason: 'edited after approval',
          actorId: p.userId,
        });
      }
      const type = approved ? 'material.version_created' : 'material.updated';
      await writeOutboxEvent(tx, {
        type,
        aggregateType: 'material',
        aggregateId: m.id,
        idempotencyKey: approved ? `${type}:${m.id}:v${current.version}` : `${type}:${m.id}:${randomUUID()}`,
        actorId: p.userId,
        payload: { ...materialPayload(current), material_version: current.version, editorial_state: current.editorialState },
      });
      return m.id;
    });
  }

  // ---------- الانتقالات ----------

  async transition(p: Principal, id: string, body: Transition, ifMatch?: string): Promise<MaterialDto> {
    return this.write(p, async (tx) => {
      const m = await findScoped(tx, p, id, { forUpdate: true });
      if (!m) throw ApiError.notFound();
      assertIfMatch(ifMatch, m.rowVersion);
      const from = m[STATE_COLUMN[body.track]];
      const owners = transitionOwners(body.track, from, body.to);
      if (!owners) {
        throw new ApiError(409, 'invalid_transition', `Transition ${from} → ${body.to} is not allowed on the ${body.track} track.`, {
          track: body.track,
          from,
          to: body.to,
        });
      }
      const allowed = owners.some((o) => {
        switch (o) {
          case 'server':
          case 'reservation':
            return false;
          case 'reporter_owner':
            return hasRole(p, 'reporter') && m.reporterId === p.userId;
          case 'reservation_holder':
            return hasRole(p, 'producer') && m.reservedBy === p.userId && this.reservationLive(m);
          default:
            return roleCovers(p, o, m);
        }
      });
      if (!allowed) {
        const hint = owners.includes('reservation') ? ' Use the reservation endpoint.' : '';
        throw new ApiError(403, 'forbidden_scope', `This role may not perform this transition.${hint}`);
      }
      // الإعادة من الإنتاج إلى accepted تحرر الحجز
      const extra = body.track === 'editorial' && body.to === 'accepted' && from === 'in_production' ? { reservedBy: null, reservedAt: null } : {};
      await applyTransition(tx, m, { track: body.track, to: body.to, reason: body.reason, actorId: p.userId, noteTimecodeMs: body.note_timecode_ms }, extra);
      return m.id;
    });
  }

  // ---------- المساهمون ----------

  async setContributors(p: Principal, id: string, contributors: Contributor[], ifMatch?: string): Promise<MaterialDto> {
    assertContributors(contributors);
    return this.write(p, async (tx) => {
      const m = await findScoped(tx, p, id, { forUpdate: true });
      if (!m) throw ApiError.notFound();
      assertIfMatch(ifMatch, m.rowVersion);
      await this.replaceContributors(tx, m.id, contributors);
      await writeOutboxEvent(tx, {
        type: 'material.contributors_set',
        aggregateType: 'material',
        aggregateId: m.id,
        idempotencyKey: `material.contributors_set:${m.id}:${randomUUID()}`,
        actorId: p.userId,
        payload: materialPayload(m),
      });
      return m.id;
    });
  }

  // ---------- الحجز ----------

  async reserve(p: Principal, id: string, ifMatch?: string): Promise<Reservation> {
    return this.db.transaction(async (tx) => {
      const m = await findScoped(tx, p, id, { forUpdate: true });
      if (!m) throw ApiError.notFound();
      assertIfMatch(ifMatch, m.rowVersion);
      if (m.editorialState !== 'accepted' && m.editorialState !== 'in_production') {
        throw new ApiError(409, 'invalid_transition', 'Only accepted materials can be reserved for production.', {
          track: 'editorial',
          from: m.editorialState,
          to: 'in_production',
        });
      }
      if (m.reservedBy && m.reservedBy !== p.userId && this.reservationLive(m)) {
        throw new ApiError(409, 'already_reserved', 'Material is reserved by another producer.');
      }
      const renewal = m.reservedBy === p.userId && this.reservationLive(m);
      const [stamp] = await tx.execute<{ now: string }>(sql`SELECT now()::text AS now`).then((r) => r.rows);
      const reservation = { reservedBy: p.userId, reservedAt: stamp!.now };
      if (m.editorialState === 'accepted') {
        await applyTransition(tx, m, { track: 'editorial', to: 'in_production', reason: 'reserved for production', actorId: p.userId }, reservation);
      } else {
        await tx.update(materials).set(reservation).where(eq(materials.id, m.id));
      }
      if (!renewal) {
        await writeOutboxEvent(tx, {
          type: 'material.reserved',
          aggregateType: 'material',
          aggregateId: m.id,
          idempotencyKey: `material.reserved:${m.id}:${stamp!.now}`,
          actorId: p.userId,
          payload: { ...materialPayload(m), reserved_by: p.userId },
        });
      }
      const at = new Date(stamp!.now);
      return {
        material_id: m.id,
        reserved_by: p.userId,
        reserved_at: at.toISOString(),
        releases_at: new Date(at.getTime() + this.config.RESERVATION_IDLE_SECONDS * 1000).toISOString(),
      };
    });
  }

  async release(p: Principal, id: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const m = await findScoped(tx, p, id, { forUpdate: true });
      if (!m) throw ApiError.notFound();
      if (!m.reservedBy || !this.reservationLive(m)) return;
      const may =
        (hasRole(p, 'producer') && m.reservedBy === p.userId) ||
        roleCovers(p, 'supervisor', m) ||
        hasRole(p, 'editor_in_chief', 'system_admin');
      if (!may) throw new ApiError(403, 'forbidden_scope', 'Only the holder or a supervisor may release this reservation.');
      await tx.update(materials).set({ reservedBy: null, reservedAt: null }).where(eq(materials.id, m.id));
      await writeOutboxEvent(tx, {
        type: 'material.released',
        aggregateType: 'material',
        aggregateId: m.id,
        idempotencyKey: `material.released:${m.id}:${m.reservedAt}`,
        actorId: p.userId,
        payload: materialPayload(m),
      });
    });
  }

  /** تحرير الحجوزات الخاملة (ينفّذه مؤقت كل دقيقة)؛ يعيد عدد ما حُرِّر. */
  async releaseIdleReservations(): Promise<number> {
    return this.db.transaction(async (tx) => {
      const idle = await tx
        .select({ id: materials.id, priority: materials.priority, officeId: materials.officeId, reservedAt: materials.reservedAt })
        .from(materials)
        .where(and(isNotNull(materials.reservedBy), lt(materials.reservedAt, sql`now() - make_interval(secs => ${this.config.RESERVATION_IDLE_SECONDS})`)))
        .for('update', { skipLocked: true });
      for (const m of idle) {
        await tx.update(materials).set({ reservedBy: null, reservedAt: null }).where(eq(materials.id, m.id));
        await writeOutboxEvent(tx, {
          type: 'material.released',
          aggregateType: 'material',
          aggregateId: m.id,
          idempotencyKey: `material.released:${m.id}:${m.reservedAt}`,
          payload: { material_id: m.id, priority: m.priority, ...(m.officeId ? { office_id: m.officeId } : {}) },
        });
      }
      return idle.length;
    });
  }

  // ---------- مساعدات ----------

  private reservationLive(m: MaterialRow): boolean {
    return m.reservedAt !== null && Date.parse(m.reservedAt) + this.config.RESERVATION_IDLE_SECONDS * 1000 > Date.now();
  }

  private async dtos(p: Principal, rows: MaterialRow[]): Promise<MaterialDto[]> {
    return toMaterialDtos(this.db, p, rows, this.config.RESERVATION_IDLE_SECONDS, this.fieldKeys);
  }

  /** ينفّذ كتابة في معاملة ثم يعيد المادة كما يراها المستدعي؛ يحوّل أخطاء القيود إلى أكواد العقد. */
  private async write(p: Principal, fn: (tx: Tx) => Promise<string>): Promise<MaterialDto> {
    let id: string;
    try {
      id = await this.db.transaction(fn);
    } catch (err) {
      const { code, constraint } = pgError(err);
      if (code === '23514' && constraint === 'material_contributors_sum_100') throw sharesNot100();
      if (code === '23503' || code === '23514' || code === '22P02') throw ApiError.validation({ constraint: constraint ?? null });
      throw err;
    }
    return this.get(p, id);
  }

  private async replaceContributors(tx: Tx, materialId: string, contributors: Contributor[]): Promise<void> {
    await tx.delete(materialContributors).where(eq(materialContributors.materialId, materialId));
    await tx.insert(materialContributors).values(
      contributors.map((c) => ({ materialId, userId: c.user_id, role: c.role, sharePercent: c.share_percent.toFixed(2) })),
    );
  }
}

function dynamicFieldsInvalid(errors: Array<{ field: string; code: string }>): ApiError {
  return new ApiError(422, 'dynamic_fields_invalid', 'Dynamic fields failed validation.', { errors });
}

function sharesNot100(): ApiError {
  return new ApiError(422, 'shares_not_100', 'Contributor shares must sum to exactly 100.00.');
}

/** المجموع بالسنتات لتجنب أخطاء الفاصلة العائمة؛ مساهم واحد لكل مستخدم (المفتاح الأساسي). */
function assertContributors(contributors: Contributor[]): void {
  const ids = contributors.map((c) => c.user_id);
  if (new Set(ids).size !== ids.length) throw ApiError.validation({ fields: ['/contributors'] });
  const cents = contributors.reduce((sum, c) => sum + Math.round(c.share_percent * 100), 0);
  if (cents !== 10_000) throw sharesNot100();
}

function displayNameColumns(d: components['schemas']['DisplayName']) {
  if (d.mode === 'pseudonym' && !d.pseudonym) throw ApiError.validation({ fields: ['/display_name/pseudonym'] });
  return { displayNameMode: d.mode, displayNamePseudonym: d.mode === 'pseudonym' ? d.pseudonym! : null };
}

/**
 * الترتيب (v0.2): لكل قيمة فهرس مؤشر (ADR 0002). shot_desc يضع غير المؤرَّخ أولًا كترتيب الفهرس (DESC = NULLS FIRST).
 */
const SORT_ORDER: Record<Sort, SQL[]> = {
  created_desc: [desc(materials.createdAt), desc(materials.id)],
  created_asc: [asc(materials.createdAt), asc(materials.id)],
  shot_desc: [sql`${materials.shotAt} DESC NULLS FIRST`, desc(materials.id)],
  updated_desc: [desc(materials.updatedAt), desc(materials.id)],
};

function sortValue(sort: Sort, m: MaterialRow): string | null {
  return sort === 'shot_desc' ? m.shotAt : sort === 'updated_desc' ? m.updatedAt : m.createdAt;
}

function afterCursor(sort: Sort, c: { at: string | null; id: string }): SQL {
  if (sort === 'created_asc') return sql`(${materials.createdAt}, ${materials.id}) > (${c.at}::timestamptz, ${c.id}::uuid)`;
  if (sort === 'updated_desc') return sql`(${materials.updatedAt}, ${materials.id}) < (${c.at}::timestamptz, ${c.id}::uuid)`;
  if (sort === 'shot_desc') {
    return c.at === null
      ? sql`(${materials.shotAt} IS NOT NULL OR ${materials.id} < ${c.id}::uuid)`
      : sql`(${materials.shotAt} IS NOT NULL AND (${materials.shotAt}, ${materials.id}) < (${c.at}::timestamptz, ${c.id}::uuid))`;
  }
  return sql`(${materials.createdAt}, ${materials.id}) < (${c.at}::timestamptz, ${c.id}::uuid)`;
}

function encodeCursor(sort: Sort, at: string | null, id: string): string {
  // مؤشر v0 بعنصرين يبقى صالحًا للترتيب الافتراضي
  return Buffer.from(JSON.stringify(sort === 'created_desc' ? [at, id] : [at, id, sort])).toString('base64url');
}

/** المؤشر يخص الترتيب الذي صدر به؛ تغيير sort مع مؤشر قديم 400. */
function decodeCursor(cursor: string, sort: Sort): { at: string | null; id: string } {
  try {
    const [at, id, issuedFor = 'created_desc'] = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as [unknown, unknown, unknown];
    const validAt = (typeof at === 'string' && !Number.isNaN(Date.parse(at))) || (at === null && sort === 'shot_desc');
    if (validAt && typeof id === 'string' && /^[0-9a-f-]{36}$/i.test(id) && issuedFor === sort) {
      return { at: at as string | null, id };
    }
  } catch {
    // يقع إلى 400 أدناه
  }
  throw new ApiError(400, 'bad_request', 'Invalid cursor.', { params: ['cursor'] });
}
