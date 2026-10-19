#!/usr/bin/env bash
# دخان عامل الوسائط (ADR 0006): يشغّل compose بالخادم والعامل (profiles api وmedia) ويتحقق من أن:
#   1) العامل يعمل ولا يُعاد تشغيله، بالتحصين المقرر (جذر للقراءة فقط، cap_drop ALL، no-new-privileges،
#      مستخدم غير جذر، حدود الذاكرة والمعالج والعمليات، بلا منفذ منشور)،
#   2) على شبكة media وحدها بالعنوان الثابت، ولا يصل إلى خارجها (الإنترنت ولا Postgres)،
#   3) يصل إلى /internal/media على الخادم برمزه (400/422 لجسم فارغ بعد المصادقة، لا 404)، والرمز نفسه من المضيف يُرفض،
#   4) بيئته لا تحمل أسرارًا لا تلزمه، والرمز غائب عن سجلي الخادم والعامل.
# يضبط UPLOAD_VERIFIER=external وMEDIA_WORKER_TOKEN لهذا التشغيل إن لم يكونا في .env.
# E2E_EXTRA_COMPOSE: ملف compose إضافي اختياري (مثلًا لتخطي npm ci على مضيف بلا شبكة داخل الحاويات).
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE=(docker compose -f "$DIR/docker-compose.yml" ${E2E_EXTRA_COMPOSE:+-f "$E2E_EXTRA_COMPOSE"} --profile api --profile media)
# shellcheck disable=SC1091
set -a; . "$DIR/.env"; set +a
export UPLOAD_VERIFIER=external
export MEDIA_WORKER_TOKEN="${MEDIA_WORKER_TOKEN:-$(openssl rand -hex 32)}"

fail() { echo "!! $*" >&2; "${COMPOSE[@]}" logs --tail 50 api media-worker >&2 || true; exit 1; }

"${COMPOSE[@]}" up -d --wait --build
sleep 10  # a worker that cannot start (bad token, Redis auth) exits and restarts within this window

cid="$("${COMPOSE[@]}" ps -q media-worker)"
[ -n "$cid" ] || fail "media-worker container not found"
insp() { docker inspect -f "$1" "$cid"; }

[ "$(insp '{{.State.Running}} {{.RestartCount}}')" = "true 0" ] || fail "worker not running steadily: $(insp '{{.State.Status}} restarts={{.RestartCount}}')"
[ "$(insp '{{.HostConfig.ReadonlyRootfs}}')" = true ] || fail "root filesystem is writable"
[ "$(insp '{{json .HostConfig.CapDrop}}')" = '["ALL"]' ] || fail "capabilities not all dropped: $(insp '{{json .HostConfig.CapDrop}}')"
insp '{{json .HostConfig.SecurityOpt}}' | grep -qF 'no-new-privileges:true' || fail "no-new-privileges missing"
uid="$(docker exec "$cid" id -u)"
[ "$uid" != 0 ] || fail "worker runs as root"
for f in Memory NanoCpus PidsLimit; do
  v="$(insp "{{.HostConfig.$f}}")"
  [ "${v:-0}" != 0 ] && [ "$v" != "<nil>" ] || fail "no $f limit"
done
[ "$(insp '{{len .NetworkSettings.Ports}}')" = 0 ] || fail "worker has ports: $(insp '{{json .NetworkSettings.Ports}}')"

nets="$(insp '{{range $k, $v := .NetworkSettings.Networks}}{{$k}}={{$v.IPAddress}} {{end}}')"
case "$nets" in *_media=172.30.251.2\ ) ;; *) fail "expected only the media network at 172.30.251.2, got: $nets" ;; esac

# Python is the only tool in the image: one probe per check, exit 0 = reachable.
py() { docker exec -e MEDIA_WORKER_TOKEN "$cid" python -c "$1"; }
reach='import socket,sys; s=socket.socket(); s.settimeout(3)
try: s.connect((sys.argv[1], int(sys.argv[2])))
except OSError: sys.exit(1)'
if docker exec "$cid" python -c "$reach" 1.1.1.1 443; then fail "worker reaches the internet"; fi
if docker exec "$cid" python -c "$reach" postgres 5432; then fail "worker reaches Postgres"; fi

probe='import os, urllib.request, urllib.error
req = urllib.request.Request("http://api:3000/internal/media/sessions/00000000-0000-4000-8000-000000000000/verification",
    data=b"{}", method="POST", headers={"Content-Type": "application/json",
    "Authorization": "Bearer " + os.environ["MEDIA_WORKER_TOKEN"]})
try: print(urllib.request.urlopen(req, timeout=10).status)
except urllib.error.HTTPError as e: print(e.code)'
code="$(py "$probe")"
case "$code" in 400|422) ;; *) fail "worker -> /internal/media with its token: expected 400/422 (authenticated, empty body rejected), got $code" ;; esac

code="$(curl -sS -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' -d '{}' \
  -H "Authorization: Bearer ${MEDIA_WORKER_TOKEN}" \
  "http://127.0.0.1:${API_PORT}/internal/media/sessions/00000000-0000-4000-8000-000000000000/verification")"
case "$code" in 403|404) ;; *) fail "/internal/media from the host with the worker token: expected 403/404, got $code" ;; esac

# The worker needs only its own token, Redis, and its own MinIO user.
wenv="$(insp '{{range .Config.Env}}{{println .}}{{end}}')"
# A secret equal to one the worker legitimately holds (placeholders in .env.example) cannot be checked: refuse.
for k in TUSD_HOOK_SECRET JWT_SECRET FIELD_ENCRYPTION_KEY POSTGRES_PASSWORD S3_SECRET_KEY; do
  v="${!k:-}"
  [ -n "$v" ] || continue
  for own in REDIS_PASSWORD MEDIA_WORKER_TOKEN S3_MEDIA_SECRET_KEY; do
    [ "$v" != "${!own:-}" ] || fail "$k equals $own: set distinct values in .env to check the worker environment"
  done
  if grep -qF "$v" <<<"$wenv"; then fail "worker environment carries $k"; fi
done

# Captured first: with pipefail, `logs | grep -q` can turn a match into a SIGPIPE failure and hide it.
logs="$("${COMPOSE[@]}" logs api media-worker)"
if grep -qF "$MEDIA_WORKER_TOKEN" <<<"$logs"; then fail "worker token in a log"; fi

echo "media worker smoke: ok"
