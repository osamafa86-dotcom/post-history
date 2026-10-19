#!/usr/bin/env bash
# فحص دخاني لـ compose (محليًا وفي CI): كل الخدمات تقوم، tusd لا يُبلغ إلا عبر الوكيل،
# ورمز الخطّاف (SEC-06) لا يظهر في سجل tusd ولا في رد الخطأ للعميل حين يتعذّر الوصول إلى الخادم.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE=(docker compose -f "$DIR/docker-compose.yml")
# shellcheck disable=SC1091
set -a; . "$DIR/.env"; set +a
BASE="http://127.0.0.1:${TUSD_PORT}"

"${COMPOSE[@]}" up -d --wait

fail() { echo "!! $*" >&2; exit 1; }

curl -fsS -o /dev/null -X OPTIONS "$BASE/files/" || fail "tusd not reachable through tusd-proxy"
[ "$(curl -sS -o /dev/null -w '%{http_code}' "$BASE/metrics")" = 404 ] || fail "/metrics exposed through proxy"
bindings="$(docker inspect -f '{{json .HostConfig.PortBindings}}' "$("${COMPOSE[@]}" ps -q tusd)")"
[ "$bindings" = "{}" ] || fail "tusd has a published port: $bindings"

# -disable-download: tusd registers no GET route, so 405 (404 here would mean downloads are on).
code="$(curl -sS -o /dev/null -w '%{http_code}' "$BASE/files/does-not-matter")"
[ "$code" = 405 ] || fail "GET on upload URL returned $code (expected 405: -disable-download)"

# No API on the hooks network yet: pre-create fails at transport level, the case where tusd echoes the hook URL.
body="$(curl -sS -X POST -H 'Tus-Resumable: 1.0.0' -H 'Upload-Length: 10' "$BASE/files/")"
case "$body" in *"$TUSD_HOOK_SECRET"*) fail "hook token in client response" ;; esac
"${COMPOSE[@]}" logs tusd | grep -q 'tusd-hooks/\[REDACTED\]' || fail "redaction marker missing from tusd log"
if "${COMPOSE[@]}" logs tusd | grep -qF "$TUSD_HOOK_SECRET"; then fail "hook token in tusd log"; fi

echo "compose smoke: ok"
