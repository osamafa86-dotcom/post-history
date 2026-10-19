#!/usr/bin/env bash
# يفشل إن اختلف المخطط المستبطَن من القاعدة المُرحَّلة عن الملف الملتزم (ADR 0001، التبعات).
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
scripts/db-pull.sh "$tmp"
# ترتيب ما يخرجه drizzle-kit pull (العلاقات والقيود) يتبع ترتيب فهرس Postgres ويختلف بين قاعدتين؛
# المقارنة على الأسطر مرتبة: أي سطر مضاف أو محذوف أو متغير يُكتشف، وإعادة الترتيب وحدها لا تُعد اختلافًا.
status=0
for f in schema.ts relations.ts; do
  if ! diff -u <(LC_ALL=C sort "src/database/schema/$f") <(LC_ALL=C sort "$tmp/$f") > "$tmp/$f.diff"; then
    echo "--- $f" >&2; cat "$tmp/$f.diff" >&2; status=1
  fi
done
if [ "$status" -ne 0 ]; then
  echo "مخطط Drizzle الملتزم لا يطابق الترحيلات؛ شغّل: npm run db:pull" >&2
  exit 1
fi
echo "Drizzle schema matches migrations."
