#!/usr/bin/env bash
# دخان بيئة التجربة كاملة (ADR 0013) على المضيف المحلي أو مشغّل CI: النطاقان على 127.0.0.1 و127.0.0.2 بشهادات
# سلطة Caddy المحلية (local_certs)، وأسرار عشوائية في ملف مؤقت بصلاحية 0400. يتحقق من:
#   1) الوكيل: الصحة والرفع على الرئيسي، 404 لـ /internal وغيره، التحويل من http، وعزل العنوانين (لا اسم على عنوان الآخر)،
#   2) بوابة ingest أمام النطاقين: 401 بلا رمز على كليهما، ورفع كامل برمز صالح عبر كل منهما (e2e-edge-upload.mjs)،
#   3) نسخة احتياطية مشفّرة ثم تمرين استعادة ناجح (infra/backup/restore-drill.sh)،
#   4) لا رمز ولا عنوان عميل في سجل الوكيل،
#   5) نافذة مفتاح qa- (ADR 0022): لحساب القبول وحده، وتُرفض بعد انتهائها، والإغلاق لا يترك أثرًا.
# يحتاج tools/acceptance (npm ci). KEEP=1 يبقي البيئة قائمة. TRIAL_EXTRA_COMPOSE للاختبار المحلي فقط.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORK="$(mktemp -d)"
export TRIAL_PROJECT="${TRIAL_PROJECT:-post-history-trial-ci}" TRIAL_ENV_FILE="$WORK/trial.env"
# The second provider (object lock, write-only key): a stand-in MinIO in the same project (infra/backup/test).
export TRIAL_EXTRA_COMPOSE="${TRIAL_EXTRA_COMPOSE:+$TRIAL_EXTRA_COMPOSE:}$ROOT/infra/backup/test/compose.remote-lock.yml"
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
# WAL-G (ADR 0051): a throwaway PGP pair for the drill. The public half goes to the host side; the private half stays in
# $WORK and is handed to pitr-drill.sh alone, as the owner would bring it.
GNUPGHOME="$(mktemp -d /tmp/g.XXXXXX)" && export GNUPGHOME
gpg --batch --pinentry-mode loopback --passphrase '' --quick-gen-key 'walg-drill <walg-drill@example.invalid>' rsa3072 encrypt never 2>/dev/null
gpg --armor --export walg-drill@example.invalid > "$WORK/walg-public.asc"
gpg --armor --batch --pinentry-mode loopback --passphrase '' --export-secret-keys walg-drill@example.invalid > "$WORK/walg-private.asc"
chmod 644 "$WORK/walg-public.asc"; chmod 600 "$WORK/walg-private.asc"
gpgconf --kill gpg-agent 2>/dev/null || true; rm -rf "$GNUPGHOME"; unset GNUPGHOME
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
INGEST_GATE_TOKEN=$(hex 32)
# ATTESTATION_MODE=production (التجربة) يشترط معرّف تطبيق؛ معرّف اختبار هنا، والرموز يوقّعها الدخان مباشرة.
APP_ATTEST_APP_ID=ABCDE12345.org.example.trialci
INGEST_PORT=8443
S3_BACKUP_ACCESS_KEY=backup-ci
WALG_ARCHIVE_MODE=on
WALG_S3_PREFIX=s3://wal/pg
WALG_S3_ENDPOINT=http://backup-remote:9000
WALG_ACCESS_KEY=wal-writer-ci
WALG_SECRET_KEY=$(hex 16)
WALG_PG_PASSWORD=$(hex 32)
WALG_PUBLIC_KEY=$WORK/walg-public.asc
S3_BACKUP_SECRET_KEY=$(hex 16)
BACKUP_DIR=$WORK/backups
BACKUP_RECIPIENT_CERT=$WORK/recipient.crt
BACKUP_REMOTE_URL=http://backup-remote:9000
BACKUP_REMOTE_BUCKET=offsite
BACKUP_REMOTE_ACCESS_KEY=offsite-writer
BACKUP_REMOTE_SECRET_KEY=$(hex 16)
BACKUP_REMOTE_ROOT_USER=offsite-admin
BACKUP_REMOTE_ROOT_PASSWORD=$(hex 16)
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
[ "$(code -X POST https://main.localhost/files/ -H 'Tus-Resumable: 1.0.0' -H 'Upload-Length: 1')" = 401 ] \
  || fail "main /files/ without a token should be 401 at the gate (both domains behind it)"
