#!/usr/bin/env bash
# دخان المراقبة ذاتية الاستضافة (ADR 0024)، في CI وعلى أي مضيف فيه Docker:
#   infra/observability/smoke-monitoring.sh [--json FILE]
# يثبت:
#   - سجل حاوية يصل إلى Loki باسمها (الوسم tag)، وما فيه من عنوان ورمز ومعرّف رفع وإحداثيات وجهاز منقّى قبل التخزين؛
#   - تتبّع OTLP يصير مقياس طلبات في Prometheus، ومقياس OTLP يصل كما هو؛
#   - مقاييس المضيف والفحوص الصحية (healthcheck.sh --prom) في Prometheus؛
#   - Grafana بمصدريه ولوحته، وعلى 127.0.0.1 وحده، ولا منفذ آخر منشور؛
#   - كل خدمة محدودة الذاكرة بلا swap، والاستهلاك الفعلي تحت الحدود.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
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
           "notes": "infra/observability/smoke-monitoring.sh (ADR 0024): Prometheus, Grafana, Loki, OpenTelemetry collector and node-exporter after a canary log, an OTLP span and metric, and dashboard reads. Idle stack with almost no data: the trial host's use grows with retention and is measured there."},
          open(out, "w"), indent=2)
PY
fi
echo "monitoring smoke: ok"
