#!/bin/sh
# نسخة أساسية بـ WAL-G (ADR 0051)، من حاوية جانبية تقرأ مجلد البيانات للقراءة فقط وتتصل بدور walg_backup.
#   walg-base.sh once   نسخة الآن
#   walg-base.sh loop   كل يوم عند BACKUP_HOUR_UTC (الافتراضي)
# البيئة: PGHOST PGUSER PGPASSWORD PGDATABASE، وWALG_S3_PREFIX وAWS_* وWALG_PGP_KEY_PATH (المفتاح العام وحده).
set -eu
DATA="${PGDATA:-/var/lib/postgresql/data}"
log() { echo "{\"time\":\"$(date -u +%FT%TZ)\",\"msg\":\"$*\"}"; }
once() { wal-g backup-push "$DATA" && log "wal-g base backup ok"; }
# Archiving off (WALG_S3_PREFIX unset): idle, so the restart policy does not loop; preflight reports it.
if [ -z "${WALG_S3_PREFIX:-}" ]; then log "wal-g not configured: base backups off"; exec sleep infinity; fi
case "${1:-loop}" in
  once) once ;;
  loop)
    hour="${BACKUP_HOUR_UTC:-2}"
    once || log "wal-g base backup failed"
    while :; do
      now="$(date -u +%s)"
      next=$(( (now / 86400) * 86400 + hour * 3600 )); [ "$next" -gt "$now" ] || next=$((next + 86400))
      sleep $((next - now))
      once || log "wal-g base backup failed"
    done ;;
  *) echo "usage: walg-base.sh once|loop" >&2; exit 2 ;;
esac