[ "$(code https://ingest.localhost/v1/health)" = 404 ] || fail "ingest serves more than /files/"
# From the gate's own address (172.30.250.3, inside INTERNAL_ALLOWED_CIDRS) only /internal/ingest/ answers: the media
# worker's and tusd's internal paths are 403 there (INTERNAL_SOURCE_PATHS). The session check itself is proven by the uploads below.
from_gate() { "$T" exec -T ingest-gate wget -q -S -O /dev/null "http://api-hooks:3000$1" 2>&1 | awk '/HTTP\//{print $2; exit}'; }
[ "$(from_gate "/internal/media/sessions/$(python3 -c 'import uuid; print(uuid.uuid4())')")" = 403 ] \
  || fail "the gate's address reaches /internal/media/ (INTERNAL_SOURCE_PATHS not applied)"
[ "$(from_gate "/internal/tusd-hooks/$(hex 32)")" = 403 ] || fail "the gate's address reaches the tusd hook path"
echo "the gate's address reaches /internal/ingest/ alone: ok"
# Buyer delivery stays off in the trial until a full sandbox purchase passes; audio alignment is on.
wenv="$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$("$T" ps -q media-worker)")"
grep -qx 'MEDIA_ENABLE_DELIVERY=false' <<<"$wenv" || fail "the media worker runs with delivery not pinned off"
grep -qx 'MEDIA_ENABLE_ALIGNMENT=true' <<<"$wenv" || fail "the media worker runs without audio alignment"
echo "media worker: delivery off, alignment on: ok"
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

# The gate's rate limit counts per client on both domains (20 r/s, burst 40, then 429 before any token check): a burst from
# one client is cut while another client is still served, and a client cannot pick its bucket with X-Forwarded-For (each
# request of a burst forging a different address still lands in its own bucket). ingest: the peer address (curl
# --interface); main: CF-Connecting-IP from the trusted Cloudflare ranges, as for login above.
gate_burst() { # gate_burst <count> <curl args...> -> number of 429s; {} in an argument is the request's index
  local n="$1"; shift
  seq "$n" | xargs -P 30 -I{} curl -sS --max-time 20 -o /dev/null -w '%{http_code}\n' --cacert "$WORK/ca.crt" \
    --resolve "main.localhost:443:127.0.0.1" --resolve "ingest.localhost:443:127.0.0.2" \
    -X POST -H 'Tus-Resumable: 1.0.0' -H 'Upload-Length: 1' "$@" 2>/dev/null | grep -c '^429$' || true
}
one() { curl -sS --max-time 20 -o /dev/null -w '%{http_code}' --cacert "$WORK/ca.crt" --resolve "main.localhost:443:127.0.0.1" \
          --resolve "ingest.localhost:443:127.0.0.2" -X POST -H 'Tus-Resumable: 1.0.0' -H 'Upload-Length: 1' "$@" || echo 000; }
[ "$(gate_burst 120 --interface 127.0.0.5 https://ingest.localhost/files/)" -gt 0 ] || fail "ingest: a burst from one client is not limited at the gate"
[ "$(one --interface 127.0.0.6 https://ingest.localhost/files/)" = 401 ] || fail "ingest: another client shares the limited client's bucket"
sleep 3
[ "$(gate_burst 120 --interface 127.0.0.7 -H 'X-Forwarded-For: 10.66.0.{}' https://ingest.localhost/files/)" -gt 0 ] \
  || fail "ingest: a forged X-Forwarded-For moves the client to another rate-limit bucket"
