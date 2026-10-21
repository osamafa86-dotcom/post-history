#!/usr/bin/env bash
# دخان بيئة التجربة كاملة (ADR 0013) على المضيف المحلي أو مشغّل CI: النطاقان على 127.0.0.1 و127.0.0.2 بشهادات
# سلطة Caddy المحلية (local_certs)، وأسرار عشوائية في ملف مؤقت بصلاحية 0400. يتحقق من:
#   1) الوكيل: الصحة والرفع على الرئيسي، 404 لـ /internal وغيره، التحويل من http، وعزل العنوانين (لا اسم على عنوان الآخر)،
#   2) بوابة ingest خلف الوكيل: 401 بلا رمز، ورفع كامل برمز صالح، ورفع كامل عبر الرئيسي (e2e-edge-upload.mjs)،
#   3) نسخة احتياطية مشفّرة ثم تمرين استعادة ناجح (infra/backup/restore-drill.sh)،
#   4) لا رمز ولا عنوان عميل في سجل الوكيل.
# يحتاج tools/acceptance (npm ci). KEEP=1 يبقي البيئة قائمة. TRIAL_EXTRA_COMPOSE للاختبار المحلي فقط.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORK="$(mktemp -d)"
export TRIAL_PROJECT="${TRIAL_PROJECT:-post-history-trial-ci}" TRIAL_ENV_FILE="$WORK/trial.env"
T="$ROOT/infra/field-trial/trial.sh"
cleanup() {
  [ "${KEEP:-0}" = 1 ] || "$T" down -v --remove-orphans >/dev/null 2>&1 || true
  # Backup files belong to uid 70 (the backup image): removed through a container, the caller may not own them.
  docker run --rm -v "$WORK:/w" postgres:16-alpine rm -rf /w/backups >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT
fail() { echo "!! $*" >&2; "$T" logs --tail 40 caddy caddy-ingest ingest-gate api backup >&2 || true; exit 1; }
hex() { openssl rand -hex "$1"; }

python3 "$ROOT/infra/ingest/test_token.py" keygen "$WORK/ingest" >/dev/null
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 2 -subj /CN=backup-drill \
  -keyout "$WORK/recipient.key" -out "$WORK/recipient.crt" 2>/dev/null
mkdir -p "$WORK/backups" && chmod 777 "$WORK/backups"   # uid 70 in the backup image writes here
cat > "$TRIAL_ENV_FILE" <<ENV
MAIN_DOMAIN=main.localhost
INGEST_DOMAIN=ingest.localhost
MAIN_IP=127.0.0.1
INGEST_IP=127.0.0.2
ACME_EMAIL=ci@example.invalid
CADDY_GLOBAL_EXTRA=local_certs
CLOUDFLARE_CIDRS=127.0.0.0/8
BACKUP_PG_PASSWORD=$(hex 32)
POSTGRES_PASSWORD=$(hex 16)
REDIS_PASSWORD=$(hex 16)
S3_SECRET_KEY=$(hex 16)
TUSD_HOOK_SECRET=$(hex 32)
JWT_SECRET=$(hex 32)
FIELD_ENCRYPTION_KEY=$(openssl rand -base64 32)
MEDIA_WORKER_TOKEN=$(hex 32)
S3_MEDIA_ACCESS_KEY=media-worker-ci
S3_MEDIA_SECRET_KEY=$(hex 16)
UPLOAD_VERIFIER=external
INGEST_TOKEN_PUBLIC_KEYS=k1:$(cat "$WORK/ingest/public.b64")
INGEST_TOKEN_SIGNING_KEY=$(openssl pkcs8 -topk8 -nocrypt -outform DER -in "$WORK/ingest/signing.pem" | base64 -w0)
INGEST_TOKEN_KEY_ID=k1
INGEST_PORT=8443
S3_BACKUP_ACCESS_KEY=backup-ci
S3_BACKUP_SECRET_KEY=$(hex 16)
BACKUP_DIR=$WORK/backups
BACKUP_RECIPIENT_CERT=$WORK/recipient.crt
ENV
chmod 400 "$TRIAL_ENV_FILE"
set -a; . "$ROOT/infra/compose/.env.example"; . "$TRIAL_ENV_FILE"; set +a

"$T" up -d --wait --build

# Two Caddy instances, two local CAs (separate certificate stores): trust both.
{ "$T" exec -T caddy cat /data/caddy/pki/authorities/local/root.crt
  "$T" exec -T caddy-ingest cat /data/caddy/pki/authorities/local/root.crt; } > "$WORK/ca.crt"
c() { curl -sS --max-time 20 --cacert "$WORK/ca.crt" --resolve "main.localhost:443:127.0.0.1" \
           --resolve "ingest.localhost:443:127.0.0.2" "$@"; }
code() { c -o /dev/null -w '%{http_code}' "$@" || echo 000; }
tus() { c -o /dev/null -D - -X OPTIONS https://main.localhost/files/ -H 'Tus-Resumable: 1.0.0' 2>/dev/null || true; }
for _ in $(seq 1 30); do grep -qi '^tus-resumable:' <<<"$(tus)" && break; sleep 2; done
grep -qi '^tus-resumable:' <<<"$(tus)" || fail "main /files/ does not reach tusd"
# /health is checked on the host, not published at the edge (its headers tell the rate limiter's state).
[ "$(curl -sS -o /dev/null -w '%{http_code}' "http://127.0.0.1:$API_PORT/health")" = 200 ] || fail "API /health on the host"
[ "$(code https://main.localhost/health)" = 404 ] || fail "/health is published at the edge"
# The edge routes /internal nowhere, whatever the token: a random one keeps the real secret out of the access log.
[ "$(code -X POST "https://main.localhost/internal/tusd-hooks/$(hex 32)")" = 404 ] || fail "/internal reachable through the edge"
[ "$(code https://main.localhost/)" = 404 ] || fail "main / should be 404"
[ "$(curl -sS -o /dev/null -w '%{http_code}' --resolve main.localhost:80:127.0.0.1 http://main.localhost/v1/x)" = 308 ] \
  || fail "http is not redirected to https"
[ "$(code -X POST https://ingest.localhost/files/ -H 'Tus-Resumable: 1.0.0' -H 'Upload-Length: 1')" = 401 ] \
  || fail "ingest without a token should be 401 at the gate"
[ "$(code https://ingest.localhost/v1/health)" = 404 ] || fail "ingest serves more than /files/"
# Address isolation: each name answers on its own address only (active probing does not link A and B).
if curl -sS --max-time 10 -o /dev/null --cacert "$WORK/ca.crt" --resolve ingest.localhost:443:127.0.0.1 https://ingest.localhost/files/ 2>/dev/null; then
  fail "the ingest name answers on the main address"; fi
if curl -sS --max-time 10 -o /dev/null --cacert "$WORK/ca.crt" --resolve main.localhost:443:127.0.0.2 https://main.localhost/health 2>/dev/null; then
  fail "the main name answers on the ingest address"; fi
echo "edge routing and address isolation: ok"

# Client address through the edge (Caddy trusts CF-Connecting-IP from CLOUDFLARE_CIDRS, the API trusts the default
# network gateway alone): ten failed logins for one email from address A fill that (email, address) bucket, so the
# eleventh from A is 429 while the same email from B is still 401. One shared bucket would make B 429 too.
login() { c -o /dev/null -w '%{http_code}' -X POST https://main.localhost/v1/auth/login -H 'Content-Type: application/json' \
            -H "CF-Connecting-IP: $1" -d "{\"email\":\"$email\",\"password\":\"wrong-password-$(hex 4)\"}"; }
email="edge-ip-$(hex 4)@example.com"
for _ in $(seq 1 10); do [ "$(login 198.51.100.1)" = 401 ] || fail "login through the edge should be 401"; done
[ "$(login 198.51.100.1)" = 429 ] || fail "11th failed login from one client address should be 429"
[ "$(login 198.51.100.2)" = 401 ] || fail "another client address shares the rate-limit bucket (client address lost at the edge)"
echo "client address through the edge: ok"

(cd "$ROOT/tools/acceptance" && [ -d node_modules ] || npm ci --no-audit --no-fund >/dev/null)
DATABASE_URL="postgres://$POSTGRES_USER:$POSTGRES_PASSWORD@127.0.0.1:$POSTGRES_PORT/$POSTGRES_DB" \
API_URL="http://127.0.0.1:$API_PORT/v1" CA_FILE="$WORK/ca.crt" INGEST_SIGNING_KEY="$WORK/ingest/signing.pem" \
  node "$ROOT/infra/field-trial/e2e-edge-upload.mjs" || fail "uploads through the edge"

"$T" run --rm -T backup once || fail "backup once"
[ -s "$WORK/backups/last-success.json" ] || fail "no last-success.json"
# The backup role reads and cannot write.
ro() { "$T" exec -T -e PGPASSWORD="$BACKUP_PG_PASSWORD" postgres psql -h 127.0.0.1 -U backup_reader -d "$POSTGRES_DB" -XAtq -c "$1"; }
[ "$(ro 'select count(*) >= 0 from public.users')" = t ] || fail "backup_reader cannot read"
if ro 'update public.users set email = email' >/dev/null 2>&1; then fail "backup_reader can update"; fi
if ro 'create table public.backup_probe (i int)' >/dev/null 2>&1; then fail "backup_reader can create tables"; fi
# Authenticated encryption: one changed byte in a backup file makes decryption fail.
obj="$(find "$WORK/backups/objects" -name '*.cms' -type f | head -1)"
python3 - "$obj" "$WORK/tampered.cms" <<'PY'
import sys
b = bytearray(open(sys.argv[1], "rb").read()); b[len(b) // 2] ^= 1
open(sys.argv[2], "wb").write(b)
PY
dec() { "$T" run --rm --no-deps -T --user "$(id -u):$(id -g)" -v "$WORK:/work" -v "$(dirname "$1"):/in:ro" --entrypoint sh backup \
          -c "openssl cms -decrypt -binary -inform DER -inkey /work/recipient.key -in /in/$(basename "$1") -out /dev/null" </dev/null; }
cms="$("$T" run --rm --no-deps -T -v "$(dirname "$obj"):/in:ro" --entrypoint sh backup -c \
  "openssl cms -cmsout -print -inform DER -in /in/$(basename "$obj")" </dev/null)"   # captured: pipefail + grep -q
grep -q authEnvelopedData <<<"$cms" || fail "backups are not AuthEnvelopedData (AES-GCM)"
dec "$obj" >/dev/null 2>&1 || fail "an untouched backup file does not decrypt"
if dec "$WORK/tampered.cms" >/dev/null 2>&1; then fail "a tampered backup file decrypts"; fi
echo "backup role read-only, backups authenticated: ok"
COMPOSE="$T" BACKUP_DIR="$WORK/backups" DRILL_ENV=local \
  "$ROOT/infra/backup/restore-drill.sh" --key "$WORK/recipient.key" --out "${DRILL_OUT:-$WORK/drill.json}" || fail "restore drill"

# Monitoring (infra/observability): every check passes, a stopped worker is a FAIL with one alert line, recovery is
# logged, the /health endpoint follows the result, the status board renders in Arabic.
H="$ROOT/infra/observability"
hc() { TRIAL_SH="$T" DISK_ALERT_PCT="${1:-99}" HEALTH_STATE_DIR="$WORK/hs" ALERT_LOG="$WORK/alerts.log" ALERT_CONF=/dev/null \
         "$H/healthcheck.sh" --json "$WORK/health/health.json" --alert; }
hc > "$WORK/hc1" || { cat "$WORK/hc1"; fail "healthcheck on a healthy stack"; }
python3 "$H/health-endpoint.py" --file "$WORK/health/health.json" --port 19180 & hp=$!
for _ in $(seq 1 20); do curl -s -o /dev/null http://127.0.0.1:19180/health && break; sleep 0.5; done
[ "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:19180/health)" = 200 ] || fail "/health endpoint not 200 when healthy"
"$T" stop media-worker >/dev/null 2>&1
if hc > "$WORK/hc2"; then fail "healthcheck passed with the media worker stopped"; fi
grep -q '^FAIL  container:media-worker' "$WORK/hc2" || fail "stopped worker not reported"
[ "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:19180/health)" = 503 ] || fail "/health endpoint not 503 on a failure"
if hc > /dev/null; then :; fi   # the same failure again: no second alert line
[ "$(grep -c 'FAIL container:media-worker' "$WORK/alerts.log")" = 1 ] || fail "alert not written exactly once"
if hc 1 > "$WORK/hc3"; then fail "disk threshold 1% did not fail"; fi
grep -q '^FAIL  disk:/' "$WORK/hc3" || fail "disk usage not reported"
"$T" start media-worker >/dev/null 2>&1
for _ in $(seq 1 30); do hc > "$WORK/hc4" && break; sleep 2; done
grep -q 'health: .* 0 failed' "$WORK/hc4" || { cat "$WORK/hc4"; fail "no recovery after restarting the worker"; }
grep -q 'RECOVERED' "$WORK/alerts.log" || fail "recovery not logged"
kill "$hp" 2>/dev/null || true
status="$(TRIAL_SH="$T" DISK_ALERT_PCT=99 "$H/status.sh")"   # runners sit near 85% disk || { echo "$status"; fail "status board reports a failure"; }
for want in "حالة بيئة التجربة" "■ الرفوعات" "■ طابور الوسائط" "■ النسخ الاحتياطي" "آخر نسخة ناجحة"; do
  grep -qF "$want" <<<"$status" || fail "status board lacks: $want"
done
echo "monitoring and status board: ok"

# Revealing data never reaches a log: a canary in headers, query strings, tus metadata and a login body, then every
# container's log is searched for it.
CANARY="canary$(hex 6)"
b64() { printf '%s' "$1" | base64 -w0; }
c -o /dev/null "https://main.localhost/v1/materials?lat=$CANARY&device_id=$CANARY" -H "X-Device-Id: $CANARY" \
  -H "Authorization: Bearer $CANARY" || true
c -o /dev/null -X POST https://main.localhost/files/ -H 'Tus-Resumable: 1.0.0' -H 'Upload-Length: 10' \
  -H "Upload-Metadata: filename $(b64 "$CANARY.mp4"),location $(b64 "$CANARY"),device_id $(b64 "$CANARY")" || true
c -o /dev/null -X POST https://ingest.localhost/files/ -H 'Tus-Resumable: 1.0.0' -H 'Upload-Length: 10' \
  -H "Authorization: Bearer $CANARY" -H "Upload-Metadata: location $(b64 "$CANARY")" || true
c -o /dev/null -X POST https://main.localhost/v1/auth/login -H 'Content-Type: application/json' \
  -d "{\"email\":\"$CANARY@example.com\",\"password\":\"$CANARY-password\"}" || true
sleep 2
all_logs="$("$T" logs --no-color 2>&1)"
if grep -qF "$CANARY" <<<"$all_logs"; then
  grep -F "$CANARY" <<<"$all_logs" | cut -c1-200 >&2; fail "the canary reached a log"
fi
grep -qF '"uri":"/v1/materials-"' <<<"$all_logs" || fail "the canary request was not logged at the edge (test has no teeth)"
echo "no planted value in any log: ok"

# Optional (TRIAL_ACCEPTANCE=1): the field-trial acceptance pack against this stack through the edge, as on the host.
if [ "${TRIAL_ACCEPTANCE:-0}" = 1 ]; then
  (cd "$ROOT/tools/acceptance" && [ -d node_modules ] || npm ci --no-audit --no-fund >/dev/null)
  export DATABASE_URL="postgres://$POSTGRES_USER:$POSTGRES_PASSWORD@127.0.0.1:$POSTGRES_PORT/$POSTGRES_DB"
  FT_ACCOUNTS="$(API_URL="http://127.0.0.1:$API_PORT/v1" node "$ROOT/tools/acceptance/field-trial/rehearsal-accounts.mjs")"
  FT_ACCOUNTS="$FT_ACCOUNTS" FT_TUS_URL="https://main.localhost/files/" NODE_EXTRA_CA_CERTS="$WORK/ca.crt" \
    node "$ROOT/tools/acceptance/run.mjs" --target https://main.localhost --confirm --out-dir="${ACCEPTANCE_OUT:-$WORK/pack}" \
    || fail "acceptance pack through the edge"
  echo "acceptance pack through the edge: ok"
fi

# Captured first: with pipefail, `logs | grep -q` can turn a match into a SIGPIPE failure and hide it.
edge_log="$("$T" logs caddy caddy-ingest ingest-gate tusd-proxy)"
if grep -qF "$TUSD_HOOK_SECRET" <<<"$edge_log"; then fail "hook secret in an edge log"; fi
if grep -qE '"(remote_ip|client_ip)"' <<<"$edge_log"; then
  grep -E '"(remote_ip|client_ip)"' <<<"$edge_log" | head -3 | cut -c1-300 >&2; fail "client address in the edge log"; fi
# أسماء الترويسات مفاتيحَ JSON (أو قيمة Bearer)، لا المسار: /v1/uploads/{id}/ingest-token مسار API مشروع (SEC-07)
if grep -qiE '"(ingest-token|authorization)"[[:space:]]*:|bearer [A-Za-z0-9._-]{8}' <<<"$edge_log"; then fail "request headers in the edge log"; fi
# Upload ids are bearer capabilities (SEC-06): logged as /files/-, never /files/<id>.
if grep -qE '/files/[A-Za-z0-9]' <<<"$edge_log"; then fail "an upload id in an edge log"; fi
grep -qF '/files/-' <<<"$edge_log" || fail "no redacted upload path in the edge log (nothing logged?)"
echo "field trial smoke: ok"
