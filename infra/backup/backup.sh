#!/bin/sh
# نسخ احتياطي يومي لـ Postgres وحاويتي MinIO (ADR 0013). كل ملف يُشفَّر بالمفتاح العام للمستلم (CMS، AES-256-GCM)
# قبل أن يلمس القرص: المفتاح الخاص غير متصل لدى المالك، فالخادم لا يقرأ نسخه، ولا تسرّب نسخة مسروقة شيئًا.
#   backup.sh once   نسخة واحدة الآن (للتمرين والتشغيل اليدوي)
#   backup.sh loop   نسخة كل يوم عند BACKUP_HOUR_UTC (الافتراضي في الحاوية)
#
# البيئة: PGHOST PGUSER PGPASSWORD PGDATABASE (دور backup_reader للقراءة فقط، لا مالك القاعدة)؛ S3_ENDPOINT وS3_BACKUP_ACCESS_KEY/S3_BACKUP_SECRET_KEY (مستخدم قراءة
# فقط، infra/minio/init.sh)؛ S3_BUCKET_UPLOADS S3_BUCKET_MEDIA؛ BACKUP_RECIPIENT_CERT (شهادة المستلم العامة)؛
# BACKUP_DIR (/backups)؛ BACKUP_KEEP_DAYS (14، لتفريغات Postgres المحلية فقط؛ الكائنات لا تُحذف من النسخ)؛
# واختياريًا BACKUP_REMOTE_URL/BACKUP_REMOTE_ACCESS_KEY/BACKUP_REMOTE_SECRET_KEY/BACKUP_REMOTE_BUCKET لنسخة لدى
# مزوّد ثانٍ بقفل كائنات: حاوية بقفل كائنات واحتفاظ افتراضي بوضع compliance، ومفتاح كتابة فقط (PutObject وListBucket
# وGetBucketObjectLockConfiguration وGetObjectRetention، بلا قراءة ولا حذف). نسخة بلا احتفاظ compliance تُفشل النسخ. لا تُطبع قيمة سرية: مفاتيح mc تُصدَّر في البيئة ولا تمر في سطر الأوامر.
#
# الفشل مغلق: لا يُسجَّل نجاح ولا يوضع ملف في مكانه إلا بعد التحقق من كل مرحلة بنفسها.
# - set -e لا يسري داخل دالة تُستدعى من if أو && أو || (POSIX)، وpipefail لا يفيد حين يُتجاهل set -e. لذلك كل خطوة تفحص
#   حالتها صراحة، وكل نسخة في وضع loop تعمل في صدفة مستقلة (sh "$0" once) يسري فيها set -e أيضًا.
# - put: حالة المصدر (pg_dump أو mc cat) من ملف حالة لا من حالة الأنبوب، وحالة التشفير، وعدد بايتات النص المعدودة من
#   الأنبوب نفسه مقابل حجم الكائن في السرد. الناتج في .tmp/ ثم mv، ومعه OUT.size بعدد البايتات.
# - كائن له نسخة بلا OUT.size أو بحجم لا يطابق السرد (نسخة جزئية من قبل هذا الإصلاح، أو كائن تغيّر) يُنسخ من جديد، والمرآة
#   لدى المزوّد الثاني تكتبه نسخة جديدة (--overwrite)، والسابقة مقفلة حتى انتهاء احتفاظها.
# - كائن حُذف أو تغيّر حجمه بين السرد والقراءة (أجزاء tus المؤقتة، جلسة أُلغيت) لا يُفشل النسخ: يُعدّ ويُترك للنسخة التالية.
set -eu
# pipefail حيث تدعمه الصدفة (ash في busybox وbash)؛ والفحص الصريح لكل مرحلة لا يعتمد عليه.
if (set -o pipefail) 2>/dev/null; then set -o pipefail; fi

DIR="${BACKUP_DIR:-/backups}"
CERT="${BACKUP_RECIPIENT_CERT:-/run/backup/recipient.crt}"
KEEP="${BACKUP_KEEP_DAYS:-14}"
TMP="$DIR/.tmp"
TAB="$(printf '\t')"
log() { echo "{\"time\":\"$(date -u +%FT%TZ)\",\"msg\":\"$*\"}"; }

