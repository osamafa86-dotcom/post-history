#!/usr/bin/env bash
# تجهيز مضيف التجربة الميدانية بأمر واحد (ADR 0013، SEC-05). Ubuntu 24.04 LTS، بصلاحية root، من نسخة المستودع على المضيف:
#   sudo infra/deploy/bootstrap.sh --host-config /root/host.env --backup-cert /root/backup-recipient.crt \
#        --owner-age-recipient age1...
# host.env (بلا أسرار، يكتبه المالك): MAIN_DOMAIN INGEST_DOMAIN MAIN_IP INGEST_IP ACME_EMAIL CLOUDFLARE_CIDRS.
#
# الخطوات بالترتيب، وكل خطوة تُعاد بأمان (idempotent):
#   os          Ubuntu 24.04 وroot
#   packages    الحزم، وDocker من مستودعه بإصدارات مثبّتة (apt-mark hold) وتدوير سجلات الحاويات
#   user        مستخدم خدمة غير جذر (posthistory) لنقطة /health الداخلية، خارج مجموعة docker (تعادل root). شجرة المستودع
#               ملك root وغير قابلة للكتابة لغيره: root ينفّذ منها unseal.sh وtrial.sh عند كل إقلاع.
#   firewall    ufw: SSH، و80/443 على العنوانين وحدهما
#   dirs        /etc/post-history (0700)، /srv/post-history/backups (uid 70، 0700)، /run/post-history (tmpfs)
#   secrets     تُولَّد مرة واحدة وتُشفَّر بـ age فورًا إلى مفتاح المضيف ومفتاح المالك (trial.env.age)؛ النص الصريح
#               لا يلمس القرص ولا يُطبع، ويُفك إلى tmpfs فقط (unseal.sh). رمز الطوارئ يُشفَّر للمالك وحده.
#   images      سحب الصور (بالبصمة، check-pinned.sh) وبناء صورة النسخ
#   preflight   preflight.sh قبل التشغيل
#   start       trial.sh up -d --wait، ومعه النسخ اليومي المجدول وتدويره (خدمة backup، BACKUP_KEEP_DAYS)
#   systemd     وحدة post-history-trial (unseal ثم التشغيل بعد كل إقلاع)، ومؤقّت الصحة كل دقيقة مع التنبيه، ونقطة /health
#               الداخلية (127.0.0.1:9180، مستخدم الخدمة)، وتدوير سجل التنبيهات
#   verify      preflight.sh --running --json
#
# --dry-run --root DIR: لا يمس النظام. أوامر النظام (apt، ufw، docker، systemctl، useradd) تُطبع بـ "+ " ولا
# تُنفَّذ، وما يُكتب من ملفات (المفاتيح، الأسرار المشفّرة، النص المفكوك) يُكتب تحت DIR بالأذونات نفسها ليُفحص.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP="$(cd "$HERE/../.." && pwd)"
# الإصدارات المثبّتة (download.docker.com، noble، 2026-10-20). الترقية تعديل هنا ومراجعة، لا apt upgrade.
DOCKER_VERSION="${DOCKER_VERSION:-5:29.9.1-1~ubuntu.24.04~noble}"
CONTAINERD_VERSION="${CONTAINERD_VERSION:-2.4.2-2~ubuntu.24.04~noble}"
COMPOSE_VERSION="${COMPOSE_VERSION:-5.6.0-1~ubuntu.24.04~noble}"
DOCKER_GPG_FINGERPRINT=9DC858229FC7DD38854AE2D88D81803C0EBFCD88
SERVICE_USER=posthistory

