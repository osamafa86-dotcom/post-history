#!/usr/bin/env bash
# تحديث مضيف التجربة بلا فقد (ADR 0013). بصلاحية root، بعد bootstrap.sh وunseal (الأسرار في /run/post-history):
#   sudo infra/deploy/update.sh [--ref origin/main] [--dry-run]
#
#   1. قفل (تحديث واحد في وقت واحد)، وحفظ الإيداع الحالي للتراجع.
#   2. نسخة احتياطية مشفّرة الآن (backup once): الترحيلات لا تُعكس آليًا، فهذه نقطة الاستعادة إن لزم.
#   3. جلب الإيداع الهدف (root؛ الشجرة ملكه)، وفحص البصمات، وسحب الصور وبناء صورة النسخ.
#   4. إعادة تشغيل متدرجة، خدمة بعد خدمة (compose يعيد إنشاء ما تغيّر فقط)، وفحص صحة بعد كل مرحلة:
#      الخادم يطبّق الترحيلات عند بدئه، و/health على 127.0.0.1 يجب أن يعود 200، والرفع يصل إلى tusd.
#   5. عند أي فشل: العودة إلى الإيداع السابق وتشغيله وفحص صحته، والخروج بخطأ.
#   6. preflight.sh --running.
# التراجع يعيد الكود لا المخطط: الترحيلات تُكتب متوافقة مع الإصدار السابق (توسيع ثم تقليص)، وإلا فالاستعادة من نسخة
# الخطوة 2 (infra/backup/restore-drill.sh يثبت أنها تُستعاد).
set -Eeuo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP="$(cd "$HERE/../.." && pwd)"
REF=origin/main DRY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --ref) REF="$2"; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    *) echo "usage: $0 [--ref REF] [--dry-run]" >&2; exit 2 ;;
  esac
done
T="$APP/infra/field-trial/trial.sh"
API_PORT="$(sed -n 's/^API_PORT=//p' "$APP/infra/compose/.env.example" | tail -1)"
TUSD_PORT="$(sed -n 's/^TUSD_PORT=//p' "$APP/infra/compose/.env.example" | tail -1)"
# الخدمات بترتيب الاعتماد: البيانات أولًا، ثم الرفع، ثم الخادم، ثم العامل والحافة والنسخ.
STAGES=("postgres redis minio" "tusd tusd-proxy ingest-gate" "api" "media-worker" "caddy caddy-ingest" "backup")

run() { if [ "$DRY" = 1 ]; then printf '+ %s\n' "$*"; else "$@"; fi; }
as_user() { run git -C "$APP" "$@"; }   # root: الشجرة ملكه وحده (bootstrap.sh)
log() { echo "== $*"; }
wait_ok() { # الوصف، الأمر؛ حتى 300 ث
  [ "$DRY" = 1 ] && { echo "+ wait until: $1"; return 0; }
  for _ in $(seq 1 60); do eval "$2" >/dev/null 2>&1 && return 0; sleep 5; done
  echo "!! health check failed: $1" >&2; return 1
}
healthy() {
  wait_ok "API /health 200 on 127.0.0.1:$API_PORT" \
    "[ \"\$(curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:$API_PORT/health)\" = 200 ]" &&
  wait_ok "tusd answers through tusd-proxy" \
    "curl -sS -o /dev/null -D - -X OPTIONS -H 'Tus-Resumable: 1.0.0' http://127.0.0.1:$TUSD_PORT/files/ | grep -qi '^tus-resumable:'"
}

[ "$(id -u)" = 0 ] || [ "$DRY" = 1 ] || { echo "run as root" >&2; exit 1; }
[ -r "${TRIAL_ENV_FILE:-/run/post-history/trial.env}" ] || [ "$DRY" = 1 ] \
  || { echo "secrets not unsealed: run infra/deploy/unseal.sh" >&2; exit 1; }

log "1/6 lock and record the current commit"
if [ "$DRY" = 0 ]; then
  exec 9>/run/post-history/update.lock
  flock -n 9 || { echo "another update is running" >&2; exit 1; }
fi
prev="$(git -C "$APP" rev-parse HEAD)"
echo "current: $prev"

log "2/6 encrypted backup before the update"
run "$T" run --rm -T backup once

rollback() {
  echo "!! update failed: rolling back to $prev" >&2
  as_user checkout -q --detach "$prev"
  run "$T" build backup
  run "$T" up -d --wait
  if healthy; then echo "rolled back to $prev and healthy" >&2; else echo "!! rollback unhealthy: see docs/ops/runbook.md" >&2; fi
  exit 1
}

log "3/6 fetch $REF, check pins, pull images"
as_user fetch -q origin
as_user checkout -q --detach "$REF"
trap rollback ERR
run "$APP/infra/compose/check-pinned.sh"
run "$T" pull --quiet
run "$T" build backup

log "4/6 staged restart with health checks"
for stage in "${STAGES[@]}"; do
  # shellcheck disable=SC2086
  run "$T" up -d --no-deps --wait $stage
  case "$stage" in
    *api*|*tusd*|*caddy*) healthy ;;
  esac
done
trap - ERR

log "5/6 updated: $prev -> $(git -C "$APP" rev-parse HEAD)"
log "6/6 preflight after start"
run "$APP/infra/field-trial/preflight.sh" --running
echo "update: done"
