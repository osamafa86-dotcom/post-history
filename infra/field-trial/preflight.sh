#!/usr/bin/env bash
# فحص جاهزية مضيف التجربة الميدانية (ADR 0013)، يُشغَّل على المضيف بصلاحية root قبل التجربة وبعد كل تغيير فيه:
#   sudo infra/field-trial/preflight.sh                 # قبل التشغيل: المضيف والشبكة والأسرار والنسخ
#   sudo infra/field-trial/preflight.sh --running       # وبعد التشغيل: الوكيلان والصحة وآخر نسخة
#   ... --json docs/measurements/ops/$(date +%F)-field-trial-preflight.json
#   sudo infra/field-trial/preflight.sh --qa-window     # أثناء نافذة مفتاح الاختبار qa- (ADR 0022، qa-window.sh) وحدها
# لا يطبع قيمة سرية أبدًا: يفحص وجود المفاتيح وأطوالها فقط. ولا يكتب النطاقين وعنوانيهما في stdout ولا في الـ JSON:
# تُستبدل بأسمائها الرمزية (MAIN_DOMAIN، INGEST_IP…) لأن النتيجة تُرفع إلى المستودع (ADR 0011). الحدود الدنيا من docs/ops/field-trial-hosting.md،
# وتُغيَّر بالبيئة (MIN_CPUS MIN_RAM_GB MIN_DATA_FREE_GB MIN_BACKUP_FREE_GB).
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="${TRIAL_ENV_FILE:-/run/post-history/trial.env}"
RUNNING=0 JSON="" QA_WINDOW=0
while [ $# -gt 0 ]; do
  case "$1" in
    --running) RUNNING=1; shift ;;
    --qa-window) QA_WINDOW=1; shift ;;
    --json) JSON="$2"; shift 2 ;;
    *) echo "usage: $0 [--running] [--qa-window] [--json FILE]" >&2; exit 2 ;;
  esac
done
MIN_CPUS="${MIN_CPUS:-4}" MIN_RAM_GB="${MIN_RAM_GB:-16}"
MIN_DATA_FREE_GB="${MIN_DATA_FREE_GB:-500}" MIN_BACKUP_FREE_GB="${MIN_BACKUP_FREE_GB:-500}"
QA_WINDOW_MAX_HOURS="${QA_WINDOW_MAX_HOURS:-72}"

