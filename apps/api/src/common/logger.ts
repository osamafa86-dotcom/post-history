import type { LoggerService } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import pino, { type Logger } from 'pino';

// سجلات بنيوية بلا بيانات كاشفة: لا ترويسات ولا أجسام ولا سلاسل استعلام، ورمز الخطّاف محجوب من المسار.
export function createLogger(level: string): Logger {
  return pino({ level, base: undefined, timestamp: pino.stdTimeFunctions.isoTime });
}

const HOOK_PATH = /^(\/internal\/tusd-hooks\/)[^/?#]*/;

export function redactPath(url: string): string {
  const path = url.split('?')[0] ?? '';
  return path.replace(HOOK_PATH, '$1:hook_token');
}

declare module 'express' {
  interface Request {
    id?: string;
  }
}

export function requestLogging(logger: Logger) {
  return (req: Request, res: Response, next: NextFunction): void => {
    req.id = randomUUID();
    res.setHeader('X-Request-Id', req.id);
    const started = process.hrtime.bigint();
    res.on('finish', () => {
      logger.info(
        {
          request_id: req.id,
          method: req.method,
          path: redactPath(req.originalUrl),
          status: res.statusCode,
          duration_ms: Number(process.hrtime.bigint() - started) / 1e6,
        },
        'request',
      );
    });
    next();
  };
}

export class PinoNestLogger implements LoggerService {
  constructor(private readonly logger: Logger) {}
  log(message: unknown, context?: string): void {
    this.logger.info({ context }, String(message));
  }
  error(message: unknown, trace?: string, context?: string): void {
    this.logger.error({ context, trace }, String(message));
  }
  warn(message: unknown, context?: string): void {
    this.logger.warn({ context }, String(message));
  }
  debug(message: unknown, context?: string): void {
    this.logger.debug({ context }, String(message));
  }
  verbose(message: unknown, context?: string): void {
    this.logger.trace({ context }, String(message));
  }
}

export const LOGGER = Symbol('LOGGER');
