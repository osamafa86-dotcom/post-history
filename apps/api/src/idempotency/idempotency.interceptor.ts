import { type CallHandler, type ExecutionContext, HttpException, Inject, Injectable, type NestInterceptor } from '@nestjs/common';
import { HTTP_CODE_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { and, eq, sql } from 'drizzle-orm';
import type { Request } from 'express';
import { catchError, from, mergeMap, type Observable, throwError } from 'rxjs';
import { canonicalJson } from '../common/canonical-json';
import { sha256 } from '../common/crypto';
import { ApiError, StoredResponse } from '../common/errors';
import { toErrorResponse } from '../common/error.filter';
import { DB, type Database } from '../database/database.module';
import { idempotencyKeys } from '../database/schema/schema';

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
 * الاستجابات 4xx تُحفظ كما هي؛ 5xx تحرر المفتاح ليعيد العميل المحاولة.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly reflector: Reflector,
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
    return from(this.claim(userId, key, fingerprint)).pipe(
      mergeMap(() =>
        next.handle().pipe(
          mergeMap(async (body) => {
            await this.complete(userId, key, successStatus, body ?? null);
            return body;
          }),
          catchError((err: unknown) => {
            const { status, body } = toErrorResponse(err, req.id ?? '');
            const settle =
              status < 500 && (err instanceof ApiError || err instanceof HttpException)
                ? this.complete(userId, key, status, body)
                : this.release(userId, key);
            return from(settle.catch(() => undefined)).pipe(mergeMap(() => throwError(() => err)));
          }),
        ),
      ),
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
      .set({ state: 'completed', responseStatus: status, responseBody: body as never })
      .where(and(eq(idempotencyKeys.userId, userId), eq(idempotencyKeys.key, key)));
  }

  private async release(userId: string, key: string): Promise<void> {
    await this.db
      .delete(idempotencyKeys)
      .where(and(eq(idempotencyKeys.userId, userId), eq(idempotencyKeys.key, key), eq(idempotencyKeys.state, 'in_progress')));
  }
}
