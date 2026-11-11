import { type CallHandler, type ExecutionContext, HttpException, Inject, Injectable, type NestInterceptor } from '@nestjs/common';
import { HTTP_CODE_METADATA } from '@nestjs/common/constants';
import { ModuleRef, Reflector } from '@nestjs/core';
import { and, eq, sql } from 'drizzle-orm';
import type { Request } from 'express';
import type { Logger } from 'pino';
import { catchError, from, mergeMap, type Observable, throwError } from 'rxjs';
import { canonicalJson } from '../common/canonical-json';
import { sha256 } from '../common/crypto';
import { ApiError, StoredResponse } from '../common/errors';
import { errorLogFields, toErrorResponse } from '../common/error.filter';
import { LOGGER } from '../common/logger';
import { DB, type Database } from '../database/database.module';
import { idempotencyKeys } from '../database/schema/schema';
import { MaterialsService } from '../materials/materials.service';
import { idempotencySlot, type IdempotencySlot } from './commit-marker';
import { REPLAY_KEY, type ReplayRehydrator } from './replay';

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const KEY_PATTERN = /^[\x21-\x7e]{8,128}$/;
// طلب «قيد التنفيذ» أقدم من هذا يُعد متروكًا (انهيار العملية) فيُسمح للتكرار بالجسم نفسه أن يتولاه
const IN_PROGRESS_LEASE = '5 minutes';

/** هل يخضع المسار لـ Idempotency-Key؟ كل كتابة تحت /v1 عدا /v1/auth/* (العقد، «القواعد الحاكمة»). */
export function requiresIdempotencyKey(method: string, path: string): boolean {
  return WRITE_METHODS.has(method) && path.startsWith('/v1/') && !path.startsWith('/v1/auth/');
}

