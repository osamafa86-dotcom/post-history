#!/usr/bin/env bash
# compose المراقبة (ADR 0027) وتتبّع الأخطاء (ADR 0029) على مضيف التجربة، بأسرار التجربة المفكوكة نفسها
# (GRAFANA_ADMIN_PASSWORD وGLITCHTIP_* يولّدها bootstrap.sh). مشروعان مستقلان عن التجربة، فتوقفهما لا يمس الخدمة:
#   infra/observability/stack.sh monitoring up -d --wait      infra/observability/stack.sh errors ps
# TRIAL_ENV_FILE: ملف الأسرار المفكوك (الافتراضي /run/post-history/trial.env، tmpfs).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
which="${1:-}"; shift || true
case "$which" in
  monitoring|errors) ;;
  *) echo "usage: $0 monitoring|errors <docker compose args>" >&2; exit 2 ;;
esac
exec docker compose -f "$HERE/compose.$which.yml" --env-file "${TRIAL_ENV_FILE:-/run/post-history/trial.env}" "$@"