encrypt() { # stdin -> $1
  # GCM (AuthEnvelopedData): تعديل بايت واحد في النسخة يُفشل فك التشفير، وCBC يمرّره بلا إنذار.
  openssl cms -encrypt -binary -stream -outform DER -aes-256-gcm -out "$1" "$CERT"
}

# put OUT EXPECT CMD...: ناتج CMD مشفّرًا في OUT، أو لا شيء في OUT. EXPECT حجم النص المتوقع بالبايت (فارغ = غير معروف).
put() {
  p_out="$1" p_expect="$2"; shift 2
  p_part="$TMP/put.part" p_st="$TMP/put.status" p_fifo="$TMP/put.fifo" p_cnt="$TMP/put.count"
  PUT_FAILURE=""
  rm -f "$p_part" "$p_st" "$p_fifo" "$p_cnt"
  mkfifo "$p_fifo" || { PUT_FAILURE="no fifo"; return 1; }
  wc -c < "$p_fifo" > "$p_cnt" &
  p_counter=$!
  p_enc=0 p_wc=0
  { p_rc=0; "$@" || p_rc=$?; echo "$p_rc" > "$p_st"; } | tee "$p_fifo" | encrypt "$p_part" || p_enc=$?
  wait "$p_counter" || p_wc=$?
  p_src="$(cat "$p_st" 2>/dev/null || echo missing)"
  p_bytes="$(tr -d ' ' < "$p_cnt" 2>/dev/null || echo missing)"
  rm -f "$p_st" "$p_fifo" "$p_cnt"
  case "$p_bytes" in ''|*[!0-9]*) p_bytes=unknown ;; esac
  if [ "$p_src" != 0 ] || [ "$p_enc" != 0 ] || [ "$p_wc" != 0 ] || [ "$p_bytes" = unknown ] \
     || { [ -n "$p_expect" ] && [ "$p_bytes" != "$p_expect" ]; }; then
    rm -f "$p_part"
    PUT_FAILURE="source=$p_src encrypt=$p_enc bytes=$p_bytes expected=${p_expect:-any}"
    return 1
  fi
  # GCM لا يحذف شيئًا ويضيف ترويسة ووسمًا: نص مشفّر لا يزيد على النص ملف لم يُكتب كله.
  [ "$(wc -c < "$p_part")" -gt "$p_bytes" ] || { rm -f "$p_part"; PUT_FAILURE="ciphertext not longer than the plaintext"; return 1; }
  mkdir -p "$(dirname "$p_out")" && echo "$p_bytes" > "$TMP/put.size" || { PUT_FAILURE="not writable"; return 1; }
  mv "$p_part" "$p_out" && mv "$TMP/put.size" "$p_out.size" || { PUT_FAILURE="not moved into place"; return 1; }
}

# فك نص JSON من سرد mc إلى المفتاح نفسه: \" و\\ و\/ و\u00XX للمحارف المطبوعة (Go يكتب & و< و> هكذا). ما عدا ذلك (محرف
# تحكم، أو خارج ASCII بالهروب) نص فارغ، فيُفشل المستدعي.
AWK_DEC='
  function dec(s,   o, i, j, c, d, n) {
    o = ""
    for (i = 1; i <= length(s); i++) {
      c = substr(s, i, 1)
      if (c != "\\") { o = o c; continue }
      c = substr(s, ++i, 1)
      if (c == "\"" || c == "\\" || c == "/") { o = o c; continue }
      if (c != "u") return ""
      n = 0
      for (j = 1; j <= 4; j++) {
        d = index("0123456789abcdef", tolower(substr(s, i + j, 1)))
        if (!d) return ""
        n = n * 16 + d - 1
      }
      if (n < 32 || n > 126) return ""
      o = o sprintf("%c", n); i += 4
    }
    return o
  }'

