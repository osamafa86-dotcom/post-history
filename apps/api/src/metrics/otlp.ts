/**
 * حمولة مقاييس الخادم وإرسالها بـ OTLP/HTTP (JSON) إلى المجمّع المستضاف ذاتيًا (ADR 0027، تعديل 2026-11-11).
 * بلا أي استيراد: يشغّله دخان المراقبة كما هو (`infra/observability/smoke-monitoring.sh`) ليثبت أن المجمّع يقبل ما يرسله الخادم.
 * التسميات قائمة مغلقة: الطريقة، وقالب المسار كما سُجّل (`/v1/materials/:id`)، ورمز الحالة، وحالة الاتصال. لا مسار خام ولا معرّف ولا نص خطأ.
 */
const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
const DURATION_BOUNDS_S = [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5];
const SCOPE = 'api';

export interface RequestSeries {
  method: string;
  route: string;
  status: number;
  count: number;
  sum: number;
  buckets: number[];
}

export interface MetricsSnapshot {
  /** بداية العدّ التراكمي ووقت القراءة، بالنانوثانية منذ epoch. */
  started: string;
  at: string;
  requests: RequestSeries[];
  pool: { idle: number; used: number; max: number; pending: number };
  /** غائب حين تتعذّر قراءة القاعدة: تُرسل بقية المقاييس. */
  outbox?: { pending: number; dead: number; oldest: number };
}

export const unixNano = (): string => `${Date.now()}000000`;

/** مدة الطلبات بالطريقة وقالب المسار ورمز الحالة. ما لم يطابق مسارًا يُعدّ `unmatched`، فلا يدخل مسار خام تسميةً. */
export class RequestDurations {
  private readonly byKey = new Map<string, RequestSeries>();

  record(method: string, route: string | undefined, status: number, seconds: number): void {
    const m = METHODS.has(method) ? method : '_OTHER';
    const r = route ?? 'unmatched';
    const key = `${m} ${r} ${status}`;
    let series = this.byKey.get(key);
    if (!series) {
      series = { method: m, route: r, status, count: 0, sum: 0, buckets: new Array<number>(DURATION_BOUNDS_S.length + 1).fill(0) };
      this.byKey.set(key, series);
    }
    series.count += 1;
    series.sum += seconds;
    const bucket = DURATION_BOUNDS_S.findIndex((bound) => seconds <= bound);
    series.buckets[bucket === -1 ? DURATION_BOUNDS_S.length : bucket]! += 1;
  }

  series(): RequestSeries[] {
    return [...this.byKey.values()];
  }
}

type Attribute = { key: string; value: { stringValue: string } | { intValue: string } };
const attribute = (key: string, value: string | number): Attribute => ({
  key,
  value: typeof value === 'number' ? { intValue: String(value) } : { stringValue: value },
});

export function metricsPayload(s: MetricsSnapshot): unknown {
  const gauge = (name: string, points: Array<{ value: number; attributes?: Attribute[] }>, unit?: string) => ({
    name,
    ...(unit ? { unit } : {}),
    gauge: {
      dataPoints: points.map((p) => ({
        attributes: p.attributes ?? [],
        timeUnixNano: s.at,
        ...(Number.isInteger(p.value) ? { asInt: String(p.value) } : { asDouble: p.value }),
      })),
    },
  });
  const metrics: unknown[] = [
    {
      name: 'http.server.request.duration',
      unit: 's',
      histogram: {
        aggregationTemporality: 2,
        dataPoints: s.requests.map((r) => ({
          attributes: [attribute('http.request.method', r.method), attribute('http.route', r.route), attribute('http.response.status_code', r.status)],
          startTimeUnixNano: s.started,
          timeUnixNano: s.at,
          count: String(r.count),
          sum: r.sum,
          bucketCounts: r.buckets.map(String),
          explicitBounds: DURATION_BOUNDS_S,
        })),
      },
    },
    gauge('db.client.connection.count', [
      { value: s.pool.idle, attributes: [attribute('db.client.connection.state', 'idle')] },
      { value: s.pool.used, attributes: [attribute('db.client.connection.state', 'used')] },
    ]),
    gauge('db.client.connection.max', [{ value: s.pool.max }]),
    gauge('db.client.connection.pending_requests', [{ value: s.pool.pending }]),
  ];
  if (s.outbox) {
    metrics.push(
      gauge('outbox.events.pending', [{ value: s.outbox.pending }]),
      gauge('outbox.events.oldest_pending_age', [{ value: s.outbox.oldest }], 's'),
      gauge('outbox.events.dead', [{ value: s.outbox.dead }]),
    );
  }
  // اسم الخدمة في اسم النطاق (scope)، فيصل Prometheus تسميةً مع كل مقياس؛ لا خصائص مورد
  return { resourceMetrics: [{ resource: { attributes: [] }, scopeMetrics: [{ scope: { name: SCOPE }, metrics }] }] };
}

/** يرسل الحمولة إلى `<endpoint>/v1/metrics` ويعيد رمز حالة الرد. يرمي عند تعذّر الاتصال أو انقضاء المهلة. */
export async function pushMetrics(endpoint: string, payload: unknown, timeoutMs: number): Promise<number> {
  const res = await fetch(`${endpoint}/v1/metrics`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs),
  });
  await res.arrayBuffer();
  return res.status;
}