pass=0 fail=0 warn=0 results=()
mask() {
  local s="$1" k v
  for k in INGEST_DOMAIN MAIN_DOMAIN INGEST_IP MAIN_IP; do v="${!k:-}"; [ -n "$v" ] && s="${s//"$v"/$k}"; done
  printf '%s' "$s"
}
ok()   { local m; m="$(mask "$1")"; pass=$((pass + 1)); results+=("ok|$m"); printf 'ok    %s\n' "$m"; }
bad()  { local m; m="$(mask "$1")"; fail=$((fail + 1)); results+=("FAIL|$m"); printf 'FAIL  %s\n' "$m"; }
note() { local m; m="$(mask "$1")"; warn=$((warn + 1)); results+=("warn|$m"); printf 'warn  %s\n' "$m"; }
check() { if eval "$2" >/dev/null 2>&1; then ok "$1"; else bad "$1"; fi; }
ver_ge() { [ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -1)" = "$2" ]; }
started_at="$(date -u +%FT%TZ)"

# --- المضيف
[ "$(id -u)" = 0 ] && ok "running as root" || bad "running as root (needed to read the tmpfs secrets file)"
dv="$(docker version -f '{{.Server.Version}}' 2>/dev/null || echo 0)"
ver_ge "$dv" 24.0 && ok "docker engine $dv >= 24.0" || bad "docker engine $dv >= 24.0"
cv="$(docker compose version --short 2>/dev/null || echo 0)"
ver_ge "${cv#v}" 2.24 && ok "docker compose $cv >= 2.24 (multiple --env-file, !override, !reset)" || bad "docker compose $cv >= 2.24"
cpus="$(nproc)"; [ "$cpus" -ge "$MIN_CPUS" ] && ok "cpus $cpus >= $MIN_CPUS" || bad "cpus $cpus >= $MIN_CPUS"
ram_gb=$(( $(awk '/MemTotal/ {print $2}' /proc/meminfo) / 1024 / 1024 ))
[ "$ram_gb" -ge $((MIN_RAM_GB - 1)) ] && ok "ram ${ram_gb} GiB >= $MIN_RAM_GB (1 GiB kernel reserve allowed)" || bad "ram ${ram_gb} GiB >= $MIN_RAM_GB"
droot="$(docker info -f '{{.DockerRootDir}}' 2>/dev/null || echo /var/lib/docker)"
dfree=$(( $(df -Pk "$droot" | awk 'NR==2 {print $4}') / 1024 / 1024 ))
[ "$dfree" -ge "$MIN_DATA_FREE_GB" ] && ok "free on $droot ${dfree} GiB >= $MIN_DATA_FREE_GB" || bad "free on $droot ${dfree} GiB >= $MIN_DATA_FREE_GB"
if command -v timedatectl >/dev/null; then
  [ "$(timedatectl show -p NTPSynchronized --value 2>/dev/null)" = yes ] && ok "clock synchronised (NTP)" || bad "clock synchronised (NTP): tokens and TLS depend on it"
else note "timedatectl missing: check NTP by hand"; fi

# --- ملف الأسرار (SEC-05): tmpfs، root، 0400/0600، المفاتيح موجودة وغير فارغة، بلا قيم مؤقتة
if [ -f "$ENV_FILE" ]; then
  fs="$(stat -f -c %T "$ENV_FILE")"; mode="$(stat -c %a "$ENV_FILE")"; owner="$(stat -c %U "$ENV_FILE")"
  [ "$fs" = tmpfs ] && ok "secrets file on tmpfs" || bad "secrets file on tmpfs (found $fs): never on persistent disk"
  case "$mode" in 400|600) ok "secrets file mode $mode" ;; *) bad "secrets file mode $mode (want 400 or 600)" ;; esac
  [ "$owner" = root ] && ok "secrets file owned by root" || bad "secrets file owned by root (found $owner)"
  val() { sed -n "s/^$1=//p" "$ENV_FILE" | tail -1; }
  for k in MAIN_DOMAIN INGEST_DOMAIN MAIN_IP INGEST_IP ACME_EMAIL POSTGRES_PASSWORD REDIS_PASSWORD S3_SECRET_KEY \
           TUSD_HOOK_SECRET JWT_SECRET FIELD_ENCRYPTION_KEY MEDIA_WORKER_TOKEN S3_MEDIA_ACCESS_KEY S3_MEDIA_SECRET_KEY \
           INGEST_TOKEN_PUBLIC_KEYS INGEST_TOKEN_SIGNING_KEY INGEST_TOKEN_KEY_ID INGEST_GATE_TOKEN BACKUP_PG_PASSWORD S3_BACKUP_ACCESS_KEY S3_BACKUP_SECRET_KEY BACKUP_DIR BACKUP_RECIPIENT_CERT \
           CLOUDFLARE_CIDRS; do
    [ -n "$(val "$k")" ] && ok "secret set: $k" || bad "secret set: $k"
  done
  for k in POSTGRES_PASSWORD REDIS_PASSWORD S3_SECRET_KEY TUSD_HOOK_SECRET JWT_SECRET MEDIA_WORKER_TOKEN INGEST_GATE_TOKEN S3_BACKUP_SECRET_KEY BACKUP_PG_PASSWORD; do
    v="$(val "$k")"
    [ "${#v}" -ge 32 ] && ok "secret length >= 32: $k" || bad "secret length >= 32: $k"
    case "$v" in *change-me*|*example*) bad "placeholder value: $k" ;; esac
  done
  # ingest مطلوب ما لم يُطفأ بقرار مكتوب، ومعه معرّف تطبيق واحد على الأقل وإلا لا يحصل جهاز على رمز.
  case "$(val INGEST_REQUIRED)" in
    ""|true) ok "INGEST_REQUIRED on (uploads only through the ingest gate)"
             [ -n "$(val APP_ATTEST_APP_ID)$(val PLAY_INTEGRITY_PACKAGE_NAME)" ] && ok "device attestation configured (App Attest or Play Integrity)" \
               || bad "device attestation configured: APP_ATTEST_APP_ID or PLAY_INTEGRITY_PACKAGE_NAME (no device can get an ingest token)" ;;
    *) bad "INGEST_REQUIRED is off: needs a written decision (ADR 0011) before the trial" ;;
  esac
  grep -q '^INGEST_SESSION_CHECK=' "$ENV_FILE" && bad "INGEST_SESSION_CHECK must not be set on the host (the gate always checks the session)" \
    || ok "session check not overridable from the secrets"
  # خانة مفتاح الاختبار (ADR 0022): لا معرّف qa- في مفاتيح الإنتاج أبدًا، والخانة وحساب القبول فارغان في الإنتاج. مع
  # --qa-window: الثلاثة معًا، ومعرّف qa-، وانتهاء لم يمر ولا يتجاوز QA_WINDOW_MAX_HOURS من الآن.
  grep -qE '(^|,)[[:space:]]*qa-' <<<"$(val INGEST_TOKEN_PUBLIC_KEYS)" \
    && bad "INGEST_TOKEN_PUBLIC_KEYS holds a qa- key (the gate ignores it there; qa keys go in the qa slot alone)" \
    || ok "no qa- key among the production verification keys"
  case "$(val INGEST_TOKEN_KEY_ID)" in qa-*) bad "INGEST_TOKEN_KEY_ID is a qa- kid: the API must sign with a production key" ;;
                                       *) ok "the API signs with a production kid" ;; esac
  qk="$(val INGEST_QA_PUBLIC_KEY)" qe="$(val INGEST_QA_KEY_EXPIRES)" qu="$(val ACCEPTANCE_UPLOADER_USER_ID)"
  if [ -z "$qk$qe$qu" ]; then
    [ "$QA_WINDOW" = 0 ] && ok "no qa key slot and no acceptance account (production)" || bad "--qa-window given but no qa window is open"
  elif [ "$QA_WINDOW" = 0 ]; then
    bad "qa key slot or ACCEPTANCE_UPLOADER_USER_ID set: production must not carry them (qa-window.sh close; --qa-window during a window)"
  else
    [ -n "$qk" ] && [ -n "$qe" ] && [ -n "$qu" ] && ok "qa window: key, expiry and acceptance account all set" \
      || bad "qa window: INGEST_QA_PUBLIC_KEY, INGEST_QA_KEY_EXPIRES and ACCEPTANCE_UPLOADER_USER_ID go together"
    [[ "$qk" == qa-*:* ]] && ok "qa window: the slot's kid starts with qa-" || bad "qa window: the slot's kid must start with qa-"
    qexp="$(date -u -d "$qe" +%s 2>/dev/null || echo 0)" now="$(date +%s)"
    [ "$qexp" -gt "$now" ] && ok "qa window: key not expired ($qe)" || bad "qa window: key expired or unreadable ($qe): run qa-window.sh close"
    [ "$qexp" -le $((now + QA_WINDOW_MAX_HOURS * 3600)) ] && ok "qa window: expiry within $QA_WINDOW_MAX_HOURS hours" \
      || bad "qa window: expiry more than $QA_WINDOW_MAX_HOURS hours away"
  fi
  tp="$(val TRUSTED_PROXY_CIDRS)"
  case "${tp:-172.30.240.1/32}" in
    172.30.240.1/32) ok "TRUSTED_PROXY_CIDRS is the default network gateway alone" ;;
    *) bad "TRUSTED_PROXY_CIDRS must be 172.30.240.1/32 alone (a wider range lets any container forge the client address)" ;;
  esac
  [ "$(val UPLOAD_VERIFIER)" = external ] && ok "UPLOAD_VERIFIER=external (media worker verifies)" || bad "UPLOAD_VERIFIER=external"
  [ -z "$(val CADDY_GLOBAL_EXTRA)" ] && ok "no test-only Caddy option (local_certs)" || bad "CADDY_GLOBAL_EXTRA must be empty on the trial host"
  # حزمة التسليم ثابتة مطفأة في docker-compose.trial.yml حتى يمر شراء sandbox كاملًا: لا تُفتح من ملف الأسرار.
  grep -q '^MEDIA_ENABLE_DELIVERY=' "$ENV_FILE" && bad "MEDIA_ENABLE_DELIVERY must not be set in the secrets (delivery stays off in the trial)" \
    || ok "buyer delivery not switchable from the secrets"
  MAIN_DOMAIN="$(val MAIN_DOMAIN)" INGEST_DOMAIN="$(val INGEST_DOMAIN)" MAIN_IP="$(val MAIN_IP)" INGEST_IP="$(val INGEST_IP)"
  BACKUP_DIR="$(val BACKUP_DIR)" BACKUP_RECIPIENT_CERT="$(val BACKUP_RECIPIENT_CERT)"
  # أرشفة WAL (ADR 0051): مقبول إطفاؤها في التجربة (فقد حتى 24 ساعة، قرار المنسّق)، وشرط قبل المرحلة التجارية.
  grep -q 'PRIVATE KEY' "$ENV_FILE" && bad "a private key in the secrets file (restore keys stay offline, ADR 0051)" \
    || ok "no private key in the secrets file"
  WALG_ARCHIVE_MODE="$(val WALG_ARCHIVE_MODE)" WALG_PUBLIC_KEY="$(val WALG_PUBLIC_KEY)"
  if [ "$WALG_ARCHIVE_MODE" = on ]; then
    for k in WALG_S3_PREFIX WALG_S3_ENDPOINT WALG_ACCESS_KEY WALG_SECRET_KEY WALG_PG_PASSWORD WALG_PUBLIC_KEY; do
      [ -n "$(val "$k")" ] && ok "wal-g set: $k" || bad "wal-g set: $k (WALG_ARCHIVE_MODE=on)"
    done
    if [ -f "$WALG_PUBLIC_KEY" ] && grep -q 'BEGIN PGP PUBLIC KEY BLOCK' "$WALG_PUBLIC_KEY" && ! grep -q 'PRIVATE KEY' "$WALG_PUBLIC_KEY"; then
      ok "wal-g public key present, public only"; else bad "wal-g public key $WALG_PUBLIC_KEY: a PGP public key, nothing private"; fi
    [ -z "$(grep -l 'PRIVATE KEY' "$(dirname "${WALG_PUBLIC_KEY:-/nonexistent/x}")"/* 2>/dev/null)" ] \
      && ok "no private key next to the wal-g public key" || bad "a private key sits next to the wal-g public key: the restore key stays with the owner"
  else
    note "WAL archiving off (WALG_ARCHIVE_MODE): up to 24 h of loss; required before the commercial phase (ADR 0051)"
  fi
