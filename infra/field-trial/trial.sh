#!/usr/bin/env bash
# compose بيئة التجربة بملفاته وprofiles وملفي البيئة (ADR 0013). كل أمر compose يمر من هنا:
#   infra/field-trial/trial.sh up -d --wait      infra/field-trial/trial.sh ps      infra/field-trial/trial.sh logs api
# TRIAL_ENV_FILE: ملف الأسرار المفكوك (الافتراضي /run/post-history/trial.env، tmpfs).
# TRIAL_EXTRA_COMPOSE: ملف compose إضافي للاختبار المحلي فقط (مثل تخطي البناء على مضيف بلا شبكة في الحاويات).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
exec docker compose --project-name "${TRIAL_PROJECT:-post-history-trial}" \
  --env-file "$ROOT/infra/compose/.env.example" --env-file "${TRIAL_ENV_FILE:-/run/post-history/trial.env}" \
  -f "$ROOT/infra/compose/docker-compose.yml" \
  -f "$ROOT/infra/field-trial/docker-compose.trial.yml" ${TRIAL_EXTRA_COMPOSE:+-f "$TRIAL_EXTRA_COMPOSE"} \
  --profile api --profile media --profile ingest --profile edge --profile backup "$@"