/**
 * منع التكرار بدلالات العقد: المفتاح مقيّد بالمستخدم 24 ساعة؛ التكرار بالجسم نفسه يعيد الاستجابة الأولى
 * (الحالة والجسم)، وبجسم مختلف 422 idempotency_key_reused، وما زال قيد التنفيذ 409 idempotency_in_progress.
 * الاستجابات 4xx تُحفظ كما هي؛ 5xx تحرر المفتاح ليعيد العميل المحاولة ما لم تلتزم للطلب كتابة.
 *
 * مرة واحدة على الأكثر (ADR 0005، تعديل 2026-11-11): كتابة المعالج تلتزم مع علامة مفتاحه (`commit-marker.ts`)، فالمفتاح الملتزَم
 * (`committed`) لا يُحرَّر ولا يتولاه تكرار. إن لم يُحفظ له رد (فشل المعالج بعد الالتزام، أو تعذّر الحفظ) فالإعادة عليه 409 ولا تنفّذ.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly reflector: Reflector,
    private readonly moduleRef: ModuleRef,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<Request>();
    if (!requiresIdempotencyKey(req.method, req.path) || !req.auth) return next.handle();

    const key = req.headers['idempotency-key'];
    if (typeof key !== 'string' || !KEY_PATTERN.test(key)) {
      return throwError(() => ApiError.validation({ fields: ['header:Idempotency-Key'] }));
    }
    const userId = req.auth.userId;
    const fingerprint = sha256(`${req.method}\n${req.originalUrl}\n${canonicalJson(req.body)}`);
    const successStatus =
      this.reflector.get<number>(HTTP_CODE_METADATA, context.getHandler()) ?? (req.method === 'POST' ? 201 : 200);

    // أخطاء المطالبة نفسها (إعادة، 409، 422) تمر كما هي؛ التسوية تخص ما بعد تنفيذ المعالج فقط
    const rehydrator = this.reflector.get<new (...args: never[]) => ReplayRehydrator>(REPLAY_KEY, context.getHandler());
    return from(this.claim(userId, key, fingerprint)).pipe(
      // الإعادة: ما حُذف عند الحفظ (رموز) يُعاد بناؤه بمعالج المسار إن وُجد، لا يُخزَّن رمز أبدًا. والمادة المحفوظة مرجعًا تُقرأ من
      // جديد بصلاحيات المستدعي الحالية وتدقيق قراءتها الحساسة (ADR 0116)، لا من جدول المفاتيح
      catchError((err: unknown) => {
        if (!(err instanceof StoredResponse) || err.status >= 300) return throwError(() => err);
        const material = materialReference(err.body);
        if (material) {
          return from(this.moduleRef.get(MaterialsService, { strict: false }).get(req.principal!, material.id)).pipe(
            mergeMap((body) => throwError(() => new StoredResponse(err.status, body))),
          );
        }
        return rehydrator
          ? from(this.moduleRef.get(rehydrator, { strict: false }).rehydrate(err.body, req)).pipe(
              mergeMap((body) => throwError(() => new StoredResponse(err.status, body))),
            )
          : throwError(() => err);
      }),
      mergeMap(() => {
        // المعالج وحده ينفّذ داخل خانة المفتاح: كتابته تلتزم مع علامته، وما يكتبه المعترض بعده ليس منها
        const slot: IdempotencySlot = { userId, key, state: 'open' };
        // تعذّر حفظ نتيجة طلب نجح: الرد يُعاد لصاحبه، والمفتاح يُستهلك (إن لم تستهلكه كتابة المعالج) فلا تنفّذه إعادة
        const settleFailed = (err: unknown) => this.logger.error({ request_id: req.id, ...errorLogFields(err) }, 'idempotency settle failed');
        const store = (status: number, body: unknown) =>
          this.complete(userId, key, status, body).catch(async (err: unknown) => {
            settleFailed(err);
            await this.spend(userId, key).catch(() => undefined);
          });
        return idempotencySlot
          .run(slot, () => next.handle())
          .pipe(
            mergeMap(async (body) => {
              slot.state = 'closed';
              await store(successStatus, body ?? null);
              return body;
            }),
            catchError((err: unknown) => {
              slot.state = 'closed';
              // المعالج يرمي StoredResponse ليرد بحالة نجاح غير حالته الافتراضية (200 لطلب تصدير قائم بدل 202): تُحفظ كما هي
              if (err instanceof StoredResponse) {
                return from(store(err.status, err.body)).pipe(mergeMap(() => throwError(() => err)));
              }
              const { status, body } = toErrorResponse(err, req.id ?? '');
              // الرفض (4xx) يُحفظ كما هو. وما عداه يحرّر المفتاح إن لم تلتزم للطلب كتابة؛ المفتاح الملتزَم يبقى، فالإعادة عليه 409
              const settle =
                status < 500 && (err instanceof ApiError || err instanceof HttpException)
                  ? this.complete(userId, key, status, body).catch((failure: unknown) => {
                      settleFailed(failure);
                      return this.release(userId, key);
                    })
                  : this.release(userId, key);
              return from(settle.catch(() => undefined)).pipe(mergeMap(() => throwError(() => err)));
            }),
          );
      }),
    );
  }

  private async claim(userId: string, key: string, fingerprint: Buffer): Promise<void> {
    const claimed = await this.db
      .insert(idempotencyKeys)
      .values({ userId, key, requestFingerprint: fingerprint })
      .onConflictDoUpdate({
        target: [idempotencyKeys.userId, idempotencyKeys.key],
        set: {
          requestFingerprint: fingerprint,
          state: 'in_progress',
          responseStatus: null,
          responseBody: null,
          createdAt: sql`now()`,
          expiresAt: sql`now() + interval '24 hours'`,
        },
        setWhere: sql`${idempotencyKeys.expiresAt} <= now()
          OR (${idempotencyKeys.state} = 'in_progress'
              AND ${idempotencyKeys.createdAt} < now() - ${IN_PROGRESS_LEASE}::interval
              AND ${idempotencyKeys.requestFingerprint} = ${fingerprint})`,
      })
      .returning({ key: idempotencyKeys.key });
    if (claimed.length > 0) return;

    const [row] = await this.db
      .select()
      .from(idempotencyKeys)
      .where(and(eq(idempotencyKeys.userId, userId), eq(idempotencyKeys.key, key)));
    if (!row) throw new ApiError(409, 'idempotency_in_progress', 'Request is in progress.');
    if (!row.requestFingerprint.equals(fingerprint)) {
      throw new ApiError(422, 'idempotency_key_reused', 'Idempotency-Key was used with a different request.');
    }
    if (row.state !== 'completed') {
      throw new ApiError(409, 'idempotency_in_progress', 'Request is in progress.');
    }
    throw new StoredResponse(row.responseStatus!, row.responseBody);
  }

  private async complete(userId: string, key: string, status: number, body: unknown): Promise<void> {
    await this.db
      .update(idempotencyKeys)
      .set({ state: 'completed', responseStatus: status, responseBody: storable(body) as never })
      .where(and(eq(idempotencyKeys.userId, userId), eq(idempotencyKeys.key, key)));
  }

  /** يحذف الحجز الذي لم تلتزم له كتابة؛ المفتاح الملتزَم لا يمسّه. */
  private async release(userId: string, key: string): Promise<void> {
    await this.db
      .delete(idempotencyKeys)
      .where(and(eq(idempotencyKeys.userId, userId), eq(idempotencyKeys.key, key), eq(idempotencyKeys.state, 'in_progress')));
  }

  /** يستهلك المفتاح بلا رد محفوظ: الإعادة عليه 409 ولا تنفّذ. */
  private async spend(userId: string, key: string): Promise<void> {
    await this.db
      .update(idempotencyKeys)
      .set({ state: 'committed' })
      .where(and(eq(idempotencyKeys.userId, userId), eq(idempotencyKeys.key, key), eq(idempotencyKeys.state, 'in_progress')));
  }
}

