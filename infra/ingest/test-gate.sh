#!/usr/bin/env bash
# بوابة ingest. (ADR 0011) من طرف إلى طرف: العميل ← TLS ← البوابة (رمز الرفع القصير) ← tusd-proxy ← tusd ← خطّاف الخادم.
# مفاتيح وشهادة اختبار تُولَّد هنا في مجلد مؤقت. التمييز بين رفض البوابة ورد tusd: tusd يضع Tus-Resumable دائمًا.
# E2E_EXTRA_COMPOSE: ملف compose إضافي اختياري (مثلًا لتخطي npm ci على مضيف بلا شبكة داخل الحاويات).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CDIR="$HERE/../compose"
KEYS="$(mktemp -d)"
OTHER="$(mktemp -d)"
trap 'rm -rf "$KEYS" "$OTHER"' EXIT
python3 "$HERE/test_token.py" keygen "$KEYS"
python3 "$HERE/test_token.py" keygen "$OTHER"   # a second key the gate does not trust

export INGEST_TOKEN_PUBLIC_KEY INGEST_TLS_DIR="$KEYS/tls" INGEST_PORT="${INGEST_PORT:-8443}"
INGEST_TOKEN_PUBLIC_KEY="$(cat "$KEYS/public.b64")"
COMPOSE=(docker compose -f "$CDIR/docker-compose.yml" -f "$HERE/compose.ingest.yml"
         ${E2E_EXTRA_COMPOSE:+-f "$E2E_EXTRA_COMPOSE"} --profile api)
# shellcheck disable=SC1091
set -a; . "$CDIR/.env"; set +a

fail() { echo "!! $*" >&2; "${COMPOSE[@]}" logs --tail 30 ingest-gate >&2 || true; exit 1; }

"${COMPOSE[@]}" up -d --wait

URL="https://ingest.localhost:${INGEST_PORT}"
SID="$(python3 -c 'import uuid; print(uuid.uuid4())')"
OTHER_SID="$(python3 -c 'import uuid; print(uuid.uuid4())')"
mint() { python3 "$HERE/test_token.py" mint "$KEYS" --sid "$SID" "$@"; }
b64() { printf '%s' "$1" | base64 | tr -d '\n'; }

# call METHOD PATH TOKEN [SESSION_IN_METADATA] -> "<status> <tus|gate>"
call() {
  local method="$1" path="$2" token="$3" meta_sid="${4:-$SID}" hdr
  hdr="$(mktemp)"
  local code verb=(-X "$method")
  [ "$method" != HEAD ] || verb=(-I)  # -X HEAD would wait for a body that never comes
  code="$(curl -sS --max-time 20 -o /dev/null -D "$hdr" -w '%{http_code}' --cacert "$KEYS/tls/tls.crt" \
    --resolve "ingest.localhost:${INGEST_PORT}:127.0.0.1" "${verb[@]}" "$URL$path" \
    -H 'Tus-Resumable: 1.0.0' -H 'Upload-Length: 10' -H 'Content-Type: application/offset+octet-stream' \
    -H "Upload-Metadata: upload_session_id $(b64 "$meta_sid"),filename $(b64 g.bin)" \
    -H "Authorization: Bearer $(openssl rand -hex 24)" ${token:+-H "Ingest-Token: $token"})"
  if grep -qi '^tus-resumable:' "$hdr"; then echo "$code tus"; else echo "$code gate"; fi
  rm -f "$hdr"
}
expect() { # expect "<status> <tus|gate>" description METHOD PATH TOKEN [META_SID]
  local want="$1" what="$2"; shift 2
  local got; got="$(call "$@")"
  printf '%-4s %-9s %s\n' "$([ "$got" = "$want" ] && echo ok || echo FAIL)" "$got" "$what"
  [ "$got" = "$want" ] || fails=$((fails + 1))
}
fails=0
GOOD="$(mint)"

expect "401 gate" "no token"                         POST /files/ ""
expect "401 gate" "garbage token"                    POST /files/ "a.b.c"
expect "401 gate" "signed by an untrusted key"       POST /files/ "$(python3 "$HERE/test_token.py" mint "$OTHER" --sid "$SID")"
expect "401 gate" "alg none"                         POST /files/ "$(mint --alg none)"
expect "401 gate" "expired"                          POST /files/ "$(mint --iat-offset -1200)"
expect "401 gate" "lifetime over 15 minutes"         POST /files/ "$(mint --ttl 3600)"
expect "401 gate" "issued in the future"             POST /files/ "$(mint --iat-offset 600)"
expect "401 gate" "wrong audience"                   POST /files/ "$(mint --aud api)"
expect "401 gate" "tampered claims"                  POST /files/ "$(python3 - "$GOOD" "$OTHER_SID" "$SID" <<'EOF'
import base64, sys
h, c, s = sys.argv[1].split(".")
pad = lambda x: x + "=" * (-len(x) % 4)
c2 = base64.urlsafe_b64decode(pad(c)).decode().replace(sys.argv[3], sys.argv[2])
print(f"{h}.{base64.urlsafe_b64encode(c2.encode()).rstrip(b'=').decode()}.{s}", end="")
EOF
)"
expect "403 gate" "valid token, other session (create)"  POST /files/ "$GOOD" "$OTHER_SID"
expect "403 gate" "valid token, other session (patch)"   PATCH "/files/$OTHER_SID" "$GOOD"
expect "403 tus"  "valid token -> tusd -> hook rejects the bogus upload token" POST /files/ "$GOOD"
expect "404 tus"  "valid token, HEAD own session -> tusd (no such upload)"     HEAD "/files/$SID" "$GOOD"
expect "404 gate" "anything outside /files/"         GET /metrics "$GOOD"

# Captured first: with pipefail, `logs | grep -q` can turn a match into a SIGPIPE failure and hide it.
gate_log="$("${COMPOSE[@]}" logs ingest-gate)"
if grep -qF "${GOOD%%.*}" <<<"$gate_log" || grep -qF "${GOOD##*.}" <<<"$gate_log"; then fail "ingest token in the gate log"; fi

[ "$fails" -eq 0 ] || fail "$fails unexpected result(s)"
echo "ingest gate: ok"