else
  bad "secrets file $ENV_FILE exists (decrypt the SOPS file to tmpfs first)"
  MAIN_DOMAIN="" INGEST_DOMAIN="" MAIN_IP="" INGEST_IP="" BACKUP_DIR="" BACKUP_RECIPIENT_CERT=""
fi

# --- العنوانان والنطاقان (ADR 0011): عنوانان عامان مختلفان على المضيف، وingest يُحل إلى عنوانه وحده
addrs="$(hostname -I 2>/dev/null) "
if [ -n "$MAIN_IP" ] && [ -n "$INGEST_IP" ]; then
  [ "$MAIN_IP" != "$INGEST_IP" ] && ok "two distinct addresses" || bad "two distinct addresses (main and ingest share $MAIN_IP)"
  case "$addrs" in *"$MAIN_IP "*) ok "MAIN_IP assigned on this host" ;; *) bad "MAIN_IP $MAIN_IP assigned on this host" ;; esac
  case "$addrs" in *"$INGEST_IP "*) ok "INGEST_IP assigned on this host" ;; *) bad "INGEST_IP $INGEST_IP assigned on this host" ;; esac
fi
if [ -n "$INGEST_DOMAIN" ]; then
  ing="$(getent ahostsv4 "$INGEST_DOMAIN" | awk '{print $1}' | sort -u | tr '\n' ' ')"
  [ "$ing" = "$INGEST_IP " ] && ok "$INGEST_DOMAIN resolves to INGEST_IP only" || bad "$INGEST_DOMAIN resolves to INGEST_IP only (got: ${ing:-nothing})"
