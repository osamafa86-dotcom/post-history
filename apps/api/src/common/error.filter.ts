import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, Inject } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { Logger } from 'pino';
import { ApiError, type ErrorBody, type ErrorCode, StoredResponse } from './errors';
import { LOGGER, redactPath } from './logger';

const CODE_BY_STATUS: Record<number, ErrorCode> = {
  400: 'bad_request',
  401: 'unauthorized',
  403: 'forbidden_scope',
  404: 'not_found',
  409: 'upload_state_conflict',
  413: 'bad_request',
  415: 'bad_request',
  422: 'validation_failed',
  429: 'rate_limited',
};

export function toErrorResponse(exception: unknown, requestId: string): { status: number; body: ErrorBody } {
  if (exception instanceof ApiError) {
    const body: ErrorBody = { code: exception.code, message: exception.message, request_id: requestId };
    if (exception.details) body.details = exception.details;
    return { status: exception.status, body };
  }
  if (exception instanceof HttpException) {
    const status = exception.getStatus();
    const code = CODE_BY_STATUS[status] ?? (status >= 500 ? 'internal_error' : 'bad_request');
    const message = status === 404 ? 'Not found.' : status >= 500 ? 'Internal error.' : 'Bad request.';
    return { status, body: { code, message, request_id: requestId } };
  }
  return { status: 500, body: { code: 'internal_error', message: 'Internal error.', request_id: requestId } };
}

@Catch()
export class ErrorFilter implements ExceptionFilter {
  constructor(@Inject(LOGGER) private readonly logger: Logger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const req = host.switchToHttp().getRequest<Request>();
    const res = host.switchToHttp().getResponse<Response>();

    if (exception instanceof StoredResponse) {
      res.setHeader('Idempotent-Replayed', 'true');
      if (exception.body === null || exception.body === undefined) res.status(exception.status).end();
      else res.status(exception.status).json(exception.body);
      return;
    }

    const { status, body } = toErrorResponse(exception, req.id ?? '');
    if (status >= 500) {
      const err = exception instanceof Error ? exception : undefined;
      this.logger.error(
        { request_id: req.id, path: redactPath(req.originalUrl), err_name: err?.name, stack: err?.stack },
        'unhandled error',
      );
    }
    if (exception instanceof ApiError && exception.headers) {
      for (const [k, v] of Object.entries(exception.headers)) res.setHeader(k, v);
    }
    res.status(status).json(body);
  }
}
