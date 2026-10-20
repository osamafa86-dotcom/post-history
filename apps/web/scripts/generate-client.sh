#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
target="$(mktemp -d)"
trap 'rm -rf "$target"' EXIT
contract_root="${WEB_CONTRACT_ROOT:-../../contracts}"
./node_modules/.bin/openapi-typescript "$contract_root/openapi.yaml" -o "$target/schema.ts"
cat > "$target/client.ts" <<'TS'
// ملف مولّد بواسطة scripts/generate-client.sh؛ لا يُعدّل يدويًا.
import createClient, { type ClientOptions } from "openapi-fetch";
import type { paths } from "./schema";
export function createApiClient(options: ClientOptions) {
  return createClient<paths>(options);
}
TS
if [[ "${1:-}" == "--check" ]]; then
  diff -u src/generated/schema.ts "$target/schema.ts"
  diff -u src/generated/client.ts "$target/client.ts"
else
  mkdir -p src/generated
  cp "$target/schema.ts" "$target/client.ts" src/generated/
fi
