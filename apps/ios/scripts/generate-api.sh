#!/usr/bin/env bash
# يولّد عميل Swift من contracts/openapi.yaml (لا نماذج يدوية). يُشغَّل بعد كل تغيير في العقد؛ CI يتحقق من أن الناتج مطابق.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="$HERE/../Packages/PostHistoryKit/Sources/PostHistoryAPI"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

npx -y @redocly/cli@2.65.0 bundle ios --config "$HERE/redocly.yaml" --ext json -o "$TMP/bundled.json"
node "$HERE/prepare-spec.mjs" "$TMP/bundled.json" "$TMP/spec.json"

# OPENAPI_GENERATOR_JAR: جرة openapi-generator 7.26.0 محلية (اختياري؛ الافتراضي تنزيلها عبر openapi-generator-cli بالإصدار المثبّت في openapitools.json).
if [ -n "${OPENAPI_GENERATOR_JAR:-}" ]; then
  GEN=(java -jar "$OPENAPI_GENERATOR_JAR")
else
  GEN=(npx -y @openapitools/openapi-generator-cli@2.41.0)
fi
(cd "$HERE" && "${GEN[@]}" generate \
  -i "$TMP/spec.json" -g swift6 -o "$TMP/gen" \
  --global-property apis,models,supportingFiles \
  --additional-properties=projectName=PostHistoryAPI,library=urlsession,responseAs=AsyncAwait,useSPMFileStructure=true,enumUnknownDefaultCase=true,hashableModels=true,identifiableModels=true,useBacktickEscapes=true)

rm -rf "$OUT"
mkdir -p "$OUT"
cp -R "$TMP/gen/Sources/PostHistoryAPI/." "$OUT/"
echo "generated into $OUT"
