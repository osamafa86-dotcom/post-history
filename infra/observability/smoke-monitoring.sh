#!/usr/bin/env bash
# دخان المراقبة ذاتية الاستضافة (ADR 0027)، في CI وعلى أي مضيف فيه Docker:
#   infra/observability/smoke-monitoring.sh [--json FILE]
# يثبت:
#   - سجل حاوية يصل إلى Loki باسمها (الوسم tag)، وما فيه من عنوان ورمز ومعرّف رفع وإحداثيات وجهاز منقّى قبل التخزين؛
#   - تتبّع OTLP يصير مقياس طلبات في Prometheus، ومقياس OTLP يصل كما هو؛
#   - مُصدِّر الخادم ومُصدِّر عامل الوسائط كما هما في المستودع يبلغان المجمّع على شبكتَي المقاييس، ومقاييسهما تُقرأ من Prometheus
#     بالأسماء التي تستعملها قواعد التنبيه، والقواعد محمّلة وتنطلق على قيمها؛
#   - مقاييس المضيف والفحوص الصحية (healthcheck.sh --prom) في Prometheus؛
#   - Grafana بمصدريه ولوحته، وعلى 127.0.0.1 وحده، ولا منفذ آخر منشور؛
#   - كل خدمة محدودة الذاكرة بلا swap، والاستهلاك الفعلي تحت الحدود.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
JSON=""
[ "${1:-}" = --json ] && JSON="$2"
WORK="$(mktemp -d)"
export HEALTH_TEXTFILE_DIR="$WORK/textfile" GRAFANA_PORT="${GRAFANA_PORT:-13300}"
C=(docker compose -f "$HERE/compose.monitoring.yml" --env-file "$WORK/monitoring.env")
cleanup() {
  [ "${KEEP:-0}" = 1 ] || "${C[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
  docker rm -f ph-monitoring-canary >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT
fail() { echo "!! $*" >&2; "${C[@]}" logs --tail 30 >&2 || true; exit 1; }
umask 077
printf 'GRAFANA_ADMIN_PASSWORD=%s\n' "$(openssl rand -hex 24)" > "$WORK/monitoring.env"
GPW="$(sed -n 's/^GRAFANA_ADMIN_PASSWORD=//p' "$WORK/monitoring.env")"
mkdir -p "$HEALTH_TEXTFILE_DIR" && chmod 0755 "$WORK" "$HEALTH_TEXTFILE_DIR"
umask 022
# The health check's exporter format, from the script itself: with no trial stack here every check fails, which is fine.
TRIAL_SH=true TRIAL_ENV_FILE=/dev/null HEALTH_STATE_DIR="$WORK/hs" ALERT_CONF=/dev/null \
  "$HERE/healthcheck.sh" --prom "$HEALTH_TEXTFILE_DIR/health.prom" >/dev/null 2>&1 || true
grep -q '^post_history_checks_failed ' "$HEALTH_TEXTFILE_DIR/health.prom" || fail "healthcheck.sh --prom wrote nothing"

cfg="$("${C[@]}" config --format json)"
read -r total nolimit swap <<<"$(python3 -c '
import json, sys
s = json.load(sys.stdin)["services"]
lim = {k: int(v.get("mem_limit") or 0) for k, v in s.items()}
print(sum(lim.values()) // 2**20, ",".join(k for k, v in lim.items() if not v) or "-",
      ",".join(k for k, v in s.items() if int(v.get("memswap_limit") or 0) != lim[k]) or "-")' <<<"$cfg")"
[ "$nolimit" = - ] && [ "$swap" = - ] || fail "services without a memory limit ($nolimit) or with swap ($swap)"
echo "memory limits: $total MB in all, no swap: ok"

"${C[@]}" up -d --wait >/dev/null 2>&1 || fail "monitoring stack did not come up"
for id in $("${C[@]}" ps -q); do
  b="$(docker inspect -f '{{json .HostConfig.PortBindings}}' "$id")"
  case "$(docker inspect -f '{{.Name}}' "$id")" in
    *grafana*) grep -q '"HostIp":"127.0.0.1"' <<<"$b" && ! grep -qE '"HostIp":"(0\.0\.0\.0|::|)"' <<<"$b" || fail "grafana published beyond 127.0.0.1: $b" ;;
    *) [ "$b" = "{}" ] || fail "$(docker inspect -f '{{.Name}}' "$id") publishes a port: $b" ;;
  esac
done
echo "only grafana published, on 127.0.0.1: ok"

# Queries run inside the stack (no other port is published): the Prometheus image's wget.
get() { "${C[@]}" exec -T prometheus wget -qO- "$1" 2>/dev/null; }
post() { "${C[@]}" exec -T prometheus wget -qO- --header 'Content-Type: application/json' --post-data "$2" "$1" >/dev/null 2>&1; }
until_ok() { local i; for i in $(seq 1 "$1"); do eval "$2" && return 0; sleep 3; done; return 1; }

