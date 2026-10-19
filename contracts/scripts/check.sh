#!/usr/bin/env bash
# فحص العقود: lint للـ OpenAPI، ترجمة كل مخطط JSON، ثم أمثلة صالحة وغير صالحة لكل مخطط.
# يعمل محليًا (node 22 + npx) وفي CI بالأمر نفسه: contracts/scripts/check.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

AJV=(npx -y -p ajv-cli@5.0.0 -p ajv-formats@2.1.1 ajv)
AJV_COMMON=(--spec=draft2020 -c ajv-formats --allow-union-types)
failures=0

echo "== redocly lint (warnings are errors)"
lint_out="$(npx -y @redocly/cli@2.65.0 lint --config contracts/redocly.yaml contracts/openapi.yaml 2>&1)" || { printf '%s\n' "$lint_out"; exit 1; }
printf '%s\n' "$lint_out" | tail -n 3
if printf '%s\n' "$lint_out" | grep -qE 'You have [0-9]+ warning'; then
  printf '%s\n' "$lint_out"
  echo "!! redocly warnings are not allowed (contracts/redocly.yaml)"
  exit 1
fi

for schema in contracts/schemas/*.json; do
  name="$(basename "$schema" .json)"
  echo "== $name: compile"
  "${AJV[@]}" compile "${AJV_COMMON[@]}" -s "$schema"

  valid_dir="contracts/examples/$name/valid"
  invalid_dir="contracts/examples/$name/invalid"
  if ! ls "$valid_dir"/*.json >/dev/null 2>&1 || ! ls "$invalid_dir"/*.json >/dev/null 2>&1; then
    echo "!! $name: يلزم مثال صالح واحد وغير صالح واحد على الأقل في contracts/examples/$name/{valid,invalid}/"
    failures=$((failures + 1))
    continue
  fi

  echo "== $name: valid examples"
  "${AJV[@]}" validate "${AJV_COMMON[@]}" -s "$schema" -d "$valid_dir/*.json" --errors=text

  echo "== $name: invalid examples (each must be rejected)"
  for f in "$invalid_dir"/*.json; do
    if out="$("${AJV[@]}" validate "${AJV_COMMON[@]}" -s "$schema" -d "$f" --errors=text 2>&1)"; then
      echo "!! $f: accepted by the schema but must be rejected"
      failures=$((failures + 1))
    else
      reason="$(printf '%s\n' "$out" | grep -v '^strict mode' | grep -A1 -m1 ' invalid$' | tail -n1 || true)"
      echo "ok (rejected): $f -- $reason"
    fi
  done
done

# نتائج القياس الموجودة في المستودع تُفحص بمخطط القياس
if ls docs/measurements/*/*.json >/dev/null 2>&1; then
  echo "== docs/measurements against measurement.json"
  "${AJV[@]}" validate "${AJV_COMMON[@]}" -s contracts/schemas/measurement.json -d "docs/measurements/*/*.json" --errors=text
fi

if [ "$failures" -ne 0 ]; then
  echo "contracts check FAILED ($failures)"
  exit 1
fi
echo "contracts check OK"
