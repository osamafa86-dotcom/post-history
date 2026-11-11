import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { loadConfig } from '../../src/config/config';
import { ServerMetrics } from '../../src/metrics/server-metrics';
import { createHarness, type Harness } from './harness';

// مقاييس الخادم (ADR 0027، تعديل 2026-11-11): تُرسل إلى المجمّع المستضاف ذاتيًا وحده، وتسمياتها قائمة مغلقة بلا بيان كاشف.
interface Call {
  method: string;
  url: string;
  contentType: string;
  body: string;
}

async function collector(): Promise<{ url: string; calls: Call[]; close(): Promise<void> }> {
  const calls: Call[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      calls.push({ method: req.method ?? '', url: req.url ?? '', contentType: String(req.headers['content-type']), body: Buffer.concat(chunks).toString() });
      res.setHeader('Content-Type', 'application/json');
      res.end('{}');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    calls,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

type Attribute = { key: string; value: { stringValue?: string; intValue?: string } };
type Point = { attributes: Attribute[]; asInt?: string; asDouble?: number; count?: string; sum?: number; bucketCounts?: string[]; explicitBounds?: number[] };
type Metric = { name: string; unit?: string; gauge?: { dataPoints: Point[] }; histogram?: { dataPoints: Point[] } };

function metricsOf(payload: unknown): Map<string, Metric> {
  const scope = (payload as { resourceMetrics: Array<{ scopeMetrics: Array<{ scope: { name: string }; metrics: Metric[] }> }> }).resourceMetrics[0]!.scopeMetrics[0]!;
  expect(scope.scope).toEqual({ name: 'api' });
  return new Map(scope.metrics.map((m) => [m.name, m]));
}

const labels = (p: Point): Record<string, string | number> =>
  Object.fromEntries(p.attributes.map((a) => [a.key, a.value.intValue !== undefined ? Number(a.value.intValue) : a.value.stringValue!]));

const gauge = (metrics: Map<string, Metric>, name: string): number => {
  const [point] = metrics.get(name)!.gauge!.dataPoints;
  return point!.asInt !== undefined ? Number(point!.asInt) : point!.asDouble!;
};

describe('server metrics', () => {
  let h: Harness;
  let sink: Awaited<ReturnType<typeof collector>>;
  let metrics: ServerMetrics;
  const http = () => request(h.app.getHttpServer());

  beforeAll(async () => {
    sink = await collector();
    h = await createHarness({ env: { OTEL_EXPORTER_OTLP_ENDPOINT: sink.url } });
    metrics = h.app.get(ServerMetrics);
  });
  afterAll(async () => {
    await h.close();
    await sink.close();
  });

  it('records request duration by method, route template and status, never the raw path', async () => {
    const id = randomUUID();
    const token = 'not-the-hook-token-value';
    await http().get('/health').expect(200);
    await http().get(`/v1/materials/${id}/renders`).expect(401);
    await http().get(`/v1/no-such-thing/${id}`).expect(404);
    const hook = await http().post(`/internal/tusd-hooks/${token}`).send({});
    expect(hook.status).toBeGreaterThanOrEqual(400);

    const payload = await metrics.payload();
    const text = JSON.stringify(payload);
    expect(text).not.toContain(id);
    expect(text).not.toContain(token);

    const duration = metricsOf(payload).get('http.server.request.duration')!;
    expect(duration.unit).toBe('s');
    const points = duration.histogram!.dataPoints;
    expect(points.map(labels)).toEqual(
      expect.arrayContaining([
        { 'http.request.method': 'GET', 'http.route': '/health', 'http.response.status_code': 200 },
        { 'http.request.method': 'GET', 'http.route': '/v1/materials/:id/renders', 'http.response.status_code': 401 },
        { 'http.request.method': 'GET', 'http.route': 'unmatched', 'http.response.status_code': 404 },
        { 'http.request.method': 'POST', 'http.route': '/internal/tusd-hooks/:hook_token', 'http.response.status_code': hook.status },
      ]),
    );
    for (const p of points) {
      expect(p.bucketCounts).toHaveLength(p.explicitBounds!.length + 1);
      expect(p.bucketCounts!.reduce((n, c) => n + Number(c), 0)).toBe(Number(p.count));
      expect(p.sum).toBeGreaterThan(0);
    }
  });

  it('reports the database pool, the outbox backlog, its oldest pending event and its dead events', async () => {
    const run = randomUUID();
    const before = metricsOf(await metrics.payload());
    await h.pool.query(
      `INSERT INTO outbox_events (type, aggregate_type, aggregate_id, idempotency_key, occurred_at, next_attempt_at, dead_at) VALUES
         ('form.published', 'form', gen_random_uuid(), $1, now() - interval '1 day', now() + interval '1 day', NULL),
         ('form.published', 'form', gen_random_uuid(), $2, now() - interval '2 days', now() + interval '1 day', now())`,
      [`metrics:pending:${run}`, `metrics:dead:${run}`],
    );
    try {
      const after = metricsOf(await metrics.payload());
      expect(gauge(after, 'outbox.events.pending')).toBe(gauge(before, 'outbox.events.pending') + 1);
      expect(gauge(after, 'outbox.events.dead')).toBe(gauge(before, 'outbox.events.dead') + 1);
      // الأقدم بين المعلّق وحده: الحدث الميت أقدم منه ولا يُحسب
      const oldest = gauge(after, 'outbox.events.oldest_pending_age');
      expect(oldest).toBeGreaterThanOrEqual(86_400);
      expect(oldest).toBeLessThan(86_400 + 3_600);
      expect(after.get('outbox.events.oldest_pending_age')!.unit).toBe('s');

      const states = Object.fromEntries(after.get('db.client.connection.count')!.gauge!.dataPoints.map((p) => [labels(p)['db.client.connection.state'], Number(p.asInt)]));
      expect(Object.keys(states).sort()).toEqual(['idle', 'used']);
      expect(states.idle! + states.used!).toBeGreaterThanOrEqual(1);
      expect(gauge(after, 'db.client.connection.max')).toBe(h.config.DATABASE_POOL_MAX);
      expect(gauge(after, 'db.client.connection.pending_requests')).toBe(0);
    } finally {
      await h.pool.query(`UPDATE outbox_events SET published_at = now() WHERE idempotency_key = ANY($1)`, [[`metrics:pending:${run}`, `metrics:dead:${run}`]]);
    }
  });

  it('pushes to the collector on demand, and a collector that does not answer never throws', async () => {
    await http().get('/health').expect(200);
    const sent = sink.calls.length;
    await expect(metrics.push()).resolves.toBe(true);
    const call = sink.calls[sent]!;
    expect([call.method, call.url, call.contentType]).toEqual(['POST', '/v1/metrics', 'application/json']);
    expect(metricsOf(JSON.parse(call.body)).has('http.server.request.duration')).toBe(true);

    const dark = await createHarness({ env: { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:1' } });
    try {
      await expect(dark.app.get(ServerMetrics).push()).resolves.toBe(false);
    } finally {
      await dark.close();
    }
  });

  it('sends nothing without an endpoint, and refuses an endpoint outside the private network', async () => {
    const off = await createHarness();
    try {
      await expect(off.app.get(ServerMetrics).push()).resolves.toBe(false);
    } finally {
      await off.close();
    }
    const env = (value: string) => ({ ...process.env, OTEL_EXPORTER_OTLP_ENDPOINT: value });
    expect(loadConfig(env('http://127.0.0.1:4318')).OTEL_EXPORTER_OTLP_ENDPOINT).toBe('http://127.0.0.1:4318');
    expect(loadConfig(env('http://collector:4318')).OTEL_EXPORTER_OTLP_ENDPOINT).toBe('http://collector:4318');
    // عنوان عام، أو اسم بنقطة، أو مسار أو بيانات دخول في العنوان: مرفوض، والخطأ يسمّي المتغير وحده
    for (const value of ['http://192.0.2.1:4318', 'http://collector.invalid:4318', 'http://user:pass@collector:4318', 'ftp://collector:4318', 'not a url']) {
      expect(() => loadConfig(env(value))).toThrow('Invalid environment configuration: OTEL_EXPORTER_OTLP_ENDPOINT');
    }
  });
});