# A container log line with values that must never be stored: the collector reads Docker's file, tags it with the name.
sleep 5   # the collector reads new lines only (start_at: end)
MARK="canary$(openssl rand -hex 6)"
docker run -d --name ph-monitoring-canary --log-opt tag=ph-canary --entrypoint sh \
  quay.io/prometheus/prometheus:v3.7.0@sha256:29c1e0b48ad816750245dea3d65ac3ce57dda30547e67b1e9a5176e2953cc4dc -c \
  "echo '$MARK plain'; echo '$MARK Authorization: Bearer abc.def.ghi from 10.20.30.40 PATCH /files/0f1e2d3c4b5a+mpu {\"lat\": 31.52, \"lng\": 34.47} device_id=DEV9988'; sleep 600" >/dev/null
q="$(python3 -c 'import sys, urllib.parse; print(urllib.parse.quote(sys.argv[1]))' '{service_name="ph-canary"}')"
loki() { get "http://loki:3100/loki/api/v1/query_range?query=$q&limit=50&since=10m"; }
until_ok 40 '[ "$(loki | grep -o "$MARK" | wc -l)" -ge 2 ]' || fail "the canary's log lines did not reach Loki under its container name"
stored="$(loki)"
for bad in abc.def.ghi 10.20.30.40 0f1e2d3c4b5a 31.52 34.47 DEV9988; do
  if grep -qF "$bad" <<<"$stored"; then fail "Loki stored a value that must be redacted: $bad"; fi
done
grep -q 'redacted' <<<"$stored" && grep -qF '/files/-' <<<"$stored" || fail "no redaction marker in the stored line (test has no teeth)"
echo "container logs reach Loki by name, redacted: ok"

# OTLP from an application: one span (to request metrics) and one gauge.
now="$(date +%s)000000000"
post http://otel-collector:4318/v1/traces "{\"resourceSpans\":[{\"resource\":{\"attributes\":[{\"key\":\"service.name\",\"value\":{\"stringValue\":\"ph-smoke\"}}]},\"scopeSpans\":[{\"spans\":[{\"traceId\":\"$(openssl rand -hex 16)\",\"spanId\":\"$(openssl rand -hex 8)\",\"name\":\"GET /v1/smoke\",\"kind\":2,\"startTimeUnixNano\":\"$now\",\"endTimeUnixNano\":\"$now\",\"attributes\":[{\"key\":\"http.request.method\",\"value\":{\"stringValue\":\"GET\"}},{\"key\":\"http.response.status_code\",\"value\":{\"intValue\":\"200\"}},{\"key\":\"http.route\",\"value\":{\"stringValue\":\"/v1/smoke\"}}]}]}]}]}" \
  || fail "the collector refused an OTLP span"
post http://otel-collector:4318/v1/metrics "{\"resourceMetrics\":[{\"resource\":{\"attributes\":[{\"key\":\"service.name\",\"value\":{\"stringValue\":\"ph-smoke\"}}]},\"scopeMetrics\":[{\"metrics\":[{\"name\":\"ph_smoke_gauge\",\"gauge\":{\"dataPoints\":[{\"asDouble\":42,\"timeUnixNano\":\"$now\"}]}}]}]}]}" \
  || fail "the collector refused an OTLP metric"
prom() { get "http://127.0.0.1:9090/api/v1/query?query=$(python3 -c 'import sys, urllib.parse; print(urllib.parse.quote(sys.argv[1]))' "$1")"; }
has() { prom "$1" | grep -q '"result":\[{'; }
until_ok 40 'has "traces_span_metrics_calls_total{service_name=\"ph-smoke\"}"' || fail "an OTLP span did not become a request metric in Prometheus"
until_ok 20 'has "ph_smoke_gauge{service_name=\"ph-smoke\"}"' || fail "an OTLP metric did not reach Prometheus"
echo "OTLP span to request metrics and OTLP metric in Prometheus: ok"
until_ok 20 'has node_memory_MemAvailable_bytes' || fail "no host metric in Prometheus"
until_ok 20 'has post_history_checks_failed' || fail "no health check metric in Prometheus (healthcheck.sh --prom)"
echo "host metrics and health checks in Prometheus: ok"

# ---- Application metrics (ADR 0027, amendment 2026-11-11) ----
# The collector is alone on the two telemetry networks, both internal: applications reach it and nothing else of this stack.
collector="$(docker inspect -f '{{.Name}}' "$("${C[@]}" ps -q otel-collector)")"
for net in post-history-telemetry-api post-history-telemetry-workers; do
  on="$(docker network inspect "$net" -f '{{.Internal}}{{range .Containers}} /{{.Name}}{{end}}')" || fail "no network $net"
  [ "$on" = "true $collector" ] || fail "$net is not an internal network with the collector alone on it: $on"
