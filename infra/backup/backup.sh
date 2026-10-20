#!/bin/sh
# نسخ احتياطي يومي لـ Postgres وحاويتي MinIO (ADR 0013). كل ملف يُشفَّر بالمفتاح العام للمستلم (CMS، AES-256)
# قبل أن يلمس القرص: المفتاح الخاص غير متصل لدى المالك، فالخادم لا يقرأ نسخه، ولا تسرّب نسخة مسروقة شيئًا.
#   backup.sh once   نسخة واحدة الآن (للتمرين والتشغيل اليدوي)
#   backup.sh loop   نسخة كل يوم عند BACKUP_HOUR_UTC (الافتراضي في الحاوية)
#
# البيئة: PGHOST PGUSER PGPASSWORD PGDATABASE؛ S3_ENDPOINT وS3_BACKUP_ACCESS_KEY/S3_BACKUP_SECRET_KEY (مستخدم قراءة
# فقط، infra/minio/init.sh)؛ S3_BUCKET_UPLOADS S3_BUCKET_MEDIA؛ BACKUP_RECIPIENT_CERT (شهادة المستلم العامة)؛
# BACKUP_DIR (/backups)؛ BACKUP_KEEP_DAYS (14، لتفريغات Postgres المحلية فقط؛ الكائنات لا تُحذف من النسخ)؛
# واختياريًا BACKUP_REMOTE_URL/BACKUP_REMOTE_ACCESS_KEY/BACKUP_REMOTE_SECRET_KEY/BACKUP_REMOTE_BUCKET لنسخة لدى
# مزوّد ثانٍ بقفل كائنات. لا تُطبع قيمة سرية: مفاتيح mc تُصدَّر في البيئة ولا تمر في سطر الأوامر.
set -eu

DIR="${BACKUP_DIR:-/backups}"
CERT="${BACKUP_RECIPIENT_CERT:-/run/backup/recipient.crt}"
KEEP="${BACKUP_KEEP_DAYS:-14}"
log() { echo "{\"time\":\"$(date -u +%FT%TZ)\",\"msg\":\"$*\"}"; }

encrypt() { # stdin -> $1 (ذري: .part ثم mv)
  openssl cms -encrypt -binary -stream -outform DER -aes-256-cbc -out "$1.part" "$CERT" && mv "$1.part" "$1"
}

hosts() {
  proto="${S3_ENDPOINT%%://*}"; host="${S3_ENDPOINT#*://}"
  export MC_HOST_src="${proto}://${S3_BACKUP_ACCESS_KEY}:${S3_BACKUP_SECRET_KEY}@${host}"
  if [ -n "${BACKUP_REMOTE_URL:-}" ]; then
    rproto="${BACKUP_REMOTE_URL%%://*}"; rhost="${BACKUP_REMOTE_URL#*://}"
    export MC_HOST_remote="${rproto}://${BACKUP_REMOTE_ACCESS_KEY}:${BACKUP_REMOTE_SECRET_KEY}@${rhost}"
  fi
}

once() {
  [ -r "$CERT" ] || { log "recipient certificate missing"; return 1; }
  openssl x509 -in "$CERT" -noout -checkend 0 >/dev/null || { log "recipient certificate expired"; return 1; }
  hosts
  ts="$(date -u +%Y%m%dT%H%M%SZ)"
  mkdir -p "$DIR/pg" "$DIR/objects"

  # عدّ الصفوف قبل التفريغ مباشرة: تمرين الاستعادة يقارن بها (المستعاد >= المعدود؛ ما كُتب بينهما يزيد ولا ينقص).
  psql -XAtq -c "select table_name from information_schema.tables where table_schema='public' and table_type='BASE TABLE' order by 1" |
    while read -r t; do echo "$t $(psql -XAtq -c "select count(*) from public.\"$t\"")"; done > "$DIR/pg/$ts.counts"
  pg_dump -Fc | encrypt "$DIR/pg/$ts.dump.cms"
  dump_bytes="$(wc -c < "$DIR/pg/$ts.dump.cms")"
  log "postgres dump encrypted bytes=$dump_bytes"

  new=0; total=0
  for b in "$S3_BUCKET_UPLOADS" "$S3_BUCKET_MEDIA"; do
    mc find "src/$b" > "$DIR/objects/.list" || { log "listing failed bucket=$b"; return 1; }
    while IFS= read -r path; do
      key="${path#src/$b/}"
      out="$DIR/objects/$b/$key.cms"
      total=$((total + 1))
      [ -f "$out" ] && continue   # الأصل لا يتغيّر (القاعدة)، فما نُسخ مرة لا يُعاد
      mkdir -p "$(dirname "$out")"
      mc cat "$path" | encrypt "$out"
      new=$((new + 1))
    done < "$DIR/objects/.list"
  done
  rm -f "$DIR/objects/.list"
  log "objects encrypted new=$new total=$total"

  find "$DIR/pg" -name '*.dump.cms' -mtime +"$KEEP" -delete
  find "$DIR/pg" -name '*.counts' -mtime +"$KEEP" -delete

  remote=false
  if [ -n "${BACKUP_REMOTE_URL:-}" ]; then
    mc mirror --quiet "$DIR/pg" "remote/$BACKUP_REMOTE_BUCKET/pg" >/dev/null
    mc mirror --quiet "$DIR/objects" "remote/$BACKUP_REMOTE_BUCKET/objects" >/dev/null
    remote=true
    log "mirrored to the second provider"
  fi

  cat > "$DIR/last-success.json.part" <<EOF
{"finished_at":"$(date -u +%FT%TZ)","pg_dump":"pg/$ts.dump.cms","pg_dump_bytes":$dump_bytes,"objects_new":$new,"objects_total":$total,"remote":$remote}
EOF
  mv "$DIR/last-success.json.part" "$DIR/last-success.json"
}

case "${1:-loop}" in
  once) once ;;
  loop)
    hour="${BACKUP_HOUR_UTC:-2}"
    while :; do
      now="$(date -u +%s)"
      next="$(date -u -d "@$(( (now / 86400) * 86400 + hour * 3600 ))" +%s)"
      [ "$next" -gt "$now" ] || next=$((next + 86400))
      log "next backup at $(date -u -d "@$next" +%FT%TZ)"
      sleep $((next - now))
      if once; then log "backup ok"; else
        echo "{\"failed_at\":\"$(date -u +%FT%TZ)\"}" > "$DIR/last-failure.json"
        log "backup failed"
      fi
    done ;;
  *) echo "usage: backup.sh once|loop" >&2; exit 2 ;;
esac