fi
if [ -n "$MAIN_DOMAIN" ]; then
  mn="$(getent ahostsv4 "$MAIN_DOMAIN" | awk '{print $1}' | sort -u | tr '\n' ' ')"
  if [ -z "$mn" ]; then bad "$MAIN_DOMAIN resolves"; else
    ok "$MAIN_DOMAIN resolves"
    case "$mn" in *"$INGEST_IP "*) bad "$MAIN_DOMAIN must not resolve to INGEST_IP" ;; esac
    case "$mn" in *"$MAIN_IP "*) note "$MAIN_DOMAIN resolves to the origin address: Cloudflare proxy (orange cloud) is off" ;;
                  *) ok "$MAIN_DOMAIN resolves away from the origin (proxied)" ;; esac
  fi
fi

# --- المنافذ: 80/443 على العنوانين للوكيلين وحدهما، ولا خدمة أخرى على عنوان عام سوى ssh
listening="$(ss -Hltn 2>/dev/null | awk '{print $4}')"
if [ "$RUNNING" = 0 ]; then
  for ip in $MAIN_IP $INGEST_IP; do for p in 80 443; do
    grep -qE "^($ip|0\.0\.0\.0|\*|\[::\]):$p$" <<<"$listening" && bad "port $ip:$p is free before start" || ok "port $ip:$p is free before start"
  done; done