[ "$(gate_burst 120 -H 'CF-Connecting-IP: 198.51.100.21' https://main.localhost/files/)" -gt 0 ] || fail "main /files/: a burst from one client is not limited at the gate"
[ "$(one -H 'CF-Connecting-IP: 198.51.100.22' https://main.localhost/files/)" = 401 ] || fail "main /files/: another client shares the limited client's bucket"
sleep 3
[ "$(gate_burst 120 -H 'CF-Connecting-IP: 198.51.100.23' -H 'X-Forwarded-For: 10.67.0.{}' https://main.localhost/files/)" -gt 0 ] \
  || fail "main /files/: a forged X-Forwarded-For moves the client to another rate-limit bucket"
echo "gate rate limit per client on both domains, not chosen by X-Forwarded-For: ok"

(cd "$ROOT/tools/acceptance" && [ -d node_modules ] || npm ci --no-audit --no-fund >/dev/null)
DATABASE_URL="postgres://$POSTGRES_USER:$POSTGRES_PASSWORD@127.0.0.1:$POSTGRES_PORT/$POSTGRES_DB" \
API_URL="http://127.0.0.1:$API_PORT/v1" CA_FILE="$WORK/ca.crt" INGEST_SIGNING_KEY="$WORK/ingest/signing.pem" \
  node "$ROOT/infra/field-trial/e2e-edge-upload.mjs" || fail "uploads through the edge"

# BACKUP_MEASURE_MIB=N: N MiB of incompressible synthetic objects (64 MiB each, like the originals) go into the uploads
# bucket first, and the backup is timed, full then incremental; the result (with both restore drills) is written to
# BACKUP_MEASURE_OUT with the measurement schema. Synthetic data only: no real file leaves the host.
if [ -n "${BACKUP_MEASURE_MIB:-}" ]; then
  n=$(( (BACKUP_MEASURE_MIB + 63) / 64 ))
  "$T" exec -T -e "MC_HOST_l=http://$S3_ACCESS_KEY:$S3_SECRET_KEY@127.0.0.1:9000" minio sh -c \
    "for i in \$(seq 1 $n); do head -c 67108864 /dev/urandom | mc pipe --quiet l/$S3_BUCKET_UPLOADS/measure/\$i.bin >/dev/null || exit 1; done" \
    || fail "seeding synthetic objects"
  m_started="$(date -u +%FT%TZ)"
fi
tb0=$(date +%s.%N)
"$T" run --rm -T backup once || fail "backup once"
tb1=$(date +%s.%N)
[ -s "$WORK/backups/last-success.json" ] || fail "no last-success.json"
if [ -n "${BACKUP_MEASURE_MIB:-}" ]; then
  sleep 1   # a new dump name (seconds resolution)
  ti0=$(date +%s.%N); "$T" run --rm -T backup once >/dev/null || fail "incremental backup"; ti1=$(date +%s.%N)
fi
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

# The second provider: the copy is there under compliance retention, the backup's key can write but neither read nor
# delete, the provider's own administrator cannot purge a locked version either, and a restore drill from a copy pulled
# back from it passes (#149 item e).
grep -q '"remote":true' "$WORK/backups/last-success.json" || fail "the backup did not reach the second provider"
rmc() { "$T" exec -T -e "MC_HOST_$1=http://$2:$3@127.0.0.1:9000" backup-remote mc "${@:4}"; }
W_() { rmc w "$BACKUP_REMOTE_ACCESS_KEY" "$BACKUP_REMOTE_SECRET_KEY" "$@"; }
A_() { rmc a "$BACKUP_REMOTE_ROOT_USER" "$BACKUP_REMOTE_ROOT_PASSWORD" "$@"; }
rdump="$(A_ ls --recursive a/offsite/pg/ | awk '/\.dump\.cms$/ {print $NF}' | tail -1)"
[ -n "$rdump" ] || fail "no dump at the second provider"
A_ retention info "a/offsite/pg/$rdump" | grep -q COMPLIANCE || fail "the remote dump is not under compliance retention"
if W_ rm "w/offsite/pg/$rdump" >/dev/null 2>&1; then fail "the backup key can delete at the second provider"; fi
if W_ cat "w/offsite/pg/$rdump" >/dev/null 2>&1; then fail "the backup key can read at the second provider"; fi
A_ rm --recursive --versions --force a/offsite/pg/ >/dev/null 2>&1 || true
A_ cat "a/offsite/pg/$rdump" | cmp -s - "$WORK/backups/pg/$rdump" || fail "a locked version was purged by the provider's administrator"
mkdir -p "$WORK/offsite" && chmod 777 "$WORK/offsite"
tp0=$(date +%s.%N)
docker run --rm --network "${TRIAL_PROJECT}_default" -u "$(id -u):$(id -g)" -v "$WORK/offsite:/out" \
  -e "MC_HOST_a=http://$BACKUP_REMOTE_ROOT_USER:$BACKUP_REMOTE_ROOT_PASSWORD@backup-remote:9000" -e MC_CONFIG_DIR=/tmp/.mc \
  pgsty/mc:RELEASE.2026-10-18T00-00-00Z@sha256:6ecdaec70bc5e8cf9d0e9a70c190f3beb1c83f11617ff4333f1fcd71ab1daf18 \
  mirror --quiet a/offsite /out >/dev/null || fail "pulling the copy back from the second provider"