HOST_CONFIG="" BACKUP_CERT="" OWNER_RECIPIENT="" DRY=0 PREFIX=""
usage() { echo "usage: $0 --host-config FILE --backup-cert FILE --owner-age-recipient age1... [--dry-run --root DIR]" >&2; exit 2; }
while [ $# -gt 0 ]; do
  case "$1" in
    --host-config) HOST_CONFIG="$2"; shift 2 ;;
    --backup-cert) BACKUP_CERT="$2"; shift 2 ;;
    --owner-age-recipient) OWNER_RECIPIENT="$2"; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    --root) PREFIX="${2%/}"; shift 2 ;;
    *) usage ;;
  esac
done
[ -r "$HOST_CONFIG" ] && [ -r "$BACKUP_CERT" ] && [ -n "$OWNER_RECIPIENT" ] || usage
[ "$DRY" = 0 ] || [ -n "$PREFIX" ] || { echo "--dry-run needs --root DIR" >&2; exit 2; }
[ "$DRY" = 1 ] || [ -z "$PREFIX" ] || { echo "--root is for --dry-run only" >&2; exit 2; }
case "$OWNER_RECIPIENT" in age1*) ;; *) echo "--owner-age-recipient: an age public key (age1...)" >&2; exit 2 ;; esac

ETC="$PREFIX/etc/post-history" RUN="$PREFIX/run/post-history" SRV="$PREFIX/srv/post-history"
export TRIAL_ENV_FILE="$RUN/trial.env"
STEPS=(os packages user firewall dirs secrets images preflight start systemd verify)
step=0
say() { step=$((step + 1)); echo "== step $step/${#STEPS[@]}: $1"; }
run() { if [ "$DRY" = 1 ]; then printf '+ %s\n' "$*"; else "$@"; fi; }
die() { echo "!! $*" >&2; exit 1; }

# host.env: الأسماء المطلوبة فقط، بلا قيم سرية. تُقرأ دون source (لا تنفيذ لمحتوى الملف).
conf() { sed -n "s/^$1=//p" "$HOST_CONFIG" | tail -1; }
for k in MAIN_DOMAIN INGEST_DOMAIN MAIN_IP INGEST_IP ACME_EMAIL CLOUDFLARE_CIDRS; do
  [ -n "$(conf "$k")" ] || die "host config: $k is empty"
done
[ "$(conf MAIN_IP)" != "$(conf INGEST_IP)" ] || die "host config: MAIN_IP and INGEST_IP must differ (ADR 0011)"
openssl x509 -in "$BACKUP_CERT" -noout -checkend 5184000 >/dev/null || die "backup certificate invalid or expires within 60 days"
grep -q "PRIVATE KEY" "$BACKUP_CERT" && die "the backup certificate file holds a private key: give the certificate only"

say os
[ "$(id -u)" = 0 ] || die "run as root"
if [ "$DRY" = 0 ]; then
  . /etc/os-release
  [ "${ID:-}" = ubuntu ] && [ "${VERSION_ID:-}" = 24.04 ] || die "Ubuntu 24.04 LTS only (pinned Docker packages are built for noble)"
fi

say packages
run apt-get update -q
run env DEBIAN_FRONTEND=noninteractive apt-get install -y -q --no-install-recommends \
  ca-certificates curl gnupg openssl age ufw git python3 util-linux
run install -m 0755 -d /etc/apt/keyrings
run curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
if [ "$DRY" = 0 ]; then
  gpg --show-keys --with-colons /etc/apt/keyrings/docker.asc | grep -q "^fpr:::::::::$DOCKER_GPG_FINGERPRINT:" \
    || die "Docker repository key fingerprint mismatch"
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu noble stable" \
    > /etc/apt/sources.list.d/docker.list
else
  echo "+ verify docker.asc fingerprint $DOCKER_GPG_FINGERPRINT; write /etc/apt/sources.list.d/docker.list (noble stable)"
fi
run apt-get update -q
run env DEBIAN_FRONTEND=noninteractive apt-get install -y -q --allow-downgrades \
  "docker-ce=$DOCKER_VERSION" "docker-ce-cli=$DOCKER_VERSION" "containerd.io=$CONTAINERD_VERSION" \
  "docker-compose-plugin=$COMPOSE_VERSION"