fi
public="$(grep -vE '^(127\.|\[::1\]|\[::ffff:127\.)' <<<"$listening" | grep -vE ':(22|80|443)$' || true)"
[ -z "$public" ] && ok "nothing but ssh/80/443 listening on public addresses" || bad "unexpected public listeners: $(tr '\n' ' ' <<<"$public")"
check "outbound https to Let's Encrypt (ACME)" "curl -sS --max-time 10 -o /dev/null https://acme-v02.api.letsencrypt.org/directory"

# --- النسخ الاحتياطي (ADR 0013)
if [ -n "$BACKUP_DIR" ]; then
  [ -d "$BACKUP_DIR" ] && ok "backup dir exists" || bad "backup dir $BACKUP_DIR exists"
  if [ -d "$BACKUP_DIR" ]; then
    [ "$(stat -c %u "$BACKUP_DIR")" = 70 ] && ok "backup dir owned by uid 70 (backup image)" || bad "backup dir owned by uid 70 (chown 70:70 $BACKUP_DIR)"
    bfree=$(( $(df -Pk "$BACKUP_DIR" | awk 'NR==2 {print $4}') / 1024 / 1024 ))
    [ "$bfree" -ge "$MIN_BACKUP_FREE_GB" ] && ok "free on backup dir ${bfree} GiB >= $MIN_BACKUP_FREE_GB" || bad "free on backup dir ${bfree} GiB >= $MIN_BACKUP_FREE_GB"
    [ "$(df -P "$BACKUP_DIR" | awk 'NR==2 {print $1}')" != "$(df -P "$droot" | awk 'NR==2 {print $1}')" ] \
      && ok "backup dir on a different device than Docker data" || bad "backup dir on a different device than Docker data"
  fi