tp1=$(date +%s.%N)
COMPOSE="$T" BACKUP_DIR="$WORK/offsite" DRILL_ENV=local DRILL_SOURCE=second-provider \
  "$ROOT/infra/backup/restore-drill.sh" --key "$WORK/recipient.key" --out "${DRILL_REMOTE_OUT:-$WORK/drill-remote.json}" \
  || fail "restore drill from the second provider's copy"
echo "second provider: locked, write-only key, undeletable, restore drill from its copy: ok"
if [ -n "${BACKUP_MEASURE_MIB:-}" ]; then
  du_b() { "$T" run --rm --no-deps -T -v "$1:/d:ro" --entrypoint sh backup -c 'du -sb /d | cut -f1' </dev/null; }
  python3 - "${BACKUP_MEASURE_OUT:-$WORK/backup-measure.json}" "$m_started" "$BACKUP_MEASURE_MIB" "$n" \
    "$tb0" "$tb1" "$ti0" "$ti1" "$tp0" "$tp1" "$(du_b "$WORK/backups/objects")" "$WORK/backups/last-success.json" \
    "${DRILL_OUT:-$WORK/drill.json}" "${DRILL_REMOTE_OUT:-$WORK/drill-remote.json}" "${BACKUP_MEASURE_ENV:-local docker compose}" <<'PY'
import json, sys, datetime
out, started, mib, n, tb0, tb1, ti0, ti1, tp0, tp1, obj_bytes, last, drill, drill_remote, env = sys.argv[1:]
last, d, r = (json.load(open(f)) for f in (last, drill, drill_remote))
s = lambda a, b: round(float(b) - float(a), 2)
m = {
  "seeded_mib": int(mib), "seeded_objects": int(n),
  "backup_full_s": s(tb0, tb1), "backup_incremental_s": s(ti0, ti1),
  "backup_full_mib_per_s": round(int(n) * 64 / max(s(tb0, tb1), 0.01), 1),
  "objects_encrypted_bytes": int(obj_bytes), "pg_dump_bytes_encrypted": last["pg_dump_bytes"],
  "objects_total": last["objects_total"], "second_provider_copy": bool(last["remote"]),
  "second_provider_pull_s": s(tp0, tp1),
  "restore_decrypt_s": d["metrics"]["decrypt_s"], "restore_pg_s": d["metrics"]["pg_restore_s"],
  "restore_from_second_provider_passed": r["metrics"]["drill_passed"], "restore_local_passed": d["metrics"]["drill_passed"],
  "backup_interval_h": 24,
}
ok = m["restore_local_passed"] and m["restore_from_second_provider_passed"] and m["second_provider_copy"]
json.dump({
  "schema_version": 1, "tool": "other", "role": "infra", "test_name": "recovery",
  "started_at": started, "ended_at": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
  "result": "partial" if ok else "fail",
  "device": {"platform": "server", "model": env},
  "metrics": m,
  "notes": ("Trial backup at size (infra/field-trial/smoke-trial.sh with BACKUP_MEASURE_MIB): synthetic incompressible objects "
            "in the uploads bucket, encrypted per object (CMS AES-256-GCM) and mirrored to a stand-in second provider under "
            "compliance object lock, then restore drills from the local copy and from the copy pulled back from the second "
            "provider. Partial: synthetic data on this machine, not the trial host; the daily interval means up to 24 h of "
            "loss against the plan's 15 minutes (continuous WAL archiving is not built); the object restore time is the pull "
            "back plus decryption of the sample, not a full re-upload into a new MinIO."),
}, open(out, "w"), ensure_ascii=False, indent=2)
open(out, "a").write("\n")
print("backup measurement:", out)
PY
fi

