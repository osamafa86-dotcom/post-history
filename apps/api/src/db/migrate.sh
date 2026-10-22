#!/usr/bin/env bash
# غلاف ترحيلات قاعدة البيانات (ADR 0001): ملفات SQL خام في migrations/ يشغّلها node-pg-migrate.
# الاستخدام:  apps/api/src/db/migrate.sh up | down [count] | create <name>
# يقرأ DATABASE_URL من البيئة (أو من infra/compose/.env محليًا عبر المتغيرات نفسها).
# node-pg-migrate من node_modules (اعتمادية مقفلة في package-lock.json بعد npm ci)، لا npx: لا جلب من سجل npm وقت التشغيل.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
DIR="apps/api/src/db/migrations"
cd "$ROOT"

if [ -z "${DATABASE_URL:-}" ]; then
  echo "DATABASE_URL غير مضبوط. مثال محلي: postgres://posthistory:<password>@localhost:5432/posthistory" >&2
  exit 2
fi

MIGRATE="$ROOT/apps/api/node_modules/.bin/node-pg-migrate"
[ -x "$MIGRATE" ] || { echo "node-pg-migrate missing: run npm ci in apps/api first" >&2; exit 2; }

action="${1:-up}"
shift || true
case "$action" in
  up|down|redo)
    exec "$MIGRATE" "$action" "$@" -m "$DIR" -t schema_migrations --check-order --verbose=false
    ;;
  create)
    exec "$MIGRATE" create "$@" -m "$DIR" -j sql --migration-filename-format utc
    ;;
  *)
    echo "unknown action: $action (up|down|redo|create)" >&2
    exit 2
    ;;
esac
