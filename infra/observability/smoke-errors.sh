#!/usr/bin/env bash
# دخان تتبّع الأخطاء (ADR 0029): GlitchTip بحزم Sentry، في CI وعلى أي مضيف فيه Docker:
#   infra/observability/smoke-errors.sh [--json FILE]
# يثبت: الواجهة على 127.0.0.1 وحده، والتسجيل مغلق بعد التهيئة، وحدث بصيغة Sentry (DSN) يُخزَّن مسألة، ولا كلمة سر في
# السجلات، وكل خدمة محدودة الذاكرة بلا swap والاستهلاك تحت الحدود.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
JSON=""
[ "${1:-}" = --json ] && JSON="$2"
WORK="$(mktemp -d)"
export GLITCHTIP_PORT="${GLITCHTIP_PORT:-13301}"
umask 077
printf 'GLITCHTIP_SECRET_KEY=%s\nGLITCHTIP_DB_PASSWORD=%s\n' "$(openssl rand -hex 32)" "$(openssl rand -hex 16)" > "$WORK/errors.env"
umask 022
C=(docker compose -f "$HERE/compose.errors.yml" --env-file "$WORK/errors.env")
cleanup() { [ "${KEEP:-0}" = 1 ] || "${C[@]}" down -v --remove-orphans >/dev/null 2>&1 || true; rm -rf "$WORK"; }
trap cleanup EXIT
fail() { echo "!! $*" >&2; "${C[@]}" logs --tail 30 >&2 || true; exit 1; }

total="$("${C[@]}" config --format json | python3 -c '
import json, sys
s = json.load(sys.stdin)["services"]
bad = [k for k, v in s.items() if not v.get("mem_limit") or int(v.get("memswap_limit") or 0) != int(v["mem_limit"])]
print(-1 if bad else sum(int(v["mem_limit"]) for k, v in s.items() if k != "glitchtip-migrate") // 2**20)')"
[ "$total" -gt 0 ] || fail "a service without a memory limit, or with swap"
echo "memory limits: $total MB for the running services, no swap: ok"

"${C[@]}" up -d --wait >/dev/null 2>&1 || fail "error tracking did not come up"
for id in $("${C[@]}" ps -q); do
  b="$(docker inspect -f '{{json .HostConfig.PortBindings}}' "$id")"
  case "$(docker inspect -f '{{.Name}}' "$id")" in
    *-glitchtip-1) grep -q '"HostIp":"127.0.0.1"' <<<"$b" && ! grep -qE '"HostIp":"(0\.0\.0\.0|::|)"' <<<"$b" || fail "glitchtip published beyond 127.0.0.1: $b" ;;
    *) [ "$b" = "{}" ] || fail "$(docker inspect -f '{{.Name}}' "$id") publishes a port" ;;
  esac
done
echo "only glitchtip published, on 127.0.0.1: ok"

PW="$(openssl rand -hex 16)"
dsns="$(GLITCHTIP_ADMIN_PASSWORD="$PW" "$HERE/errors-init.sh" ops@example.invalid --env-file "$WORK/errors.env")" || fail "errors-init.sh"
GLITCHTIP_ADMIN_PASSWORD="$PW" "$HERE/errors-init.sh" ops@example.invalid --env-file "$WORK/errors.env" >/dev/null || fail "errors-init.sh is not repeatable"
api="$(sed -n 's/^api DSN //p' <<<"$dsns")"
[ -n "$api" ] || fail "no DSN for the api project"
[ "$(curl -s "http://127.0.0.1:$GLITCHTIP_PORT/api/settings/" | python3 -c 'import json,sys; print(json.load(sys.stdin)["enableUserRegistration"])')" = False ] \
  || fail "user registration is open after init"
echo "admin created, registration closed, api and web projects with DSNs: ok"

# A Sentry SDK's store request, built from the DSN.
key="$(sed -E 's#^http://([0-9a-f]+)@.*#\1#' <<<"$api")" pid="${api##*/}"
MARK="ph-smoke-$(openssl rand -hex 6)"
code="$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$GLITCHTIP_PORT/api/$pid/store/" -H 'Content-Type: application/json' \
  -H "X-Sentry-Auth: Sentry sentry_version=7, sentry_key=$key, sentry_client=ph-smoke/1.0" \
  -d "{\"event_id\":\"$(openssl rand -hex 16)\",\"platform\":\"node\",\"level\":\"error\",\"exception\":{\"values\":[{\"type\":\"Error\",\"value\":\"$MARK\"}]}}")"
[ "$code" = 200 ] || fail "store endpoint answered $code"
for _ in $(seq 1 30); do
  n="$("${C[@]}" exec -T glitchtip-postgres psql -U glitchtip -d glitchtip -XAtc "select count(*) from issue_events_issue where title like '%$MARK%'" 2>/dev/null || echo 0)"
  [ "$n" = 1 ] && break; sleep 2
done
[ "$n" = 1 ] || fail "the Sentry event was not stored as an issue"
echo "a Sentry-format event is stored as an issue: ok"

used_mb="$(docker stats --no-stream --format '{{.MemUsage}}' $("${C[@]}" ps -q) | python3 -c '
import re, sys
unit = {"B": 1, "KiB": 2**10, "MiB": 2**20, "GiB": 2**30, "kB": 1e3, "MB": 1e6, "GB": 1e9}
print(round(sum(float(n) * unit[u] for n, u in (re.match(r"\s*([\d.]+)\s*([A-Za-z]+)", l).groups() for l in sys.stdin)) / 2**20))')"
docker stats --no-stream --format '{{.Name}} {{.MemUsage}}' $("${C[@]}" ps -q)
[ "$used_mb" -lt "$total" ] || fail "memory in use $used_mb MB is not under the limits ($total MB)"
echo "memory in use: $used_mb MB of $total MB limits: ok"
if grep -qF "$PW" <<<"$("${C[@]}" logs --no-color 2>&1)"; then fail "the admin password appears in a log"; fi

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
           "notes": "infra/observability/smoke-errors.sh (ADR 0029): GlitchTip all-in-one with its Postgres and Redis after init and one Sentry-format event. Idle, almost no data; Sentry self-hosted needs 16 GB alone."},
          open(out, "w"), indent=2)
PY
fi
echo "error tracking smoke: ok"