# Continuous WAL archiving (ADR 0051): the base backup is at the second provider; a commit after the target time is
# archived (its segment pushed, timed); the writer key can neither read nor delete there; the public key on the host
# decrypts nothing; no private key is in any container; and a point-in-time restore with the offline private key
# returns the state at the target time exactly.
for _ in $(seq 1 120); do "$T" logs walg-base 2>/dev/null | grep -q 'wal-g base backup ok' && break; sleep 2; done
"$T" logs walg-base 2>/dev/null | grep -q 'wal-g base backup ok' || fail "no wal-g base backup"
psql_() { "$T" exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -XAtq -v ON_ERROR_STOP=1 -c "$1"; }
psql_ "create table public.walg_drill (tag text, at timestamptz default clock_timestamp()); insert into public.walg_drill (tag) values ('before')" >/dev/null
sleep 1; target="$(psql_ 'select now()')"; sleep 1
seg="$(psql_ "insert into public.walg_drill (tag) values ('after'); select pg_walfile_name(pg_current_wal_lsn())" | tail -1)"
ta0=$(date +%s.%N); psql_ 'select pg_switch_wal()' >/dev/null
for _ in $(seq 1 120); do [ "$(psql_ "select coalesce(last_archived_wal, '') >= '$seg' from pg_stat_archiver")" = t ] && break; sleep 0.5; done
ta1=$(date +%s.%N)
[ "$(psql_ "select coalesce(last_archived_wal, '') >= '$seg' from pg_stat_archiver")" = t ] || fail "the WAL segment was not archived"
# Early attempts may fail while the stand-in provider's bucket is still being created: none after the last success.
[ "$(psql_ "select last_failed_time is null or last_failed_time < last_archived_time from pg_stat_archiver")" = t ] \
  || fail "wal-g archiving failed after its last success"
walobj="$(A_ ls --recursive a/wal/pg/wal_005/ | awk '/\.lz4$/ {print $NF}' | head -1)"
[ -n "$walobj" ] || fail "no WAL at the second provider"
A_ retention info "a/wal/pg/wal_005/$walobj" | grep -q COMPLIANCE || fail "the archived WAL is not under compliance retention"
rmc w "$WALG_ACCESS_KEY" "$WALG_SECRET_KEY" cat "w/wal/pg/wal_005/$walobj" >/dev/null 2>&1 && fail "the wal-g key can read at the second provider"
rmc w "$WALG_ACCESS_KEY" "$WALG_SECRET_KEY" rm "w/wal/pg/wal_005/$walobj" >/dev/null 2>&1 && fail "the wal-g key can delete at the second provider"
GNUPGHOME="$(mktemp -d /tmp/g.XXXXXX)"; export GNUPGHOME; gpg --batch --import "$WORK/walg-public.asc" 2>/dev/null
A_ cat "a/wal/pg/wal_005/$walobj" > "$WORK/wal.pgp"
pk="$(gpg --batch --list-packets "$WORK/wal.pgp" 2>/dev/null || true)"   # captured: gpg exits non-zero without the secret key
grep -q '^:pubkey enc packet' <<<"$pk" || fail "the archived WAL is not encrypted to the public key"
gpg --batch --decrypt "$WORK/wal.pgp" >/dev/null 2>&1 && fail "the public key alone decrypts the archive"
gpgconf --kill gpg-agent 2>/dev/null || true; rm -rf "$GNUPGHOME"; unset GNUPGHOME
for c in $("$T" ps -q); do
  docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$c" | grep -q 'PRIVATE KEY' && fail "a private key in the environment of $(docker inspect -f '{{.Name}}' "$c")"
  for src in $(docker inspect -f '{{range .Mounts}}{{if eq .Type "bind"}}{{println .Source}}{{end}}{{end}}' "$c"); do
    [ -f "$src" ] && grep -q 'PRIVATE KEY' "$src" && fail "a private key mounted into $(docker inspect -f '{{.Name}}' "$c") ($src)"
  done
