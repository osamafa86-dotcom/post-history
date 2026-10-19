#!/usr/bin/env bash
# يفشل إن اختلف المخطط المستبطَن من القاعدة المُرحَّلة عن الملف الملتزم (ADR 0001، التبعات).
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
scripts/db-pull.sh "$tmp"
if ! diff -u src/database/schema "$tmp"; then
  echo "مخطط Drizzle الملتزم لا يطابق الترحيلات؛ شغّل: npm run db:pull" >&2
  exit 1
fi
echo "Drizzle schema matches migrations."