run apt-mark hold docker-ce docker-ce-cli containerd.io docker-compose-plugin
# سجلات الحاويات تُدوَّر، فلا تملأ القرص في أسبوعين. والوسم tag باسم الحاوية يقرؤه مجمّع السجلات (ADR 0027).
install -d -m 0755 "$PREFIX/etc/docker"
[ -f "$PREFIX/etc/docker/daemon.json" ] || printf '%s\n' \
  '{"log-driver": "json-file", "log-opts": {"max-size": "50m", "max-file": "5", "tag": "{{.Name}}"}, "live-restore": true}' \
  > "$PREFIX/etc/docker/daemon.json"
run systemctl enable --now docker
run systemctl restart docker

say user
if [ "$DRY" = 1 ] || ! id "$SERVICE_USER" >/dev/null 2>&1; then
  run useradd --system --home-dir /srv/post-history --shell /usr/sbin/nologin "$SERVICE_USER"
fi
# root ينفّذ من هذه الشجرة، فلا يكتبها غيره (ملاحظة الأمن على #91).
run chown -R root:root "$APP"
run chmod -R go-w "$APP"

say firewall
run ufw default deny incoming
run ufw default allow outgoing
run ufw allow OpenSSH
for ip in "$(conf MAIN_IP)" "$(conf INGEST_IP)"; do
  run ufw allow proto tcp to "$ip" port 80,443
done
run ufw --force enable

say dirs
install -d -m 0700 "$ETC"
install -d -m 0755 "$SRV"
install -d -m 0700 "$SRV/backups"
run chown 70:70 /srv/post-history/backups
install -d -m 0700 "$RUN"
if [ "$DRY" = 0 ]; then
  [ "$(stat -f -c %T "$RUN")" = tmpfs ] || die "$RUN is not on tmpfs"
fi
install -m 0444 "$BACKUP_CERT" "$ETC/backup-recipient.crt"
# الفحوص الصحية مقاييسَ لـ node-exporter (healthcheck.sh --prom، ADR 0027).
install -d -m 0755 "$PREFIX/var/lib/post-history/textfile"

say secrets
umask 077
if [ ! -f "$ETC/host.agekey" ]; then
  age-keygen -o "$ETC/host.agekey" 2>/dev/null
  chmod 0400 "$ETC/host.agekey"
fi
HOST_RECIPIENT="$(age-keygen -y "$ETC/host.agekey")"
if [ -f "$ETC/trial.env.age" ]; then
  echo "secrets exist ($ETC/trial.env.age): not regenerated"
