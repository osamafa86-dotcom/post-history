#!/usr/bin/env bash
# مراقبة دنيا لبيئة التجربة بلا مزوّد خارجي (ADR 0013). بصلاحية root على المضيف، كل دقيقة من مؤقّت systemd:
#   infra/observability/healthcheck.sh [--json FILE] [--alert]
# لكل خدمة: الحاوية تعمل وفحص compose الصحي سليم. ثم فحوص وظيفية: الخادم /health، وtusd عبر tusd-proxy، والبوابة ترفض
# بلا رمز (401)، وPostgres وRedis وMinIO، ومستهلك media:events لم يتوقف وفي الطابور عمل، والقرص < DISK_ALERT_PCT،
# وآخر نسخة احتياطية ناجحة خلال 26 ساعة بلا فشل بعدها.
# --json: النتيجة لنقطة /health الداخلية (health-endpoint.py)، بأسماء الفحوص وحالتها فقط.
# --alert: عند تغيّر مجموعة الفاشل يُكتب سطر في ALERT_LOG، ويُرسل بريد إن ضُبط ALERT_EMAIL_TO ووُجد sendmail محلي.
# لا قيمة سرية ولا بيانات مادة في أي مخرج: أسماء الفحوص وأسباب عامة فقط. الخروج 0 إن سلم كل شيء، وإلا 1.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP="$(cd "$HERE/../.." && pwd)"
T="${TRIAL_SH:-$APP/infra/field-trial/trial.sh}"
ENV_FILE="${TRIAL_ENV_FILE:-/run/post-history/trial.env}"
DISK_ALERT_PCT="${DISK_ALERT_PCT:-85}"
MEDIA_STALL_S="${MEDIA_STALL_S:-900}"
STATE_DIR="${HEALTH_STATE_DIR:-/var/lib/post-history}"
ALERT_LOG="${ALERT_LOG:-/var/log/post-history/alerts.log}"
ALERT_CONF="${ALERT_CONF:-/etc/post-history/alert.conf}"
JSON="" ALERT=0
while [ $# -gt 0 ]; do
  case "$1" in
    --json) JSON="$2"; shift 2 ;;
    --alert) ALERT=1; shift ;;
    *) echo "usage: $0 [--json FILE] [--alert]" >&2; exit 2 ;;
  esac
done
envval() { sed -n "s/^$1=//p" "$2" 2>/dev/null | tail -1; }
API_PORT="$(envval API_PORT "$APP/infra/compose/.env.example")"
TUSD_PORT="$(envval TUSD_PORT "$APP/infra/compose/.env.example")"
INGEST_PORT="$(envval INGEST_PORT "$ENV_FILE")"; INGEST_PORT="${INGEST_PORT:-8443}"
BACKUP_DIR="$(envval BACKUP_DIR "$ENV_FILE")"; BACKUP_DIR="${BACKUP_DIR:-/srv/post-history/backups}"

names=() states=() failed=()
ok()  { names+=("$1"); states+=(ok); printf 'ok    %s\n' "$1"; }
bad() { names+=("$1"); states+=(fail); failed+=("$1"); printf 'FAIL  %s: %s\n' "$1" "$2"; }
code() { curl -sS --max-time 10 -o /dev/null -w '%{http_code}' "$@" 2>/dev/null || echo 000; }
rcli() { "$T" exec -T redis sh -c 'REDISCLI_AUTH="$REDIS_PASSWORD" redis-cli "$@"' sh "$@" 2>/dev/null; }

# --- الحاويات
for svc in postgres redis minio tusd tusd-proxy ingest-gate api media-worker caddy caddy-ingest backup; do
  id="$("$T" ps -q "$svc" 2>/dev/null | head -1)"
  if [ -z "$id" ]; then bad "container:$svc" "not running"; continue; fi
  st="$(docker inspect -f '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$id" 2>/dev/null)"
  case "$st" in
    "running healthy"|"running none") ok "container:$svc" ;;
    *) bad "container:$svc" "${st:-unknown}" ;;
  esac
done

