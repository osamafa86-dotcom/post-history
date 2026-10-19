#!/usr/bin/env bash
# فحص المخطط محليًا وفي CI: up → اختبار دخاني → down كامل (يجب أن يفرغ المخطط) → up → اختبار دخاني.
# يحتاج DATABASE_URL لقاعدة فارغة يمكن العبث بها (CI: خدمة postgres؛ محليًا: قاعدة اختبار مستقلة).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../../.." && pwd)"
DB="$ROOT/apps/api/src/db"
cd "$ROOT"

if [ -z "${DATABASE_URL:-}" ]; then
  echo "DATABASE_URL غير مضبوط" >&2
  exit 2
fi

count="$(ls "$DB"/migrations/*.sql | wc -l | tr -d ' ')"

echo "== migrate up"
"$DB/migrate.sh" up
echo "== smoke test"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -f "$DB/tests/smoke.sql"
echo "== migrate down ($count)"
"$DB/migrate.sh" down "$count"
leftover="$(psql "$DATABASE_URL" -Atc "SELECT string_agg(tablename, ',') FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'schema_migrations'")"
if [ -n "$leftover" ]; then
  echo "!! down migrations left tables behind: $leftover" >&2
  exit 1
fi
leftover_fn="$(psql "$DATABASE_URL" -Atc "SELECT string_agg(proname, ',') FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public'")"
if [ -n "$leftover_fn" ]; then
  echo "!! down migrations left functions behind: $leftover_fn" >&2
  exit 1
fi
echo "== migrate up again (re-entrancy)"
"$DB/migrate.sh" up
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -f "$DB/tests/smoke.sql"
echo "db check OK"