else
  hex() { head -c "$1" /dev/urandom | od -An -vtx1 | tr -d ' \n'; }
  ingest_priv="$(openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 2>/dev/null)"
  break_glass="$(hex 32)"
  # رمز الطوارئ للمالك وحده؛ الخادم يحمل بصمته فقط.
  printf '%s\n' "$break_glass" | age -r "$OWNER_RECIPIENT" -o "$ETC/break-glass.age"
  {
    for k in MAIN_DOMAIN INGEST_DOMAIN MAIN_IP INGEST_IP ACME_EMAIL CLOUDFLARE_CIDRS; do echo "$k=$(conf "$k")"; done
    # معرّفات التطبيقين لشهادة الجهاز (ليست أسرارًا؛ اختيارية هنا، وpreflight يرسب بلا واحد منها لأن ingest مطلوب).
    # حساب خدمة Play Integrity سر: يضيفه المالك إلى الأسرار المختومة لا إلى host.env.
    for k in APP_ATTEST_APP_ID PLAY_INTEGRITY_PACKAGE_NAME PLAY_INTEGRITY_CERT_SHA256; do echo "$k=$(conf "$k")"; done
    echo "TRUSTED_PROXY_CIDRS=172.30.240.1/32"
    echo "CADDY_GLOBAL_EXTRA="
    echo "POSTGRES_PASSWORD=$(hex 32)"
    echo "REDIS_PASSWORD=$(hex 32)"
    echo "S3_SECRET_KEY=$(hex 32)"
    echo "TUSD_HOOK_SECRET=$(hex 32)"
    echo "JWT_SECRET=$(hex 32)"
    echo "FIELD_ENCRYPTION_KEY=$(head -c 32 /dev/urandom | base64 -w0)"
    echo "FIELD_ENCRYPTION_KEY_VERSION=1"
    echo "BREAK_GLASS_TOKEN_SHA256=$(printf '%s' "$break_glass" | sha256sum | cut -c1-64)"
    echo "MEDIA_WORKER_TOKEN=$(hex 32)"
    echo "S3_MEDIA_ACCESS_KEY=media-worker"
    echo "S3_MEDIA_SECRET_KEY=$(hex 32)"
    echo "UPLOAD_VERIFIER=external"
    echo "INGEST_TOKEN_PUBLIC_KEYS=k1:$(printf '%s\n' "$ingest_priv" | openssl pkey -pubout -outform DER | base64 -w0)"
    echo "INGEST_TOKEN_SIGNING_KEY=$(printf '%s\n' "$ingest_priv" | openssl pkcs8 -topk8 -nocrypt -outform DER | base64 -w0)"
    echo "INGEST_TOKEN_KEY_ID=k1"
    echo "INGEST_PORT=8443"
    echo "INGEST_GATE_TOKEN=$(hex 32)"
    echo "INGEST_REQUIRED=true"   # لا يُطفأ إلا بقرار مكتوب (ADR 0011)
    echo "BACKUP_PG_PASSWORD=$(hex 32)"
    echo "S3_BACKUP_ACCESS_KEY=backup-reader"
    echo "S3_BACKUP_SECRET_KEY=$(hex 32)"
    echo "BACKUP_DIR=/srv/post-history/backups"
    echo "BACKUP_RECIPIENT_CERT=/etc/post-history/backup-recipient.crt"
    echo "BACKUP_HOUR_UTC=2"
    echo "BACKUP_KEEP_DAYS=14"
    # المراقبة وتتبّع الأخطاء (ADR 0027، 0029): مشروعان مستقلان يقرآن هذا الملف نفسه (infra/observability/stack.sh).
    echo "GRAFANA_ADMIN_PASSWORD=$(hex 24)"
    echo "GLITCHTIP_DB_PASSWORD=$(hex 32)"
    echo "GLITCHTIP_SECRET_KEY=$(hex 32)"
  } | age -r "$HOST_RECIPIENT" -r "$OWNER_RECIPIENT" -o "$ETC/trial.env.age.part"
  mv "$ETC/trial.env.age.part" "$ETC/trial.env.age"
  unset ingest_priv break_glass
  echo "secrets generated and sealed to the host and owner keys: $ETC/trial.env.age (copy it to the ops repo)"
fi
UNSEAL_ETC="$ETC" UNSEAL_RUN="$RUN" "$HERE/unseal.sh"

say images
run "$APP/infra/compose/check-pinned.sh"
# The API image for the checked-out commit (ADR 0050): a release tag's own image, checked, or built here when none.
head_sha="$(git -C "$APP" rev-parse HEAD)"
head_tag="$(git -C "$APP" tag --points-at HEAD -l "${RELEASE_TAG_PATTERN:-v*}" --sort=-v:refname | head -1)"
if [ -n "$head_tag" ]; then run "$APP/infra/deploy/api-image.sh" "$head_sha" --tag "$head_tag"
else run "$APP/infra/deploy/api-image.sh" "$head_sha" --build; fi
run "$APP/infra/field-trial/trial.sh" pull --quiet
run "$APP/infra/field-trial/trial.sh" build backup

say preflight
run "$APP/infra/field-trial/preflight.sh"

