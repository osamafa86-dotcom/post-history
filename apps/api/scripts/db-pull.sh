#!/usr/bin/env bash
# يستبطن مخطط Drizzle من قاعدة مُرحَّلة (ADR 0001) إلى OUT (افتراضيًا src/database/schema).
# يُبقي schema.ts وrelations.ts فقط، ثم يطبّق تصحيحات scripts/fix-drizzle-schema.js.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
OUT="${1:-src/database/schema}"
: "${DATABASE_URL:?DATABASE_URL غير مضبوط}"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
DRIZZLE_OUT="$tmp" npx drizzle-kit pull --config drizzle.config.ts > /dev/null

mkdir -p "$OUT"
cp "$tmp/schema.ts" "$tmp/relations.ts" "$OUT/"
node scripts/fix-drizzle-schema.js "$OUT/schema.ts"
