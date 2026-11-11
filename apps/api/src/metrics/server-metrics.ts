import { Inject, Injectable, Module, type OnModuleDestroy } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import type { Pool } from 'pg';
import type { Logger } from 'pino';
import { LOGGER } from '../common/logger';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { PG_POOL } from '../database/database.module';
import { metricsPayload, type MetricsSnapshot, pushMetrics, RequestDurations, unixNano } from './otlp';

/**
 * مقاييس الخادم إلى المجمّع المستضاف ذاتيًا (ADR 0027، تعديل 2026-11-11): مدة الطلبات، واتصالات مجمّع القاعدة، وحال Outbox.
 * بلا `OTEL_EXPORTER_OTLP_ENDPOINT` لا يخرج شيء. الحمولة وتسمياتها المغلقة في `otlp.ts`.
 */
const PUSH_INTERVAL_MS = 30_000;
const PUSH_TIMEOUT_MS = 2_000;

@Injectable()
export class ServerMetrics implements OnModuleDestroy {
  private readonly started = unixNano();
  private readonly durations = new RequestDurations();
  private timer?: NodeJS.Timeout;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  /** يبدأ الإرسال الدوري في عملية خادم HTTP وحدها (من `configureApp`)، وحين يُضبط العنوان. */
  start(): void {
    if (!this.config.OTEL_EXPORTER_OTLP_ENDPOINT || this.timer) return;
    this.timer = setInterval(() => void this.push(), PUSH_INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** طلب انتهى. `route` قالب المسار المسجَّل، أو غائب لما لم يطابق مسارًا. */
  request(method: string, route: string | undefined, status: number, seconds: number): void {
    this.durations.record(method, route, status, seconds);
  }

  /** عدد المعلّق في Outbox، وعمر أقدم معلّق بالثواني، وعدد الأحداث الميتة. جملة واحدة على الفهرس الجزئي لغير المنشور. */
  private async outbox(): Promise<MetricsSnapshot['outbox']> {
    try {
      const { rows } = await this.pool.query<{ pending: number; dead: number; oldest: number }>(
        `SELECT count(*) FILTER (WHERE dead_at IS NULL)::int AS pending,
                count(*) FILTER (WHERE dead_at IS NOT NULL)::int AS dead,
                coalesce(extract(epoch FROM now() - min(occurred_at) FILTER (WHERE dead_at IS NULL)), 0)::float8 AS oldest
           FROM outbox_events WHERE published_at IS NULL`,
      );
      return rows[0];
    } catch (err) {
      this.logger.warn({ err_name: (err as Error).name, pg_code: (err as { code?: string }).code }, 'outbox metrics unavailable');
      return undefined;
    }
  }

  async payload(): Promise<unknown> {
    const idle = this.pool.idleCount;
    return metricsPayload({
      started: this.started,
      at: unixNano(),
      requests: this.durations.series(),
      pool: { idle, used: this.pool.totalCount - idle, max: this.config.DATABASE_POOL_MAX, pending: this.pool.waitingCount },
      outbox: await this.outbox(),
    });
  }

  /** يرسل المقاييس الآن. عطل المجمّع لا يُسقط الخادم ولا يُعاد: الدفعة التالية تحمل القيم التراكمية نفسها. */
  async push(): Promise<boolean> {
    const endpoint = this.config.OTEL_EXPORTER_OTLP_ENDPOINT;
    if (!endpoint) return false;
    try {
      const status = await pushMetrics(endpoint, await this.payload(), PUSH_TIMEOUT_MS);
      if (status >= 200 && status < 300) return true;
      this.logger.warn({ status }, 'metrics push refused');
    } catch (err) {
      this.logger.warn({ err_name: (err as Error).name }, 'metrics push failed');
    }
    return false;
  }
}

/** مدة كل طلب بقالب مساره ورمز حالته. يُسجَّل قبل أي وسيط آخر فيشمل ما يُرفض قبل الوصول إلى معالج. */
export function requestMetrics(metrics: ServerMetrics) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const started = process.hrtime.bigint();
    res.on('finish', () => {
      const route = (req.route as { path?: unknown } | undefined)?.path;
      metrics.request(req.method, typeof route === 'string' ? `${req.baseUrl}${route}` : undefined, res.statusCode, Number(process.hrtime.bigint() - started) / 1e9);
    });
    next();
  };
}

@Module({ providers: [ServerMetrics], exports: [ServerMetrics] })
export class MetricsModule {}