# سرد حاوية بأحجام كائناتها: سطر «الحجم<TAB>المفتاح» لكل كائن، والمفتاح مفكوك من نص JSON في سرد mc. أي سطر ليس كائنًا
# ناجحًا، أو مفتاح لا يُحمل في سطر (محرف تحكم) أو يخرج من مجلد النسخ (..)، يُفشل السرد كله.
list() {
  mc ls --recursive --json "src/$1" > "$TMP/list.json" || return 1
  awk "$AWK_DEC"'
    $0 !~ /^\{"status":"success"/ { bad = 1; exit }
    $0 !~ /"type":"file"/ { next }
    {
      if (!match($0, /"size":[0-9]+/)) { bad = 1; exit }
      size = substr($0, RSTART + 7, RLENGTH - 7)
      if (!match($0, /"key":"([^"\\]|\\.)*"/)) { bad = 1; exit }
      key = dec(substr($0, RSTART + 7, RLENGTH - 8))
      if (key == "" || key ~ /^\// || key ~ /(^|\/)\.\.(\/|$)/) { bad = 1; exit }
      printf "%s\t%s\n", size, key
    }
    END { exit bad }' "$TMP/list.json" > "$TMP/list"
}

# حجم الكائن الآن بالبايت، أو gone إن لم يعد موجودًا؛ وأي خطأ آخر حالة غير صفرية. mc stat يعامل المسار بادئةً (tus/x يعيد
# tus/x وtus/x.info معًا)، فالسطر المقصود هو الذي اسمه اسم الكائن نفسه.
size_now() {
  if ! s_json="$(mc stat --json "src/$1" 2>&1)"; then
    printf '%s\n' "$s_json" | grep -q 'Object does not exist' && { echo gone; return 0; }
    return 1
  fi
  printf '%s\n' "$s_json" | awk -v want="${1##*/}" "$AWK_DEC"'
    /^\{"status":"success"/ && match($0, /"name":"([^"\\]|\\.)*"/) {
      if (dec(substr($0, RSTART + 8, RLENGTH - 9)) != want) next
      if (!match($0, /"size":[0-9]+/)) { bad = 1; exit }
      print substr($0, RSTART + 7, RLENGTH - 7); found = 1; exit
    }
    END { if (bad) exit 1; if (!found) print "gone" }'
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
  rm -rf "$TMP" && mkdir -p "$TMP" "$DIR/pg" "$DIR/objects" || { log "backup directory not writable"; return 1; }
  # Leftovers of the earlier script, which wrote <file>.cms.part beside its target: never a backup, never mirrored.
  find "$DIR/pg" "$DIR/objects" -name '*.cms.part' -type f -delete || return 1

  # عدّ الصفوف قبل التفريغ مباشرة: تمرين الاستعادة يقارن بها (المستعاد >= المعدود؛ ما كُتب بينهما يزيد ولا ينقص).
  psql -XAtq -c "select table_name from information_schema.tables where table_schema='public' and table_type='BASE TABLE' order by 1" \
    > "$TMP/tables" || { log "postgres table list failed"; return 1; }
  : > "$TMP/counts"
  while read -r t; do
    c="$(psql -XAtq -c "select count(*) from public.\"$t\"")" || { log "postgres row count failed"; return 1; }
    case "$c" in ''|*[!0-9]*) log "postgres row count failed"; return 1 ;; esac
    echo "$t $c" >> "$TMP/counts" || return 1
  done < "$TMP/tables"
  dump="$DIR/pg/$ts.dump.cms"
  put "$dump" "" pg_dump -Fc || { log "postgres dump failed, nothing kept ($PUT_FAILURE)"; return 1; }
  mv "$TMP/counts" "$DIR/pg/$ts.counts" || { rm -f "$dump" "$dump.size"; log "postgres counts not kept"; return 1; }
  dump_bytes="$(wc -c < "$dump")"
  log "postgres dump encrypted bytes=$dump_bytes plain_bytes=$(cat "$dump.size")"

  new=0 recopied=0 total=0 vanished=0 changed=0
  for b in "$S3_BUCKET_UPLOADS" "$S3_BUCKET_MEDIA"; do
    list "$b" || { log "listing failed bucket=$b"; return 1; }
    while IFS="$TAB" read -r size key; do
      out="$DIR/objects/$b/$key.cms"
      total=$((total + 1))
      kept=""
      [ -f "$out.size" ] && kept="$(cat "$out.size")"
      # الأصل لا يتغيّر (القاعدة): ما نُسخ كاملًا مرة بحجمه في السرد لا يُعاد.
      [ -f "$out" ] && [ "$kept" = "$size" ] && continue
      had=false; [ -f "$out" ] && had=true
      if put "$out" "$size" mc cat "src/$b/$key" </dev/null; then
        if $had; then recopied=$((recopied + 1)); else new=$((new + 1)); fi
        continue
      fi
      # حُذف أو تغيّر حجمه بين السرد والقراءة: يُترك للنسخة التالية، وما كان في مكانه يبقى كما هو. وأي عطل آخر يُفشل النسخ.
      now="$(size_now "$b/$key" </dev/null)" || { log "object copy failed bucket=$b ($PUT_FAILURE)"; return 1; }
      case "$now" in
        gone) vanished=$((vanished + 1)) ;;
        "$size") log "object copy failed bucket=$b ($PUT_FAILURE)"; return 1 ;;
        *) changed=$((changed + 1)) ;;
      esac
    done < "$TMP/list"
  done
  log "objects encrypted new=$new recopied=$recopied total=$total vanished=$vanished changed=$changed"

  find "$DIR/pg" -name '*.dump.cms' -mtime +"$KEEP" -delete || return 1
  find "$DIR/pg" -name '*.dump.cms.size' -mtime +"$KEEP" -delete || return 1
  find "$DIR/pg" -name '*.counts' -mtime +"$KEEP" -delete || return 1

  remote=false
  if [ -n "${BACKUP_REMOTE_URL:-}" ]; then
    mc mirror --quiet "$DIR/pg" "remote/$BACKUP_REMOTE_BUCKET/pg" >/dev/null || { log "mirror to the second provider failed (pg)"; return 1; }
    # --overwrite: a re-copied object (a partial copy replaced) reaches the second provider as a new version; the old
    # version stays locked until its retention ends. Without it mc reports the difference and leaves the partial copy.
    mc mirror --quiet --overwrite "$DIR/objects" "remote/$BACKUP_REMOTE_BUCKET/objects" >/dev/null \
      || { log "mirror to the second provider failed (objects)"; return 1; }
    # The isolated copy only counts when it cannot be deleted: the bucket's default retention (object lock,
    # compliance) must apply to what was just written. A bucket without it fails the backup.
    mc retention info "remote/$BACKUP_REMOTE_BUCKET/pg/$ts.dump.cms" 2>/dev/null | grep -q COMPLIANCE \
      || { log "second provider copy is not under compliance retention (object lock)"; return 1; }
    remote=true
    log "mirrored to the second provider, under compliance retention"
  fi

  cat > "$TMP/last-success.json" <<EOF || return 1
{"finished_at":"$(date -u +%FT%TZ)","pg_dump":"pg/$ts.dump.cms","pg_dump_bytes":$dump_bytes,"pg_dump_plain_bytes":$(cat "$dump.size"),"objects_new":$new,"objects_recopied":$recopied,"objects_total":$total,"objects_vanished":$vanished,"objects_changed":$changed,"remote":$remote}
EOF
  mv "$TMP/last-success.json" "$DIR/last-success.json" || return 1
  rm -rf "$TMP"
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
      # A shell of its own: set -e is ignored inside a function called from if or ||, so once is never called that way here.
      if sh "$0" once; then log "backup ok"; else
        echo "{\"failed_at\":\"$(date -u +%FT%TZ)\"}" > "$DIR/last-failure.json"
        log "backup failed"
      fi
    done ;;
  *) echo "usage: backup.sh once|loop" >&2; exit 2 ;;
esac