say start
run "$APP/infra/field-trial/trial.sh" up -d --wait
run "$APP/infra/observability/stack.sh" monitoring up -d --wait
run "$APP/infra/observability/stack.sh" errors up -d --wait

say systemd
unit="$PREFIX/etc/systemd/system/post-history-trial.service"
install -d -m 0755 "$(dirname "$unit")"
cat > "$unit" <<EOF
[Unit]
Description=post-history field trial (ADR 0013)
After=docker.service network-online.target
Requires=docker.service
Wants=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStartPre=$APP/infra/deploy/unseal.sh
ExecStart=$APP/infra/field-trial/trial.sh up -d --wait
ExecStop=$APP/infra/field-trial/trial.sh stop
TimeoutStartSec=900

[Install]
WantedBy=multi-user.target
EOF
chmod 0644 "$unit"
units="$PREFIX/etc/systemd/system"
cat > "$units/post-history-health.service" <<UNIT
[Unit]
Description=post-history trial health checks and alerts (ADR 0013)
After=post-history-trial.service

[Service]
Type=oneshot
RuntimeDirectory=post-history-health
RuntimeDirectoryMode=0755
RuntimeDirectoryPreserve=yes
ExecStart=$APP/infra/observability/healthcheck.sh --json /run/post-history-health/health.json --prom /var/lib/post-history/textfile/health.prom --alert
SuccessExitStatus=1
UNIT
cat > "$units/post-history-health.timer" <<UNIT
[Unit]
Description=post-history trial health checks every minute

[Timer]
OnBootSec=3min
OnUnitActiveSec=1min

[Install]
WantedBy=timers.target
UNIT
cat > "$units/post-history-health-endpoint.service" <<UNIT
[Unit]
Description=post-history internal aggregated /health on 127.0.0.1:9180 (ADR 0013)
After=post-history-health.service

[Service]
User=$SERVICE_USER
ExecStart=/usr/bin/python3 $APP/infra/observability/health-endpoint.py --file /run/post-history-health/health.json --port 9180
Restart=always
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes

[Install]
WantedBy=multi-user.target
UNIT
cat > "$units/post-history-observability.service" <<UNIT
[Unit]
Description=post-history self-hosted monitoring and error tracking (ADR 0027, 0029)
After=post-history-trial.service
Wants=post-history-trial.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=$APP/infra/observability/stack.sh monitoring up -d --wait
ExecStart=$APP/infra/observability/stack.sh errors up -d --wait
ExecStop=$APP/infra/observability/stack.sh errors stop
ExecStop=$APP/infra/observability/stack.sh monitoring stop
TimeoutStartSec=600

[Install]
WantedBy=multi-user.target
UNIT
chmod 0644 "$units"/post-history-health* "$units/post-history-observability.service"
install -d -m 0755 "$PREFIX/etc/logrotate.d"
printf '%s\n' '/var/log/post-history/*.log {' '  weekly' '  rotate 8' '  compress' '  missingok' '  notifempty' '}' \
  > "$PREFIX/etc/logrotate.d/post-history"
# التنبيه بالبريد اختياري: عنوان هنا وsendmail محلي (مثل msmtp-mta) يضبطه المالك. السجل يُكتب دائمًا.
[ -f "$ETC/alert.conf" ] || printf '%s\n' '# ALERT_EMAIL_TO=ops@example.org' 'ALERT_EMAIL_TO=' > "$ETC/alert.conf"
install -d -m 0750 "$PREFIX/var/log/post-history"
run systemctl daemon-reload
run systemctl enable post-history-trial.service post-history-observability.service
run systemctl enable --now post-history-health.timer post-history-health-endpoint.service

say verify
run "$APP/infra/field-trial/preflight.sh" --running --json "$APP/docs/measurements/ops/$(date -u +%F)-field-trial-preflight.json"
echo "bootstrap: done"