done
# The address the trial's override gives the server and the workers, read from the override itself with its default host.
ENDPOINT="$(sed -n 's/^ *OTEL_EXPORTER_OTLP_ENDPOINT: *//p' "$HERE/compose.telemetry.yml" | sort -u)"
ENDPOINT="${ENDPOINT/\$\{TELEMETRY_COLLECTOR_HOST:-otel-collector\}/otel-collector}"
[ "$ENDPOINT" = http://otel-collector:4318 ] || fail "compose.telemetry.yml does not point at the collector's OTLP port: $ENDPOINT"
NODE_IMAGE="$(sed -n 's/^ *image: \(node:[^ ]*\)$/\1/p' "$ROOT/infra/compose/docker-compose.yml" | head -1)"
PY_IMAGE="$(sed -n 's/^FROM \(python:[^ ]*\) AS base$/\1/p' "$ROOT/workers/media/Dockerfile" | head -1)"
[ -n "$NODE_IMAGE" ] && [ -n "$PY_IMAGE" ] || fail "cannot find the pinned node and python images in the repository"
# The server's own exporter (apps/api/src/metrics/otlp.ts, no imports) on the api telemetry network: two requests, a full
# database pool with waiting requests, and an outbox with a dead event and an old pending one.
docker run --rm --network post-history-telemetry-api --user 65534:65534 --read-only --cap-drop ALL \
  -v "$ROOT/apps/api/src/metrics/otlp.ts:/m/otlp.ts:ro" --entrypoint node "$NODE_IMAGE" --no-warnings --input-type=module -e '
import { RequestDurations, metricsPayload, pushMetrics, unixNano } from "/m/otlp.ts";
const durations = new RequestDurations();
durations.record("GET", "/v1/smoke", 200, 0.02);
durations.record("GET", "/v1/smoke", 500, 0.2);
const now = unixNano();
const payload = metricsPayload({ started: now, at: now, requests: durations.series(),
  pool: { idle: 0, used: 10, max: 10, pending: 2 }, outbox: { pending: 3, dead: 1, oldest: 3600 } });
const status = await pushMetrics(process.argv[1], payload, 5000);
if (status !== 200) { console.error(`the collector answered ${status}`); process.exit(1); }' "$ENDPOINT" \
  || fail "the server exporter did not reach the collector on the api telemetry network"
# The media worker's own exporter (workers/media/src/media_worker/metrics.py, standard library only) on the workers network.
docker run --rm --network post-history-telemetry-workers --user 65534:65534 --read-only --cap-drop ALL \
  -e PYTHONDONTWRITEBYTECODE=1 -e PYTHONPATH=/src -v "$ROOT/workers/media/src:/src:ro" --entrypoint python "$PY_IMAGE" -c '
import sys
from media_worker.metrics import Metrics
metrics = Metrics(sys.argv[1], "media-worker", interval_s=0)
metrics.event("media:events", "upload.verified", "done", 1.5)
sys.exit(0 if metrics.flush_if_due() else 1)' "$ENDPOINT" \
  || fail "the media worker exporter did not reach the collector on the workers telemetry network"
# Read back from Prometheus under the names and labels the alert rules use.
app_names() { get "http://127.0.0.1:9090/api/v1/label/__name__/values" | tr ',' '\n' | tr -d '"[]{}' | grep -E '^(http_server|db_client|outbox|media_worker)' | tr '\n' ' '; }
for m in 'http_server_request_duration_seconds_count{http_request_method="GET",http_route="/v1/smoke",http_response_status_code="500"}' \
         'db_client_connection_count{db_client_connection_state="used"}' db_client_connection_max db_client_connection_pending_requests \
         outbox_events_pending outbox_events_dead outbox_events_oldest_pending_age_seconds \
         'media_worker_events_total{queue="media:events",event_type="upload.verified",outcome="done"}' media_worker_event_duration_seconds_count; do
  until_ok 40 "has '$m'" || fail "an application metric did not reach Prometheus: $m (present: $(app_names))"
done
echo "server and media worker exporters reach the collector, their metrics read from Prometheus: ok"
# Alert rules: loaded, and the three whose condition the values above meet are raised (pending counts: 'for' has not elapsed).
rules="$(get http://127.0.0.1:9090/api/v1/rules)"
for a in OutboxDeadEvents OutboxOldestPendingAge ServerErrorRatio DatabasePoolExhausted; do
  grep -q "\"name\":\"$a\"" <<<"$rules" || fail "alert rule $a is not loaded"
done
if grep -q '"health":"err"' <<<"$rules"; then fail "an alert rule fails to evaluate"; fi
for a in OutboxDeadEvents OutboxOldestPendingAge DatabasePoolExhausted; do
  until_ok 40 "has 'ALERTS{alertname=\"$a\"}'" || fail "alert $a is not raised by the server's metrics"
done
echo "alert rules loaded, raised by a dead outbox event, an old pending event and an exhausted pool: ok"
# The override renders over the base compose (its .env is written by CI and by a local setup) and wires what it says.
if [ -f "$ROOT/infra/compose/.env" ]; then
  docker compose -f "$ROOT/infra/compose/docker-compose.yml" -f "$HERE/compose.telemetry.yml" --profile api --profile media \
    config --format json > "$WORK/telemetry.json" 2> "$WORK/telemetry.err" \
    || { cat "$WORK/telemetry.err" >&2; fail "compose.telemetry.yml does not render over the base compose"; }
  python3 - "$WORK/telemetry.json" "$ENDPOINT" <<'PY' || fail "compose.telemetry.yml does not wire the server and the media worker as it says"
import json, sys
services = json.load(open(sys.argv[1]))["services"]
want = {"api": "telemetry-api", "media-worker": "telemetry-workers"}
bad = [name for name, net in want.items()
       if services[name]["environment"].get("OTEL_EXPORTER_OTLP_ENDPOINT") != sys.argv[2] or net not in services[name]["networks"]
       or any(other in services[name]["networks"] for other in want.values() if other != net)]
# the media worker stays on its internal network plus the telemetry one, nothing else
if sorted(services["media-worker"]["networks"]) != ["media", "telemetry-workers"]:
    bad.append("media-worker networks")
print(", ".join(bad)); sys.exit(1 if bad else 0)
PY
  echo "telemetry override over the base compose: server and media worker wired, each on its own network: ok"
else
  echo "telemetry override render: skipped (no infra/compose/.env on this host)"
fi

g() { curl -sS --max-time 10 -u "admin:$GPW" "http://127.0.0.1:$GRAFANA_PORT$1"; }
[ "$(g /api/datasources | python3 -c 'import json,sys; print(sorted(d["type"] for d in json.load(sys.stdin)))')" = "['loki', 'prometheus']" ] \
  || fail "grafana datasources are not Prometheus and Loki"
g /api/dashboards/uid/post-history-host | grep -q '"uid":"post-history-host"' || fail "the provisioned dashboard is missing"
[ "$(curl -sS -o /dev/null -w '%{http_code}' "http://127.0.0.1:$GRAFANA_PORT/api/dashboards/uid/post-history-host")" = 401 ] \
  || fail "grafana answers without a login"
echo "grafana with its datasources and dashboard, login required: ok"

used_mb="$(docker stats --no-stream --format '{{.MemUsage}}' $("${C[@]}" ps -q) | python3 -c '
import re, sys
unit = {"B": 1, "KiB": 2**10, "MiB": 2**20, "GiB": 2**30, "kB": 1e3, "MB": 1e6, "GB": 1e9}
print(round(sum(float(n) * unit[u] for n, u in (re.match(r"\s*([\d.]+)\s*([A-Za-z]+)", l).groups() for l in sys.stdin)) / 2**20))')"
docker stats --no-stream --format '{{.Name}} {{.MemUsage}}' $("${C[@]}" ps -q)
[ "$used_mb" -lt "$total" ] || fail "memory in use $used_mb MB is not under the limits ($total MB)"
echo "memory in use: $used_mb MB of $total MB limits: ok"
if grep -qF "$GPW" <<<"$("${C[@]}" logs --no-color 2>&1)"; then fail "the grafana password appears in a log"; fi

if [ -n "$JSON" ]; then
  mkdir -p "$(dirname "$JSON")"
  python3 - "$JSON" "$total" "$used_mb" <<'PY'
import json, os, sys, datetime
out, total, used = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
now = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
json.dump({"schema_version": 1, "tool": "other", "role": "infra", "started_at": now, "ended_at": now,
           "result": "pass" if used < total else "fail",
           "device": {"platform": "server", "model": os.environ.get("MEASURE_HOST", "local docker compose")},
           "metrics": {"memory_limits_mb": total, "memory_used_mb": used},
           "notes": "infra/observability/smoke-monitoring.sh (ADR 0027): Prometheus, Grafana, Loki, OpenTelemetry collector and node-exporter after a canary log, an OTLP span and metric, and dashboard reads. Idle stack with almost no data: the trial host's use grows with retention and is measured there."},
          open(out, "w"), indent=2)
PY
fi
echo "monitoring smoke: ok"
