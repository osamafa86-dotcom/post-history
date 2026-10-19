#!/usr/bin/env bash
# مسار الخطّاف من طرف إلى طرف (SEC-06، اختبارات S5): العميل ← tusd-proxy ← tusd ← خطّاف داخلي ← الخادم.
# يشغّل compose بملف الخادم (profile api) ويتحقق من أن:
#   1) إنشاء رفع برمز غير صالح يصل إلى الخادم ويُرفض (403 من tusd لا 500)،
#   2) /internal/* من خارج عنوان tusd يُرفض حتى بالرمز الصحيح.
# E2E_EXTRA_COMPOSE: ملف compose إضافي اختياري (مثلًا لتخطي npm ci على مضيف بلا شبكة داخل الحاويات).
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE=(docker compose -f "$DIR/docker-compose.yml" ${E2E_EXTRA_COMPOSE:+-f "$E2E_EXTRA_COMPOSE"} --profile api)
# shellcheck disable=SC1091
set -a; . "$DIR/.env"; set +a

fail() { echo "!! $*" >&2; "${COMPOSE[@]}" logs --tail 50 api tusd >&2 || true; exit 1; }

"${COMPOSE[@]}" up -d --wait

b64() { printf '%s' "$1" | base64 | tr -d '\n'; }
meta="upload_session_id $(b64 00000000-0000-4000-8000-000000000000),filename $(b64 e2e.bin)"
bogus_token="$(openssl rand -hex 24)"  # random, never a valid upload token
code="$(curl -sS -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:${TUSD_PORT}/files/" \
  -H 'Tus-Resumable: 1.0.0' -H 'Upload-Length: 10' -H "Upload-Metadata: $meta" \
  -H "Authorization: Bearer ${bogus_token}")"
[ "$code" = 403 ] || fail "tus create with an invalid upload token: expected 403 (hook rejection), got $code"

code="$(curl -sS -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' \
  -d '{"Type":"pre-create","Event":{}}' "http://127.0.0.1:${API_PORT}/internal/tusd-hooks/${TUSD_HOOK_SECRET}")"
case "$code" in 403|404) ;; *) fail "/internal from outside tusd's address: expected 403/404, got $code" ;; esac

# Captured first: with pipefail, `logs | grep -q` can turn a match into a SIGPIPE failure and hide it.
api_log="$("${COMPOSE[@]}" logs api)"
if grep -qF "$TUSD_HOOK_SECRET" <<<"$api_log"; then fail "hook token in API log"; fi

echo "e2e hooks: ok"
