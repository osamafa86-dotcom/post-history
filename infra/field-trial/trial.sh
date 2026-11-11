#!/usr/bin/env bash
# compose بيئة التجربة بملفاته وprofiles وملفي البيئة (ADR 0013). كل أمر compose يمر من هنا:
#   infra/field-trial/trial.sh up -d --wait      infra/field-trial/trial.sh ps      infra/field-trial/trial.sh logs api
# TRIAL_ENV_FILE: ملف الأسرار المفكوك (الافتراضي /run/post-history/trial.env، tmpfs).
# TRIAL_EXTRA_COMPOSE: ملفات compose إضافية مفصولة بـ : للاختبار فقط (مثل تخطي البناء على مضيف بلا شبكة في الحاويات).
# TRIAL_TELEMETRY: off يمنع وصل الخادم والعاملين بمجمّع المراقبة (الافتراضي: يوصلون حين تكون شبكتاه قائمتين).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# The API image built for the checked-out commit (ADR 0050); infra/deploy/api-image.sh fetches or builds it.
export API_IMAGE="${API_IMAGE:-post-history-api:$(git -C "$ROOT" rev-parse HEAD)}"
extra=()
IFS=: read -r -a files <<<"${TRIAL_EXTRA_COMPOSE:-}"
for f in "${files[@]}"; do [ -z "$f" ] || extra+=(-f "$f"); done
# مقاييس التطبيقات (ADR 0027): حين تكون شبكتا المجمّع قائمتين (ينشئهما مشروع المراقبة) يلتحق بهما الخادم والعاملون ويُضبط لهم
# عنوان المجمّع؛ وإلا تعمل التجربة كما هي ولا يخرج منها مقياس. TRIAL_TELEMETRY=off يتخطى الوصل.
if [ "${TRIAL_TELEMETRY:-auto}" != off ] \
   && docker network inspect post-history-telemetry-api post-history-telemetry-workers >/dev/null 2>&1; then
  extra+=(-f "$ROOT/infra/observability/compose.telemetry.yml")
fi
exec docker compose --project-name "${TRIAL_PROJECT:-post-history-trial}" \
  --env-file "$ROOT/infra/compose/.env.example" --env-file "${TRIAL_ENV_FILE:-/run/post-history/trial.env}" \
  -f "$ROOT/infra/compose/docker-compose.yml" \
  -f "$ROOT/infra/field-trial/docker-compose.trial.yml" "${extra[@]}" \
  --profile api --profile media --profile ingest --profile edge --profile backup "$@"
