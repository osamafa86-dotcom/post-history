#!/usr/bin/env bash
# الخادم والبوابة معًا (ADR 0011، SEC-07 البند 5): مفتاح توقيع اختباري يُولَّد هنا ولا يُخزَّن. الخادم يوقّع به بـ
# kid "ci-new"، والبوابة تحمل عامّه وعامّ مفتاح «قديم» (ci-old) معًا كما في التدوير. الخادم في ATTESTATION_MODE=test
# (حكم Play Integrity غير موقّع؛ يرفضه الخادم في الإنتاج). ثم e2e-attested-upload.mjs.
# يحتاج .env compose وtools/acceptance (npm ci). E2E_EXTRA_COMPOSE: ملف compose إضافي اختياري.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CDIR="$HERE/../compose"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
# .env first: the attestation settings below must win over its empty placeholders.
# shellcheck disable=SC1091
set -a; . "$CDIR/.env"; set +a
python3 "$HERE/test_token.py" keygen "$WORK/new" --names ingest.localhost >/dev/null
python3 "$HERE/test_token.py" keygen "$WORK/old" --names ingest.localhost >/dev/null

export INGEST_PORT="${INGEST_PORT:-8443}" INGEST_TLS_DIR="$WORK/new/tls"
export INGEST_TOKEN_PUBLIC_KEYS="ci-old:$(cat "$WORK/old/public.b64"),ci-new:$(cat "$WORK/new/public.b64")"
export ATTESTATION_MODE=test PLAY_INTEGRITY_PACKAGE_NAME=org.posthistory.reporter
export PLAY_INTEGRITY_CERT_SHA256="$(openssl rand 32 | base64 | tr '+/' '-_' | tr -d '=')"
export INGEST_TOKEN_SIGNING_KEY="$(cat "$WORK/new/signing.pkcs8.b64")" INGEST_TOKEN_KEY_ID=ci-new
export INGEST_REQUIRED=true INGEST_TUS_ENDPOINT="https://ingest.localhost:${INGEST_PORT}/files/"
# The gate asks the API for each session's state (SEC-01) with this secret, from 172.30.250.3 on hooks.
export INGEST_SESSION_CHECK=on INGEST_GATE_TOKEN="$(openssl rand -hex 32)"
COMPOSE=(docker compose -f "$CDIR/docker-compose.yml" -f "$HERE/compose.ingest.yml"
         ${E2E_EXTRA_COMPOSE:+-f "$E2E_EXTRA_COMPOSE"} --profile api)

fail() { echo "!! $*" >&2; "${COMPOSE[@]}" logs --tail 40 api ingest-gate tusd-proxy >&2 || true; exit 1; }

"${COMPOSE[@]}" up -d --wait   # recreates the API with the attestation settings above

DATABASE_URL="postgres://$POSTGRES_USER:$POSTGRES_PASSWORD@127.0.0.1:$POSTGRES_PORT/$POSTGRES_DB" \
API_URL="http://127.0.0.1:$API_PORT/v1" INGEST_URL="$INGEST_TUS_ENDPOINT" INGEST_CA="$WORK/new/tls/tls.crt" \
PLAY_PACKAGE="$PLAY_INTEGRITY_PACKAGE_NAME" PLAY_CERT="$PLAY_INTEGRITY_CERT_SHA256" EXPECT_KID=ci-new \
  node "$HERE/e2e-attested-upload.mjs" || fail "server + gate"

# Captured first: with pipefail, `logs | grep -q` can turn a match into a SIGPIPE failure and hide it.
logs="$("${COMPOSE[@]}" logs api ingest-gate tusd-proxy tusd)"
if grep -qF "$INGEST_TOKEN_SIGNING_KEY" <<<"$logs"; then fail "signing key in a log"; fi
if grep -qF "$INGEST_GATE_TOKEN" <<<"$logs"; then fail "the gate secret in a log"; fi
if grep -qE 'eyJ[A-Za-z0-9_-]{20,}\.eyJ' <<<"$logs"; then fail "a JWT in a log"; fi
echo "attested upload e2e: ok"
