#!/usr/bin/env bash
# يتحقق من صلاحيات مستخدم عامل الوسائط في MinIO (ADR 0006): قراءة بادئة الرفع وكتابة derived/ فقط.
# يحتاج compose قائمًا و S3_MEDIA_ACCESS_KEY/S3_MEDIA_SECRET_KEY مضبوطين في infra/compose/.env.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../compose" && pwd)"
# shellcheck disable=SC1091
set -a; . "$DIR/.env"; set +a
: "${S3_MEDIA_ACCESS_KEY:?}" "${S3_MEDIA_SECRET_KEY:?}"
MC="$(sed -n 's/^ *image: \(pgsty\/mc:.*\)$/\1/p' "$DIR/docker-compose.yml")"
NET="${COMPOSE_PROJECT_NAME:-post-history}_default"

# Keys stay out of argv (SEC-05): exported here, passed to docker by name only.
export MC_HOST_a="http://$S3_ACCESS_KEY:$S3_SECRET_KEY@minio:9000"
export MC_HOST_w="http://$S3_MEDIA_ACCESS_KEY:$S3_MEDIA_SECRET_KEY@minio:9000"
adm() { docker run --rm -i --network "$NET" -e MC_HOST_a "$MC" "$@"; }
wrk() { docker run --rm -i --network "$NET" -e MC_HOST_w "$MC" "$@"; }
wrk_put() { echo z | wrk pipe "$1"; }
fails=0
expect() { # expect ALLOW|deny <description> <command...>
  local want="$1" what="$2"; shift 2
  if "$@" >/dev/null 2>&1; then got=ALLOW; else got=deny; fi
  printf '%-6s %-5s %s\n' "$([ "$got" = "$want" ] && echo ok || echo FAIL)" "$got" "$what"
  [ "$got" = "$want" ] || fails=$((fails + 1))
}

echo seed | adm pipe "a/$S3_BUCKET_UPLOADS/${TUSD_OBJECT_PREFIX}policy-check" >/dev/null
echo seed | adm pipe "a/$S3_BUCKET_UPLOADS/elsewhere/policy-check" >/dev/null

expect ALLOW "read upload prefix"      wrk cat "w/$S3_BUCKET_UPLOADS/${TUSD_OBJECT_PREFIX}policy-check"
expect deny  "read outside the prefix" wrk cat "w/$S3_BUCKET_UPLOADS/elsewhere/policy-check"
expect ALLOW "write derived/"          wrk_put "w/$S3_BUCKET_MEDIA/derived/policy-check"
expect deny  "write outside derived/"  wrk_put "w/$S3_BUCKET_MEDIA/other"
expect deny  "write the upload bucket" wrk_put "w/$S3_BUCKET_UPLOADS/${TUSD_OBJECT_PREFIX}x"
expect deny  "delete an original"      wrk rm "w/$S3_BUCKET_UPLOADS/${TUSD_OBJECT_PREFIX}policy-check"
expect deny  "delete a derivative"     wrk rm "w/$S3_BUCKET_MEDIA/derived/policy-check"
expect deny  "list the upload bucket"  wrk ls "w/$S3_BUCKET_UPLOADS/"

[ "$fails" -eq 0 ] || { echo "!! media worker policy: $fails unexpected result(s)" >&2; exit 1; }
echo "media worker policy: ok"
