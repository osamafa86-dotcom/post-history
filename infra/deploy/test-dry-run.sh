#!/usr/bin/env bash
# فحص جاف لـ bootstrap.sh وupdate.sh داخل Ubuntu 24.04 بلا شبكة (CI، وظيفة compose). يثبت ترتيب الخطوات، وأن أوامر
# النظام مخطَّطة لا منفَّذة، وأذونات ما يُكتب، وأن الأسرار مختومة بـ age ولا تُطبع ولا تُعاد توليدها:
#   infra/deploy/test-dry-run.sh
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
if [ "${1:-}" != --inside ]; then
  docker build -q -t post-history-deploy-test "$HERE/test" >/dev/null
  exec docker run --rm --network none -v "$ROOT:/repo:ro" post-history-deploy-test bash /repo/infra/deploy/test-dry-run.sh --inside
fi

fail() { echo "!! $*" >&2; exit 1; }
B=/repo/infra/deploy/bootstrap.sh W=/tmp/w R=/tmp/r
mkdir -p "$W"
age-keygen -o "$W/owner.key" 2>/dev/null
OWNER="$(age-keygen -y "$W/owner.key")"
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 365 -subj /CN=backup \
  -keyout "$W/backup.key" -out "$W/backup.crt" 2>/dev/null
cat > "$W/host.env" <<HOST
MAIN_DOMAIN=app.example.org
INGEST_DOMAIN=up.example.net
MAIN_IP=192.0.2.10
INGEST_IP=198.51.100.20
ACME_EMAIL=ops@example.org
CLOUDFLARE_CIDRS=173.245.48.0/20 103.21.244.0/22
APP_ATTEST_APP_ID=ABCDE12345.org.example.field
HOST
boot() { bash "$B" --host-config "$1" --backup-cert "$2" --owner-age-recipient "$OWNER" --dry-run --root "$R"; }

# --- refusals before anything is written
sed '/^ACME_EMAIL=/d' "$W/host.env" > "$W/missing.env"
boot "$W/missing.env" "$W/backup.crt" >"$W/o" 2>&1 && fail "accepted a host config without ACME_EMAIL"
grep -q "ACME_EMAIL is empty" "$W/o" || fail "no reason for the missing key"
sed 's/^INGEST_IP=.*/INGEST_IP=192.0.2.10/' "$W/host.env" > "$W/same.env"
boot "$W/same.env" "$W/backup.crt" >"$W/o" 2>&1 && fail "accepted one address for both names"
cat "$W/backup.crt" "$W/backup.key" > "$W/withkey.crt"
boot "$W/host.env" "$W/withkey.crt" >"$W/o" 2>&1 && fail "accepted a certificate file holding the private key"
[ ! -e "$R" ] || fail "a refused run wrote files"
echo "refusals: ok"

# --- first run
boot "$W/host.env" "$W/backup.crt" >"$W/out" 2>&1 || { cat "$W/out"; fail "dry run failed"; }
steps="$(sed -n 's/^== step [0-9]*\/[0-9]*: //p' "$W/out" | tr '\n' ' ')"
[ "$steps" = "os packages user firewall dirs secrets images preflight start systemd verify " ] || fail "step order: $steps"
F="$W/out"
order() { a="$(grep -nF -- "$1" "$F" | head -1 | cut -d: -f1)"; b="$(grep -nF -- "$2" "$F" | head -1 | cut -d: -f1)"
          [ -n "$a" ] && [ -n "$b" ] && [ "$a" -lt "$b" ] || fail "expected '$1' before '$2'"; }
for want in "apt-get install -y -q --no-install-recommends" "docker-ce=5:29.9.1-1~ubuntu.24.04~noble" "+ apt-mark hold docker-ce" \
            "+ useradd --system" "+ ufw default deny incoming" "+ ufw allow proto tcp to 192.0.2.10 port 80,443" \
            "+ ufw allow proto tcp to 198.51.100.20 port 80,443" "+ chown 70:70 /srv/post-history/backups" \
            "infra/compose/check-pinned.sh" "infra/field-trial/preflight.sh" "trial.sh up -d --wait" \
            "+ systemctl enable post-history-trial.service" "preflight.sh --running --json"; do
  grep -qF -- "$want" "$W/out" || fail "planned command missing: $want"
done
order "== step 6/11: secrets" "unsealed:"
order "unsealed:" "infra/field-trial/preflight.sh"
order "+ /repo/infra/field-trial/preflight.sh" "trial.sh up -d --wait"
grep -q "^+ ufw allow proto tcp to .* port 22\|ufw allow 22" "$W/out" && fail "ssh opened by port instead of the OpenSSH profile"
echo "step order and planned commands: ok"

mode() { stat -c %a "$1"; }
E="$R/etc/post-history" U="$R/run/post-history/trial.env"
[ "$(mode "$E")" = 700 ] || fail "/etc/post-history mode $(mode "$E")"
[ "$(mode "$E/host.agekey")" = 400 ] || fail "host key mode $(mode "$E/host.agekey")"
[ "$(mode "$U")" = 400 ] || fail "unsealed secrets mode $(mode "$U")"
[ "$(mode "$R/srv/post-history/backups")" = 700 ] || fail "backup dir mode"
for f in "$E/trial.env.age" "$E/break-glass.age"; do
  [ $(( 0$(mode "$f") & 077 )) -eq 0 ] || fail "$f readable by group or others"
  [ "$(head -c 21 "$f")" = "age-encryption.org/v1" ] || fail "$f is not an age file"
  ! grep -qa "PASSWORD\|SECRET" "$f" || fail "$f holds plaintext"
