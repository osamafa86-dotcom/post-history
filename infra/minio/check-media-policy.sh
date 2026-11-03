#!/usr/bin/env bash
# يتحقق من صلاحيات مستخدم عامل الوسائط في MinIO (ADR 0006): قراءة بادئة الرفع وكتابة derived/ فقط؛ ومستخدمي tusd (بادئة
# الرفع قراءةً وكتابة وحدها) والخادم (قراءة الحاويتين وحذف كائنات tus، بلا كتابة ولا إدارة)؛ ومستخدم عامل
# التفريغ (ADR 0019) إن ضُبط: قراءة derived/*/*/proxy-480p.mp4 وderived/*/*/audio-16k.m4a، وقراءة مشتقاته وكتابتها فقط:
# derived/*/*/{transcript.json,transcript.vtt,shots.json,shot_list.json} (اللقطات ADR 0026).
# يحتاج compose قائمًا و S3_MEDIA_ACCESS_KEY/S3_MEDIA_SECRET_KEY (وS3_AI_* اختياريًا) مضبوطين في infra/compose/.env.
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

# tusd and the API run on their own users, not the root one (which minio-init alone holds).
: "${S3_TUSD_ACCESS_KEY:?}" "${S3_TUSD_SECRET_KEY:?}" "${S3_API_ACCESS_KEY:?}" "${S3_API_SECRET_KEY:?}"
export MC_HOST_u="http://$S3_TUSD_ACCESS_KEY:$S3_TUSD_SECRET_KEY@minio:9000"
export MC_HOST_p="http://$S3_API_ACCESS_KEY:$S3_API_SECRET_KEY@minio:9000"
tus_() { docker run --rm -i --network "$NET" -e MC_HOST_u "$MC" "$@"; }
api_() { docker run --rm -i --network "$NET" -e MC_HOST_p "$MC" "$@"; }
tus_put() { echo z | tus_ pipe "$1"; }
api_put() { echo z | api_ pipe "$1"; }
echo seed | adm pipe "a/$S3_BUCKET_UPLOADS/${TUSD_OBJECT_PREFIX}api-delete-check" >/dev/null
echo seed | adm pipe "a/$S3_BUCKET_MEDIA/derived/m/policy-check/poster.jpg" >/dev/null
expect ALLOW "tusd: write the upload prefix"      tus_put "u/$S3_BUCKET_UPLOADS/${TUSD_OBJECT_PREFIX}tusd-check"
expect ALLOW "tusd: read the upload prefix"       tus_ cat "u/$S3_BUCKET_UPLOADS/${TUSD_OBJECT_PREFIX}policy-check"
expect ALLOW "tusd: delete in the upload prefix"  tus_ rm "u/$S3_BUCKET_UPLOADS/${TUSD_OBJECT_PREFIX}tusd-check"
expect deny  "tusd: write outside the prefix"     tus_put "u/$S3_BUCKET_UPLOADS/elsewhere/x"
expect deny  "tusd: read the media bucket"        tus_ cat "u/$S3_BUCKET_MEDIA/derived/m/policy-check/poster.jpg"
expect deny  "tusd: write the media bucket"       tus_put "u/$S3_BUCKET_MEDIA/derived/x"
expect deny  "tusd: administer MinIO"             tus_ admin user list u
expect ALLOW "api: read an original"              api_ cat "p/$S3_BUCKET_UPLOADS/${TUSD_OBJECT_PREFIX}policy-check"
expect deny  "api: read outside the prefix"       api_ cat "p/$S3_BUCKET_UPLOADS/elsewhere/policy-check"
expect ALLOW "api: read a derivative"             api_ cat "p/$S3_BUCKET_MEDIA/derived/m/policy-check/poster.jpg"
expect ALLOW "api: delete a session's tus object" api_ rm "p/$S3_BUCKET_UPLOADS/${TUSD_OBJECT_PREFIX}api-delete-check"
expect deny  "api: write the upload bucket"       api_put "p/$S3_BUCKET_UPLOADS/${TUSD_OBJECT_PREFIX}x"
expect deny  "api: write the media bucket"        api_put "p/$S3_BUCKET_MEDIA/derived/x"
expect deny  "api: delete a derivative"           api_ rm "p/$S3_BUCKET_MEDIA/derived/m/policy-check/poster.jpg"
expect deny  "api: administer MinIO"              api_ admin user list p