done
PITR_IMAGE="$(docker inspect -f "{{.Config.Image}}" "$("$T" ps -q postgres)")" PITR_NETWORK="${TRIAL_PROJECT}_default" PITR_ENV="${BACKUP_MEASURE_ENV:-local docker compose}" \
WALG_S3_PREFIX="$WALG_S3_PREFIX" AWS_ENDPOINT="$WALG_S3_ENDPOINT" CHECK_DB="$POSTGRES_DB" PITR_DB_USER="$POSTGRES_USER" \
AWS_ACCESS_KEY_ID="$BACKUP_REMOTE_ROOT_USER" AWS_SECRET_ACCESS_KEY="$BACKUP_REMOTE_ROOT_PASSWORD" \
  "$ROOT/infra/backup/pitr-drill.sh" --key "$WORK/walg-private.asc" --target "$target" --out "${PITR_OUT:-$WORK/pitr.json}" \
  --check "select string_agg(tag, '|' order by at) from public.walg_drill" --expect before || fail "point-in-time restore drill"
python3 - "${PITR_OUT:-$WORK/pitr.json}" "$ta0" "$ta1" <<'PY'
import json, sys
p, a0, a1 = sys.argv[1:]
d = json.load(open(p)); d["metrics"]["wal_push_after_switch_s"] = round(float(a1) - float(a0), 2); d["metrics"]["archive_timeout_s"] = 300
json.dump(d, open(p, "w"), indent=2); open(p, "a").write("\n")
PY
psql_ 'drop table public.walg_drill' >/dev/null
echo "wal-g: archived, locked, write-only key, public key decrypts nothing, no private key in the stack, point-in-time restore: ok"

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

# The qa key window (ADR 0022), as an operator runs it: qa-window.sh opens a fresh qa- key for the acceptance account
# (looked up by email), the gate refuses that key for another reporter's session (key_class=qa), refuses it once
# expired (and the health check alerts), and close leaves neither the key nor the account behind.
qa_state="$(DATABASE_URL="postgres://$POSTGRES_USER:$POSTGRES_PASSWORD@127.0.0.1:$POSTGRES_PORT/$POSTGRES_DB" \
  API_URL="http://127.0.0.1:$API_PORT/v1" node "$ROOT/infra/field-trial/e2e-qa-key.mjs" seed)" || fail "qa window: seed"
qa_email="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["acceptance_email"])' <<<"$qa_state")"
QW() { TRIAL_SH="$T" QA_WINDOW_DIR="$WORK/qa" "$ROOT/infra/field-trial/qa-window.sh" "$@"; }
QW open --email "$qa_email" --hours 1 > "$WORK/qa-open" || { cat "$WORK/qa-open"; fail "qa-window.sh open"; }
qa_kid="$(sed -n 's/.*FT_INGEST_KID=\(qa-[A-Za-z0-9-]*\).*/\1/p' "$WORK/qa-open")"
[ -n "$qa_kid" ] && [ "$(stat -c %a "$WORK/qa/qa-signing.pem")" = 600 ] || fail "qa window: no qa- kid or the key file is not 0600"
if QW open --email "$qa_email" --hours 1 >/dev/null 2>&1; then fail "qa window: a second open replaced the key"; fi
# The tester's copy (as copied off the host): it must stop working at the expiry and after close, not only disappear.
cp "$WORK/qa/qa-signing.pem" "$WORK/qa-copy.pem"
qcheck() { QA_STATE="$qa_state" QA_KID="$qa_kid" QA_SIGNING_KEY="$WORK/qa-copy.pem" CA_FILE="$WORK/ca.crt" \
             INGEST_SIGNING_KEY="$WORK/ingest/signing.pem" node "$ROOT/infra/field-trial/e2e-qa-key.mjs" check "$1"; }