fi
if [ -n "$BACKUP_RECIPIENT_CERT" ]; then
  if openssl x509 -in "$BACKUP_RECIPIENT_CERT" -noout -checkend $((60 * 86400)) >/dev/null 2>&1; then
    ok "backup recipient certificate valid for 60+ days"; else bad "backup recipient certificate valid for 60+ days"; fi
  [ -z "$(ls "$(dirname "$BACKUP_RECIPIENT_CERT")"/*.key 2>/dev/null)" ] && ok "no private key next to the recipient certificate" \
    || bad "a private key sits next to the recipient certificate: the backup key must stay offline"
fi

# root ينفّذ هذه السكربتات (عند الإقلاع ومن المؤقّت)، فلا يكتبها غيره.
for f in infra/deploy/unseal.sh infra/deploy/update.sh infra/field-trial/trial.sh infra/observability/healthcheck.sh; do
  [ -e "$ROOT/$f" ] || continue
  if [ "$(stat -c %u "$ROOT/$f")" = 0 ] && [ -z "$(find "$ROOT/$f" -perm /022)" ]; then ok "$f owned by root, not writable by others"
  else bad "$f must be owned by root and not group/other writable (root runs it)"; fi
done

# --- بعد التشغيل
if [ "$RUNNING" = 1 ]; then
  api_port="$(sed -n 's/^API_PORT=//p' "$ROOT/infra/compose/.env.example" | tail -1)"
  check "API /health is 200 on the host (127.0.0.1)" "[ \"\$(curl -sS --max-time 15 -o /dev/null -w '%{http_code}' http://127.0.0.1:$api_port/health)\" = 200 ]"
  check "/health is not published at the edge (404)" "[ \"\$(curl -sS --max-time 15 -o /dev/null -w '%{http_code}' https://$MAIN_DOMAIN/health)\" = 404 ]"
  check "https://$INGEST_DOMAIN/files/ rejects a missing token (401)" \
    "[ \"\$(curl -sS --max-time 15 -o /dev/null -w '%{http_code}' -X POST -H 'Tus-Resumable: 1.0.0' -H 'Upload-Length: 1' https://$INGEST_DOMAIN/files/)\" = 401 ]"
  check "https://$MAIN_DOMAIN/files/ rejects a missing token (401)" \
    "[ \"\$(curl -sS --max-time 15 -o /dev/null -w '%{http_code}' -X POST -H 'Tus-Resumable: 1.0.0' -H 'Upload-Length: 1' https://$MAIN_DOMAIN/files/)\" = 401 ]"
  check "the ingest gate runs with the session check (no INGEST_SESSION_CHECK in its environment)" \
    "e=\"\$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' \"\$(\"$ROOT/infra/field-trial/trial.sh\" ps -q ingest-gate)\")\" && [ -n \"\$e\" ] && ! grep -q '^INGEST_SESSION_CHECK=' <<<\"\$e\""
  check "the API limits the ingest gate's address to /internal/ingest/ (INTERNAL_SOURCE_PATHS)" \
    "e=\"\$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' \"\$(\"$ROOT/infra/field-trial/trial.sh\" ps -q api)\")\" && grep -qx 'INTERNAL_SOURCE_PATHS=172.30.250.3/32=/internal/ingest/' <<<\"\$e\""
  # الحاويتان تحملان الخانة وحساب القبول بقدر ما يحمله ملف الأسرار: لا بقايا نافذة مغلقة في حاوية لم يُعد إنشاؤها.
  if [ -n "${qk:-}${qu:-}" ]; then qa_want=1; else qa_want=0; fi
  env_of() { docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$("$ROOT/infra/field-trial/trial.sh" ps -q "$1")" 2>/dev/null; }
  has() { grep -q "^$2=." <<<"$(env_of "$1")" && echo 1 || echo 0; }
  check "the gate and the API carry the qa slot only while a window is open" \
    "[ -n \"\$(env_of ingest-gate)\" ] && [ \"\$(has ingest-gate INGEST_QA_PUBLIC_KEY)\$(has api ACCEPTANCE_UPLOADER_USER_ID)\" = $qa_want$qa_want ]"
  check "the media worker runs with delivery off and alignment on" \
    "e=\"\$(env_of media-worker)\" && grep -qx 'MEDIA_ENABLE_DELIVERY=false' <<<\"\$e\" && grep -qx 'MEDIA_ENABLE_ALIGNMENT=true' <<<\"\$e\""
  if [ "${WALG_ARCHIVE_MODE:-}" = on ]; then
    arch() { "$ROOT/infra/field-trial/trial.sh" exec -T postgres psql -U "$(sed -n 's/^POSTGRES_USER=//p' "$ROOT/infra/compose/.env.example" | tail -1)" -d postgres -XAtq -c "$1" 2>/dev/null; }
    check "postgres archives WAL (archive_mode on)" "[ \"\$(arch 'show archive_mode')\" = on ]"
    check "no WAL segment waits more than 10 minutes to be archived" \
      "[ \"\$(arch \"select coalesce(extract(epoch from now() - min(modification))::int, 0) < 600 from pg_ls_archive_statusdir() where name like '%.ready'\")\" = t ]"
    check "the last archive attempt did not fail" \
      "[ \"\$(arch 'select last_failed_time is null or last_failed_time < coalesce(last_archived_time, last_failed_time) from pg_stat_archiver')\" = t ]"
  fi
  check "/internal is not reachable from outside" "[ \"\$(curl -sS --max-time 15 -o /dev/null -w '%{http_code}' https://$MAIN_DOMAIN/internal/x)\" = 404 ]"
  check "ingest name does not answer on MAIN_IP" "! curl -sS --max-time 10 -o /dev/null --resolve $INGEST_DOMAIN:443:$MAIN_IP https://$INGEST_DOMAIN/files/"
  last="$BACKUP_DIR/last-success.json"
  if [ -f "$last" ] && [ $(( $(date +%s) - $(stat -c %Y "$last") )) -lt $((26 * 3600)) ]; then ok "last backup within 26 hours"
  else bad "last backup within 26 hours ($last)"; fi
  [ ! -f "$BACKUP_DIR/last-failure.json" ] || [ "$last" -nt "$BACKUP_DIR/last-failure.json" ] && ok "no backup failure since the last success" \
    || bad "a backup failed after the last success ($BACKUP_DIR/last-failure.json)"
  check "all trial containers running" "! \"$ROOT/infra/field-trial/trial.sh\" ps --format '{{.State}}' | grep -qv running"
  check "default network gateway is 172.30.240.1 (the address TRUSTED_PROXY_CIDRS trusts)" \
    "[ \"\$(docker network inspect ${TRIAL_PROJECT:-post-history-trial}_default -f '{{(index .IPAM.Config 0).Gateway}}')\" = 172.30.240.1 ]"
fi

echo "preflight: $pass ok, $warn warn, $fail FAIL"
if [ -n "$JSON" ]; then
  mkdir -p "$(dirname "$JSON")"
  checks="$(printf '%s\n' "${results[@]}" | python3 -c 'import json,sys; print(json.dumps([dict(zip(("status","check"),l.rstrip("\n").split("|",1))) for l in sys.stdin]))')"
  python3 - "$JSON" "$started_at" "$pass" "$warn" "$fail" "$RUNNING" "$checks" <<'EOF'
import json, sys, datetime
out, started, p, w, f, running, checks = sys.argv[1:]
failed = [c["check"] for c in json.loads(checks) if c["status"] == "FAIL"]
json.dump({"schema_version": 1, "tool": "other", "role": "infra", "started_at": started,
           "ended_at": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
           "result": "pass" if int(f) == 0 else "fail",
           "device": {"platform": "server", "model": "field trial host"},
           "metrics": {"checks_ok": int(p), "checks_warn": int(w), "checks_failed": int(f), "after_start": running == "1",
                       "failed_checks": "; ".join(failed)},
           "notes": "infra/field-trial/preflight.sh on the trial host (ADR 0013). No secret value is read into this file."},
          open(out, "w"), indent=2, ensure_ascii=False)
EOF
fi
[ "$fail" -eq 0 ]
