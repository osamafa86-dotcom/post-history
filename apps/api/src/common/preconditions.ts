import { type CallHandler, type ExecutionContext, Injectable, type NestInterceptor } from '@nestjs/common';
import type { Response } from 'express';
import { map, type Observable } from 'rxjs';
import { ApiError } from './errors';

/**
 * التزامن المتفائل (عقد v0.1، ADR 0012): `If-Match: "<n>"` اختياري؛ إن وُجد ولم يطابق القيمة الراهنة (row_version
 * للمادة، الإصدار الحالي للنموذج) يُرفض بـ 412 قبل أي كتابة. القيمة المشوّهة لا تطابق شيئًا فتُرفض كذلك.
 */
export function assertIfMatch(header: string | undefined, current: number): void {
  if (header === undefined) return;
  const match = /^"([0-9]{1,19})"$/.exec(header.trim());
  if (!match || match[1] !== String(current)) {
    throw new ApiError(412, 'precondition_failed', 'The resource has changed; read it again and retry.');
  }
}

/**
 * `ETag: "<row_version>"` على كل استجابة مادة. الاستجابة المعادة من منع التكرار لا تمر من هنا (تُكتب في
 * ErrorFilter) فتُضاف لها هناك من الجسم نفسه.
 */
@Injectable()
export class EtagInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const res = context.switchToHttp().getResponse<Response>();
    return next.handle().pipe(
      map((body) => {
        const version = (body as { row_version?: unknown } | null)?.row_version;
        if (typeof version === 'number' && !res.headersSent) res.setHeader('ETag', `"${version}"`);
        return body;
      }),
    );
  }
}