/**
 * ما يُحفظ من الاستجابة لإعادتها (ADR 0116): بلا رموز (withoutTokens)، والمادة مرجعًا وحده (`material_replay` بمعرّفها وإصدار صفها) لا
 * جسمها: Material يحمل الاسم الحقيقي المفكوك وقيم الحقول الحساسة والموقع لحامل الصلاحية، فلا يبقى نصًّا صريحًا في جدول المفاتيح، ولا
 * تُعاد لمن سُحبت صلاحيته ولا بلا تدقيق قراءتها.
 */
export function storable(body: unknown): unknown {
  const material = materialBody(body);
  return material ? { material_replay: { id: material.id, row_version: material.row_version } } : withoutTokens(body);
}

/** جسم Material في العقد: معرّف وإصدار صف ومفاتيح الحجب والحقول الديناميكية. */
function materialBody(body: unknown): { id: string; row_version: number } | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  return typeof b.id === 'string' && typeof b.row_version === 'number' && Array.isArray(b.redacted_field_keys) && 'dynamic_fields' in b
    ? { id: b.id, row_version: b.row_version }
    : null;
}

function materialReference(body: unknown): { id: string } | null {
  const ref = (body as { material_replay?: { id?: unknown } } | null)?.material_replay;
  return ref && typeof ref.id === 'string' ? { id: ref.id } : null;
}

/** لا تُحفظ الرموز في جدول المفاتيح (قاعدة المخطط): كل مفتاح علوي اسمه token أو ينتهي بـ _token يُحذف قبل الحفظ. */
export function withoutTokens(body: unknown): unknown {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
  // الرموز ورابط التنزيل الموقّع لا يُحفظان (POST /licenses/{id}/download-url وحده يرد `url`)
  return Object.fromEntries(Object.entries(body).filter(([k]) => k !== 'token' && k !== 'url' && !k.endsWith('_token')));
}
