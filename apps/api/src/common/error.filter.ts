import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, Inject } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { Logger } from 'pino';
import { databaseUnavailable, pgError } from './db-errors';
import { ApiError, type ErrorBody, type ErrorCode, StoredResponse } from './errors';
import { LOGGER, redactPath } from './logger';

const CODE_BY_STATUS: Record<number, ErrorCode> = {
  400: 'bad_request',
  401: 'unauthorized',
  403: 'forbidden_scope',
  404: 'not_found',
  409: 'upload_state_conflict',
  412: 'precondition_failed',
  413: 'bad_request',
  415: 'bad_request',
  422: 'validation_failed',
  429: 'rate_limited',
};

/**
 * رموز Postgres لقيمة مدخلة لا تصلح (ADR 0115): محرف لا يمثَّل في الترميز (NUL و22P05)، ونص أو رقم أو تاريخ لا يُفسَّر أو يتجاوز
 * عموده. هي خطأ في الطلب لا في الخادم: 422 بلا تفاصيل، لا 500.
 */
const INVALID_INPUT_CODES = new Set(['22001', '22003', '22007', '22008', '22019', '22021', '22025', '2201B', '22P02', '22P05']);

/** ثوانٍ يُنصح العميل بانتظارها حين لا تُبلَغ القاعدة أو يتجاوز الطلب مهلتها (ADR 0028). */
const UNAVAILABLE_RETRY_AFTER_SECONDS = 5;

export function toErrorResponse(exception: unknown, requestId: string): { status: number; body: ErrorBody; headers?: Record<string, string> } {
  if (exception instanceof ApiError) {
    const body: ErrorBody = { code: exception.code, message: exception.message, request_id: requestId };
    if (exception.details) body.details = exception.details;
    return { status: exception.status, body, ...(exception.headers ? { headers: exception.headers } : {}) };
  }
  if (exception instanceof HttpException) {
    const status = exception.getStatus();
    const code = CODE_BY_STATUS[status] ?? (status >= 500 ? 'internal_error' : 'bad_request');
    const message = status === 404 ? 'Not found.' : status >= 500 ? 'Internal error.' : 'Bad request.';
    return { status, body: { code, message, request_id: requestId } };
  }
  const { code } = pgError(exception);
  if (code && INVALID_INPUT_CODES.has(code)) {
    return { status: 422, body: { code: 'validation_failed', message: 'Request validation failed.', request_id: requestId } };
  }
  // القاعدة لا تُبلَغ أو تجاوز الطلب مهلتها: عطل مؤقت جوابه «أعد بعد قليل» لا 500 (ADR 0028). الرمز يبقى internal_error
  if (databaseUnavailable(exception)) {
    return {
      status: 503,
      body: { code: 'internal_error', message: 'Service temporarily unavailable.', request_id: requestId },
      headers: { 'Retry-After': String(UNAVAILABLE_RETRY_AFTER_SECONDS) },
    };
  }
  return { status: 500, body: { code: 'internal_error', message: 'Internal error.', request_id: requestId } };
}

/**
 * ما يُسجَّل عن خطأ 5xx (ADR 0115، CLAUDE.md §5): اسم الخطأ ورمز Postgres واسم القيد وحدها. لا رسالة ولا مكدّس: خطأ استعلام Drizzle
 * يحمل في رسالته (والمكدّس يبدأ بها) «params: …» بكل القيم المربوطة، ومنها العناوين والأسماء المستعارة والبصمات والبريد.
 */
export function errorLogFields(exception: unknown): { err_name?: string; pg_code?: string; constraint?: string } {
  const err = exception instanceof Error ? exception : undefined;
  // DrizzleQueryError لا يضبط name، فاسم الصنف أنفع من «Error»
  const name = err ? (err.name !== 'Error' ? err.name : (err.constructor?.name ?? err.name)) : undefined;
  const { code, constraint } = pgError(exception);
  return { err_name: name, ...(code ? { pg_code: code } : {}), ...(constraint ? { constraint } : {}) };
}

@Catch()
export class ErrorFilter implements ExceptionFilter {
  constructor(@Inject(LOGGER) private readonly logger: Logger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const req = host.switchToHttp().getRequest<Request>();
    const res = host.switchToHttp().getResponse<Response>();

    if (exception instanceof StoredResponse) {
      res.setHeader('Idempotent-Replayed', 'true');
      // الاستجابة المعادة تُخزَّن بلا ترويسات: ETag المادة من row_version في الجسم كما في EtagInterceptor
      const version = (exception.body as { row_version?: unknown } | null)?.row_version;
      if (typeof version === 'number') res.setHeader('ETag', `"${version}"`);
      if (exception.body === null || exception.body === undefined) res.status(exception.status).end();
      else res.status(exception.status).json(exception.body);
      return;
    }

    const { status, body, headers } = toErrorResponse(exception, req.id ?? '');
    if (status >= 500) {
      this.logger.error({ request_id: req.id, path: redactPath(req.originalUrl), ...errorLogFields(exception) }, 'unhandled error');
    }
    for (const [k, v] of Object.entries(headers ?? {})) res.setHeader(k, v);
    res.status(status).json(body);
  }
}