qcheck open || fail "qa window open"
sed -i "s/^INGEST_QA_KEY_EXPIRES=.*/INGEST_QA_KEY_EXPIRES=$(date -u -d '-1 minute' +%FT%TZ)/" "$TRIAL_ENV_FILE"
"$T" up -d --wait --no-deps --force-recreate ingest-gate >/dev/null 2>&1 || fail "qa window: gate restart"
qcheck expired || fail "qa window expired"
if hc > "$WORK/hc5"; then fail "healthcheck passed with an expired qa window"; fi
grep -q '^FAIL  qa-key:window' "$WORK/hc5" || fail "expired qa window not reported by the health check"
QW close > /dev/null || fail "qa-window.sh close"
qcheck closed || fail "qa window closed"
if grep -qE '^(INGEST_QA_|ACCEPTANCE_UPLOADER_USER_ID)' "$TRIAL_ENV_FILE" || [ -e "$WORK/qa/qa-signing.pem" ]; then
  fail "qa window: close left the slot, the account or the key behind"; fi
[ "$(stat -c %a "$TRIAL_ENV_FILE")" = 400 ] || fail "qa window: the secrets file mode changed"
echo "qa key window (fresh key, acceptance account only, expiry, close): ok"

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
  # Uploads carry an ingest token (the gate is in front of both domains); the smoke's signing key mints them here.
  FT_ACCOUNTS="$FT_ACCOUNTS" FT_TUS_URL="https://ingest.localhost/files/" FT_INGEST_SIGNING_KEY="$WORK/ingest/signing.pem" \
  FT_RESOLVE="ingest.localhost=127.0.0.2,main.localhost=127.0.0.1" NODE_EXTRA_CA_CERTS="$WORK/ca.crt" \
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

# The availability drill (tools/acceptance availability, ADR 0028), last because it kills the API and Postgres: under read
# load the API is killed, then Postgres, then the API recreated, and each recovery is timed. A CI runner is not the trial
# host and no target is declared here, so the result is partial; it fails if anything does not recover. TRIAL_AVAILABILITY=0 skips.
if [ "${TRIAL_AVAILABILITY:-1}" = 1 ]; then
  accounts="$(DATABASE_URL="postgres://$POSTGRES_USER:$POSTGRES_PASSWORD@127.0.0.1:$POSTGRES_PORT/$POSTGRES_DB" \
    API_URL="http://127.0.0.1:$API_PORT/v1" node "$ROOT/tools/acceptance/field-trial/rehearsal-accounts.mjs")"
  token_of() { python3 -c 'import json,sys; a=json.loads(sys.argv[1])[sys.argv[2]]; print(json.dumps({"email":a["email"],"password":a["password"]}))' "$accounts" "$1" \
    | curl -fsS -X POST "http://127.0.0.1:$API_PORT/v1/auth/login" -H 'Content-Type: application/json' -d @- \
    | python3 -c 'import json,sys; print(json.load(sys.stdin)["access_token"])'; }
  # A crash, not an operator's stop: the drill SIGKILLs the container's process from the host (#233), so the restart policy
  # applies; that needs root here, or passwordless sudo on the CI runner.
  [ "$(id -u)" = 0 ] && kill_prefix="" || kill_prefix="sudo -n"
  AVAIL_API_URL="http://127.0.0.1:$API_PORT/v1" AVAIL_TOKEN="$(token_of reporter)" AVAIL_SUPERVISOR_TOKEN="$(token_of supervisor)" \
  AVAIL_COMPOSE="$T" AVAIL_KILL_PREFIX="$kill_prefix" AVAIL_TIMEOUT_MS="${AVAIL_TIMEOUT_MS:-300000}" \
    node "$ROOT/tools/acceptance/scripts/availability.mjs" --dry-run || fail "availability drill: a scenario did not recover"
  echo "availability drill (api kill, database kill, api recreate under load): ok"
fi
echo "field trial smoke: ok"