done
[ -z "$(find "$R" -name 'trial.env' -not -path "$R/run/*")" ] || fail "plaintext secrets outside /run"
grep -q '"max-size": "50m"' "$R/etc/docker/daemon.json" || fail "container log rotation missing"
grep -q '^ExecStartPre=/repo/infra/deploy/unseal.sh$' "$R/etc/systemd/system/post-history-trial.service" || fail "unit does not unseal"
SD="$R/etc/systemd/system"
grep -q '^ExecStart=/repo/infra/observability/healthcheck.sh --json /run/post-history-health/health.json --alert$' \
  "$SD/post-history-health.service" || fail "health unit"
grep -q '^OnUnitActiveSec=1min$' "$SD/post-history-health.timer" || fail "health timer not every minute"
grep -q '^User=posthistory$' "$SD/post-history-health-endpoint.service" || fail "/health endpoint not run as the service user"
grep -q -- '--port 9180' "$SD/post-history-health-endpoint.service" || fail "/health endpoint port"
grep -q 'rotate 8' "$R/etc/logrotate.d/post-history" || fail "alert log rotation"
grep -q '^ALERT_EMAIL_TO=$' "$E/alert.conf" || fail "alert.conf template"
grep -qF "+ chown -R root:root /repo" "$W/out" || fail "repository tree not given to root"
grep -qF "+ chown -R posthistory" "$W/out" && fail "repository tree given to the service user (root runs it)"
grep -qF "+ systemctl enable --now post-history-health.timer post-history-health-endpoint.service" "$W/out" || fail "health units not enabled"
echo "permissions and sealing: ok"

# Every key of trial.env.example is set (optional ones aside); secrets are long; none is printed.
for k in $(sed -n 's/^\([A-Z0-9_]*\)=.*/\1/p' /repo/infra/field-trial/trial.env.example); do
  # Play Integrity: optional per platform (the owner gives App Attest, Play Integrity or both; preflight wants one).
  case "$k" in CADDY_GLOBAL_EXTRA|BACKUP_REMOTE_*|PLAY_INTEGRITY_*) continue ;; esac
  grep -q "^$k=." "$U" || fail "unsealed secrets lack $k"
done
for k in POSTGRES_PASSWORD REDIS_PASSWORD S3_SECRET_KEY TUSD_HOOK_SECRET JWT_SECRET MEDIA_WORKER_TOKEN \
         S3_MEDIA_SECRET_KEY S3_BACKUP_SECRET_KEY BACKUP_PG_PASSWORD; do
  v="$(sed -n "s/^$k=//p" "$U")"; [ "${#v}" -ge 32 ] || fail "$k shorter than 32"
done
while IFS='=' read -r k v; do
  [ "${#v}" -ge 16 ] || continue
  case "$k" in MAIN_*|INGEST_DOMAIN|INGEST_IP|ACME_EMAIL|CLOUDFLARE_CIDRS|TRUSTED_*|BACKUP_DIR|BACKUP_RECIPIENT_CERT) continue ;; esac
  grep -qF -- "$v" "$W/out" && fail "$k printed"
done < "$U"
age -d -i "$W/owner.key" "$E/trial.env.age" | cmp -s - "$U" || fail "the owner key does not open the sealed secrets"
token="$(age -d -i "$W/owner.key" "$E/break-glass.age")"
[ "$(printf '%s' "$token" | sha256sum | cut -c1-64)" = "$(sed -n 's/^BREAK_GLASS_TOKEN_SHA256=//p' "$U")" ] || fail "break-glass digest"
age -d -i "$E/host.agekey" "$E/break-glass.age" >/dev/null 2>&1 && fail "the host key opens the break-glass token"
pub="$(sed -n 's/^INGEST_TOKEN_PUBLIC_KEYS=k1://p' "$U")"
[ "$(sed -n 's/^INGEST_TOKEN_KEY_ID=//p' "$U")" = k1 ] || fail "signing kid is not the gate's kid"
[ "$(sed -n 's/^INGEST_REQUIRED=//p' "$U")" = true ] || fail "ingest is not required by default"
[ "$(sed -n 's/^APP_ATTEST_APP_ID=//p' "$U")" = ABCDE12345.org.example.field ] || fail "the App Attest app id from host.env is not carried"
printf '%s' "$pub" | base64 -d | openssl pkey -pubin -inform DER -noout 2>/dev/null || fail "ingest public key is not SPKI"
echo "secrets complete, unprinted, owner-recoverable: ok"

# --- second run: nothing regenerated
before="$(sha256sum < "$E/trial.env.age")"
boot "$W/host.env" "$W/backup.crt" >"$W/out2" 2>&1 || fail "second dry run failed"
[ "$(sha256sum < "$E/trial.env.age")" = "$before" ] || fail "secrets regenerated on the second run"
grep -q "not regenerated" "$W/out2" || fail "second run did not say it kept the secrets"
echo "idempotent: ok"

# --- update plan
git config --global --add safe.directory /repo
bash /repo/infra/deploy/update.sh --dry-run >"$W/up" 2>&1 || { cat "$W/up"; fail "update dry run failed"; }
F="$W/up"
order "+ /repo/infra/field-trial/trial.sh run --rm -T backup once" "fetch -q origin"
order "fetch -q origin" "trial.sh up -d --no-deps --wait postgres redis minio"
grep -q "runuser" "$F" && fail "update runs git as another user than root"
order "up -d --no-deps --wait tusd tusd-proxy ingest-gate" "up -d --no-deps --wait api"
grep -A1 -F "up -d --no-deps --wait api" "$F" | tail -1 | grep -qF "wait until: API /health 200" || fail "no health check right after the API restart"
order "up -d --no-deps --wait api" "up -d --no-deps --wait media-worker"
order "up -d --no-deps --wait caddy caddy-ingest" "preflight.sh --running"
echo "update plan: ok"
echo "deploy dry run: ok"