if [ -n "${S3_AI_ACCESS_KEY:-}" ] && [ -n "${S3_AI_SECRET_KEY:-}" ]; then
  export MC_HOST_t="http://$S3_AI_ACCESS_KEY:$S3_AI_SECRET_KEY@minio:9000"
  ai() { docker run --rm -i --network "$NET" -e MC_HOST_t "$MC" "$@"; }
  ai_put() { echo z | ai pipe "$1"; }
  echo seed | adm pipe "a/$S3_BUCKET_MEDIA/derived/m/policy-check/proxy-480p.mp4" >/dev/null
  echo seed | adm pipe "a/$S3_BUCKET_MEDIA/derived/m/policy-check/thumb.jpg" >/dev/null
  echo seed | adm pipe "a/$S3_BUCKET_MEDIA/derived/m/policy-check/audio-16k.m4a" >/dev/null
  echo seed | adm pipe "a/$S3_BUCKET_MEDIA/derived/m/policy-check/audio-48k.m4a" >/dev/null
  expect ALLOW "ai: read the 480p proxy"        ai cat "t/$S3_BUCKET_MEDIA/derived/m/policy-check/proxy-480p.mp4"
  expect ALLOW "ai: read the 16k audio"         ai cat "t/$S3_BUCKET_MEDIA/derived/m/policy-check/audio-16k.m4a"
  expect deny  "ai: read another audio file"    ai cat "t/$S3_BUCKET_MEDIA/derived/m/policy-check/audio-48k.m4a"
  expect deny  "ai: overwrite the 16k audio"    ai_put "t/$S3_BUCKET_MEDIA/derived/m/policy-check/audio-16k.m4a"
  expect deny  "ai: read another derivative"    ai cat "t/$S3_BUCKET_MEDIA/derived/m/policy-check/thumb.jpg"
  expect deny  "ai: read an original"           ai cat "t/$S3_BUCKET_UPLOADS/${TUSD_OBJECT_PREFIX}policy-check"
  expect ALLOW "ai: write a transcript"         ai_put "t/$S3_BUCKET_MEDIA/derived/m/policy-check/transcript.json"
  expect ALLOW "ai: read its transcript"        ai cat "t/$S3_BUCKET_MEDIA/derived/m/policy-check/transcript.json"
  expect ALLOW "ai: write transcript.vtt"       ai_put "t/$S3_BUCKET_MEDIA/derived/m/policy-check/transcript.vtt"
  expect deny  "ai: write captions.vtt"        ai_put "t/$S3_BUCKET_MEDIA/derived/m/policy-check/captions.vtt"
  expect ALLOW "ai: write shots.json"           ai_put "t/$S3_BUCKET_MEDIA/derived/m/policy-check/shots.json"
  expect ALLOW "ai: read its shots.json"        ai cat "t/$S3_BUCKET_MEDIA/derived/m/policy-check/shots.json"
  expect ALLOW "ai: write shot_list.json"       ai_put "t/$S3_BUCKET_MEDIA/derived/m/policy-check/shot_list.json"
  expect ALLOW "ai: read its shot_list.json"    ai cat "t/$S3_BUCKET_MEDIA/derived/m/policy-check/shot_list.json"
  expect deny  "ai: delete shots.json"          ai rm "t/$S3_BUCKET_MEDIA/derived/m/policy-check/shots.json"
  expect deny  "ai: shots outside derived/"     ai_put "t/$S3_BUCKET_MEDIA/shots.json"
  expect deny  "ai: other transcript type"     ai_put "t/$S3_BUCKET_MEDIA/derived/m/policy-check/transcript.html"
  expect deny  "ai: overwrite the proxy"        ai_put "t/$S3_BUCKET_MEDIA/derived/m/policy-check/proxy-480p.mp4"
  expect deny  "ai: write outside transcript.*" ai_put "t/$S3_BUCKET_MEDIA/derived/m/policy-check/other.txt"
  expect deny  "ai: write outside derived/"     ai_put "t/$S3_BUCKET_MEDIA/transcript.json"
  expect deny  "ai: delete a transcript"        ai rm "t/$S3_BUCKET_MEDIA/derived/m/policy-check/transcript.json"
  expect deny  "ai: list the media bucket"      ai ls "t/$S3_BUCKET_MEDIA/"
fi

[ "$fails" -eq 0 ] || { echo "!! media worker policy: $fails unexpected result(s)" >&2; exit 1; }
echo "media worker policy: ok"