# --- وظيفية
[ "$(code "http://127.0.0.1:$API_PORT/health")" = 200 ] && ok "api:health" || bad "api:health" "not 200"
if curl -sS --max-time 10 -o /dev/null -D - -X OPTIONS -H 'Tus-Resumable: 1.0.0' "http://127.0.0.1:$TUSD_PORT/files/" 2>/dev/null \
     | grep -qi '^tus-resumable:'; then ok "tusd:via-proxy"; else bad "tusd:via-proxy" "no tus response"; fi
[ "$(code -X POST -H 'Tus-Resumable: 1.0.0' -H 'Upload-Length: 1' "http://127.0.0.1:$INGEST_PORT/files/")" = 401 ] \
  && ok "ingest-gate:rejects-untokened" || bad "ingest-gate:rejects-untokened" "not 401"
"$T" exec -T postgres sh -c 'pg_isready -q -U "$POSTGRES_USER" -d "$POSTGRES_DB"' >/dev/null 2>&1 \
  && ok "postgres:ready" || bad "postgres:ready" "pg_isready failed"
[ "$(rcli ping | tr -d '\r')" = PONG ] && ok "redis:ping" || bad "redis:ping" "no PONG"
"$T" exec -T minio mc ready local >/dev/null 2>&1 && ok "minio:ready" || bad "minio:ready" "not ready"

# مستهلك media:events: متوقف إن كان في الطابور عمل (معلّق أو لم يُقرأ) وآخر نشاط لكل مستهلك أقدم من MEDIA_STALL_S.
groups="$(rcli XINFO GROUPS media:events)"
if [ -z "$groups" ] || grep -q ERR <<<"$groups"; then
  ok "media:consumer"   # لا طابور بعد: لا حدث لم يُستهلك
else
  read -r pending lag consumers <<<"$(awk 'NR%2==1{k=$0} NR%2==0{v[k]=$0} END{print v["pending"]+0, v["lag"]+0, v["consumers"]+0}' <<<"$groups")"
  idle_min="$(rcli XINFO CONSUMERS media:events media | awk 'NR%2==1{k=$0} NR%2==0 && k=="idle"{if(m==""||$0<m)m=$0} END{print m+0}')"
  if [ "$((pending + lag))" -gt 0 ] && { [ "$consumers" -eq 0 ] || [ "$idle_min" -gt $((MEDIA_STALL_S * 1000)) ]; }; then
    bad "media:consumer" "work queued and no consumer active for ${MEDIA_STALL_S}s"
  else ok "media:consumer"; fi
fi

# --- القرص
for p in / /var/lib/docker "$BACKUP_DIR"; do
  [ -d "$p" ] || continue
  pct="$(df --output=pcent "$p" | tail -1 | tr -dc 0-9)"
  [ "${pct:-0}" -lt "$DISK_ALERT_PCT" ] && ok "disk:$p" || bad "disk:$p" "${pct}% >= ${DISK_ALERT_PCT}%"
done

# --- النسخ الاحتياطي
last="$BACKUP_DIR/last-success.json"
if [ ! -f "$last" ]; then bad "backup:recent" "no successful backup yet"
elif [ $(( $(date +%s) - $(stat -c %Y "$last") )) -ge $((26 * 3600)) ]; then bad "backup:recent" "last success older than 26h"
elif [ -f "$BACKUP_DIR/last-failure.json" ] && [ "$BACKUP_DIR/last-failure.json" -nt "$last" ]; then bad "backup:recent" "failed after the last success"
else ok "backup:recent"; fi

now="$(date -u +%FT%TZ)"
if [ -n "$JSON" ]; then
  mkdir -p "$(dirname "$JSON")"
  { printf '{"checked_at":"%s","ok":%s,"checks":{' "$now" "$([ ${#failed[@]} -eq 0 ] && echo true || echo false)"
    for i in "${!names[@]}"; do printf '%s"%s":"%s"' "$([ "$i" -gt 0 ] && echo ,)" "${names[$i]}" "${states[$i]}"; done
    printf '}}\n'; } > "$JSON.part"
  chmod 0644 "$JSON.part" && mv -f "$JSON.part" "$JSON"
fi

if [ "$ALERT" = 1 ]; then
  mkdir -p "$STATE_DIR" "$(dirname "$ALERT_LOG")"
  cur="${failed[*]:-}" prev="$(cat "$STATE_DIR/alert.state" 2>/dev/null || true)"
  if [ "$cur" != "$prev" ]; then
    if [ -n "$cur" ]; then msg="$now FAIL ${cur// /, }"; else msg="$now RECOVERED (was: ${prev// /, })"; fi
    echo "$msg" >> "$ALERT_LOG"
    to="$(envval ALERT_EMAIL_TO "$ALERT_CONF")"
    if [ -n "$to" ] && command -v sendmail >/dev/null 2>&1; then
      printf 'To: %s\nSubject: [post-history trial] %s\n\n%s\nhost: %s\n' "$to" "${msg#* }" "$msg" "$(hostname)" | sendmail -t \
        || echo "$now alert mail failed" >> "$ALERT_LOG"
    fi
    printf '%s' "$cur" > "$STATE_DIR/alert.state"
  fi
fi
echo "health: ${#names[@]} checks, ${#failed[@]} failed"
[ ${#failed[@]} -eq 0 ]
