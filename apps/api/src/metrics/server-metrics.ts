import { Inject, Injectable, Module, type OnModuleDestroy } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import type { Pool } from 'pg';
import type { Logger } from 'pino';
import { LOGGER } from '../common/logger';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { PG_POOL } from '../database/database.module';

/**
 * مقاييس الخادم إلى المجمّع المستضاف ذاتيًا (ADR 0027، تعديل 2026-11-11): OTLP/HTTP بصيغة JSON إلى `<endpoint>/v1/metrics`، بلا مكتبة.
 * بلا `OTEL_EXPORTER_OTLP_ENDPOINT` لا يخرج شيء. التسميات قائمة مغلقة: الطريقة، وقالب المسار كما سُجّل (`/v1/materials/:id`)، ورمز الحالة،
 * وحالة الاتصال. لا مسار خام ولا معرّف ولا نص خطأ في تسمية أو قيمة.
 */
const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
const DURATION_BOUNDS_S = [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5];
const PUSH_INTERVAL_MS = 30_000;
const PUSH_TIMEOUT_MS = 2_000;
const SCOPE = 'api';

interface Series {
  method: string;
  route: string;
  status: number;
  count: number;
  sum: number;
  buckets: number[];
}

type AttributeValue = { stringValue: string } | { intValue: string };
const attribute = (key: string, value: string | number): { key: string; value: AttributeValue } => ({
  key,
  value: typeof value === 'number' ? { intValue: String(value) } : { stringValue: value },
});
const unixNano = (): string => `${Date.now()}000000`;

@Injectable()
export class ServerMetrics implements OnModuleDestroy {
  private readonly started = unixNano();
  private readonly requests = new Map<string, Series>();
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

  /** طلب انتهى. `route` قالب المسار المسجَّل؛ ما لم يطابق مسارًا يُعدّ `unmatched` فلا يدخل مسار خام تسميةً. */
  request(method: string, route: string | undefined, status: number, seconds: number): void {
    const m = METHODS.has(method) ? method : '_OTHER';
    const r = route ?? 'unmatched';
    const key = `${m} ${r} ${status}`;
    let series = this.requests.get(key);
    if (!series) {
      series = { method: m, route: r, status, count: 0, sum: 0, buckets: new Array<number>(DURATION_BOUNDS_S.length + 1).fill(0) };
      this.requests.set(key, series);
    }
    series.count += 1;
    series.sum += seconds;
    const bucket = DURATION_BOUNDS_S.findIndex((bound) => seconds <= bound);
    series.buckets[bucket === -1 ? DURATION_BOUNDS_S.length : bucket]! += 1;
  }

  /** عدد المعلّق في Outbox، وعمر أقدم معلّق بالثواني، وعدد الأحداث الميتة. جملة واحدة على الفهرس الجزئي لغير المنشور. */
  private async outbox(): Promise<{ pending: number; dead: number; oldest: number } | undefined> {
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
    const at = unixNano();
    const gauge = (name: string, points: Array<{ value: number; attributes?: ReturnType<typeof attribute>[] }>, unit?: string) => ({
      name,
      ...(unit ? { unit } : {}),
      gauge: {
        dataPoints: points.map((p) => ({
          attributes: p.attributes ?? [],
          timeUnixNano: at,
          ...(Number.isInteger(p.value) ? { asInt: String(p.value) } : { asDouble: p.value }),
        })),
      },
    });
    const idle = this.pool.idleCount;
    const metrics: unknown[] = [
      {
        name: 'http.server.request.duration',
        unit: 's',
        histogram: {
          aggregationTemporality: 2,
          dataPoints: [...this.requests.values()].map((s) => ({
            attributes: [attribute('http.request.method', s.method), attribute('http.route', s.route), attribute('http.response.status_code', s.status)],
            startTimeUnixNano: this.started,
            timeUnixNano: at,
            count: String(s.count),
            sum: s.sum,
            bucketCounts: s.buckets.map(String),
            explicitBounds: DURATION_BOUNDS_S,
          })),
        },
      },
      gauge('db.client.connection.count', [
        { value: idle, attributes: [attribute('db.client.connection.state', 'idle')] },
        { value: this.pool.totalCount - idle, attributes: [attribute('db.client.connection.state', 'used')] },
      ]),
      gauge('db.client.connection.max', [{ value: this.config.DATABASE_POOL_MAX }]),
      gauge('db.client.connection.pending_requests', [{ value: this.pool.waitingCount }]),
    ];
    const outbox = await this.outbox();
    if (outbox) {
      metrics.push(
        gauge('outbox.events.pending', [{ value: outbox.pending }]),
        gauge('outbox.events.oldest_pending_age', [{ value: outbox.oldest }], 's'),
        gauge('outbox.events.dead', [{ value: outbox.dead }]),
      );
    }
    return { resourceMetrics: [{ resource: { attributes: [] }, scopeMetrics: [{ scope: { name: SCOPE }, metrics }] }] };
  }

  /** يرسل المقاييس الآن. عطل المجمّع لا يُسقط الخادم ولا يُعاد: الدفعة التالية تحمل القيم التراكمية نفسها. */
  async push(): Promise<boolean> {
    const endpoint = this.config.OTEL_EXPORTER_OTLP_ENDPOINT;
    if (!endpoint) return false;
    try {
      const res = await fetch(`${endpoint}/v1/metrics`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(await this.payload()),
        signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
      });
      await res.arrayBuffer();
      if (res.ok) return true;
      this.logger.warn({ status: res.status }, 'metrics push refused');
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
