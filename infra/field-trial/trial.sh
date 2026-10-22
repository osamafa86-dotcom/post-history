#!/usr/bin/env bash
# compose بيئة التجربة بملفاته وprofiles وملفي البيئة (ADR 0013). كل أمر compose يمر من هنا:
#   infra/field-trial/trial.sh up -d --wait      infra/field-trial/trial.sh ps      infra/field-trial/trial.sh logs api
# TRIAL_ENV_FILE: ملف الأسرار المفكوك (الافتراضي /run/post-history/trial.env، tmpfs).
# TRIAL_EXTRA_COMPOSE: ملفات compose إضافية مفصولة بـ : للاختبار فقط (مثل تخطي البناء على مضيف بلا شبكة في الحاويات).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# The API image built for the checked-out commit (ADR 0050); infra/deploy/api-image.sh fetches or builds it.
export API_IMAGE="${API_IMAGE:-post-history-api:$(git -C "$ROOT" rev-parse HEAD)}"
extra=()
IFS=: read -r -a files <<<"${TRIAL_EXTRA_COMPOSE:-}"
for f in "${files[@]}"; do [ -z "$f" ] || extra+=(-f "$f"); done
exec docker compose --project-name "${TRIAL_PROJECT:-post-history-trial}" \
  --env-file "$ROOT/infra/compose/.env.example" --env-file "${TRIAL_ENV_FILE:-/run/post-history/trial.env}" \
  -f "$ROOT/infra/compose/docker-compose.yml" \
  -f "$ROOT/infra/field-trial/docker-compose.trial.yml" "${extra[@]}" \
  --profile api --profile media --profile ingest --profile edge --profile backup "$@"
