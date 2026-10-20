#!/usr/bin/env bash
# تمرين الاستعادة (ADR 0013): من آخر نسخة في BACKUP_DIR إلى Postgres مؤقت، ومقارنة بما كان عند النسخ وبما هو حي.
#   infra/backup/restore-drill.sh --key /path/recipient.key --out docs/measurements/ops/<date>-restore-drill.json
# المفتاح الخاص غير متصل: يُحضَر للتمرين ثم يُزال. يقيس: زمن فك التشفير والاستعادة، الجداول وصفوفها مقابل
# العدّ عند النسخ (المستعاد >= المعدود)، وعينة كائنات تُفك وتُطابق بصمتها مع الكائن الحي. النتيجة بمخطط
# contracts/schemas/measurement.json.
# البيئة: COMPOSE (أمر compose بملفاته، الافتراضي compose المحلي)، BACKUP_DIR على المضيف، SAMPLE (20)،
# DRILL_ENV (local أو اسم المضيف؛ يدخل في النتيجة)، DRILL_TMP (مجلد العمل، الافتراضي /dev/shm)، وملف البيئة نفسه لـ
# compose (S3_* و POSTGRES_*).
# النتيجة partial أو fail ولا تكون pass أبدًا: معيار recovery في الخطة يشترط الاستعادة من النسخة المعزولة لدى المزوّد
# الثاني، وفقدًا ≤ 15 دقيقة، واستعادة ≤ 4 ساعات، والتمرين يقرأ BACKUP_DIR على المضيف ولا يقيس فاصل النسخ.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KEY="" OUT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --key) KEY="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    *) echo "usage: $0 --key FILE --out FILE" >&2; exit 2 ;;
  esac
done
[ -r "$KEY" ] && [ -n "$OUT" ] || { echo "usage: $0 --key FILE --out FILE" >&2; exit 2; }
read -r -a COMPOSE <<<"${COMPOSE:-docker compose -f $HERE/../compose/docker-compose.yml}"
BACKUP_DIR="${BACKUP_DIR:?host directory with the backups}"
SAMPLE="${SAMPLE:-20}"
NAME="drill-$$"
# المفتاح الخاص والتفريغ المفكوك على tmpfs، فلا يبقى نص القاعدة الصريح في كتل حرة على قرص المضيف.
WORK="$(mktemp -d -p "${DRILL_TMP:-/dev/shm}")"
cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; rm -rf "$WORK"; }
trap cleanup EXIT

utc() { date -u +%FT%TZ; }
started_at="$(utc)"
dump="$(ls -1 "$BACKUP_DIR"/pg/*.dump.cms | sort | tail -1)"
ts="$(basename "$dump" .dump.cms)"
dump_epoch="$(date -u -d "${ts:0:4}-${ts:4:2}-${ts:6:2}T${ts:9:2}:${ts:11:2}:${ts:13:2}Z" +%s)"
# The private key stays 0600 in a 0700 directory owned by the caller; the helper containers run as the caller's
# uid (the backup service drops every capability, so even uid 0 cannot read a file it does not own).
install -m 600 "$KEY" "$WORK/key.pem"
ME="$(id -u):$(id -g)"

# فك التشفير بصورة النسخ نفسها (openssl فيها)، داخل مجلد عمل مؤقت يُحذف في النهاية.
t0=$(date +%s.%N)
"${COMPOSE[@]}" run --rm --no-deps -T --user "$ME" -v "$BACKUP_DIR:/backups:ro" -v "$WORK:/work" --entrypoint sh backup -c \
  "openssl cms -decrypt -binary -inform DER -inkey /work/key.pem -in /backups/pg/$ts.dump.cms -out /work/db.dump"
t1=$(date +%s.%N)

pw="$(openssl rand -hex 16)"
docker run -d --name "$NAME" -e POSTGRES_PASSWORD="$pw" -e POSTGRES_DB=drill -v "$WORK:/work:ro" postgres:16-alpine >/dev/null
for _ in $(seq 1 60); do docker exec "$NAME" pg_isready -U postgres -d drill >/dev/null 2>&1 && break; sleep 1; done
sleep 2
# A failed restore is a drill result, not a crash: the errors are counted and the comparison still runs.
restore_errors=0
if ! docker exec "$NAME" pg_restore --no-owner --no-privileges -U postgres -d drill /work/db.dump 2> "$WORK/restore.err"; then
  restore_errors="$(sed -n 's/.*errors ignored on restore: \([0-9]*\).*/\1/p' "$WORK/restore.err")"
  restore_errors="${restore_errors:-1}"
  grep 'pg_restore: error' "$WORK/restore.err" | head -5 >&2
fi
t2=$(date +%s.%N)

tables=0 mismatched=0 missing=0
while read -r table counted; do
  [ -n "$table" ] || continue
  tables=$((tables + 1))
  got="$(docker exec "$NAME" psql -U postgres -d drill -XAtq -c "select count(*) from public.\"$table\"" 2>/dev/null || echo missing)"
  if [ "$got" = missing ]; then missing=$((missing + 1)); echo "missing table: $table" >&2
  elif [ "$got" -lt "$counted" ]; then mismatched=$((mismatched + 1)); echo "fewer rows: $table $got < $counted" >&2; fi
done < "$BACKUP_DIR/pg/$ts.counts"

# عينة كائنات: تُفك وتُقارن بصمتها بالكائن الحي (عبر مستخدم النسخ للقراءة فقط).
find "$BACKUP_DIR/objects" -name '*.cms' -type f | shuf -n "$SAMPLE" > "$WORK/sample" || true
objects=0 obj_mismatch=0
while IFS= read -r f; do
  rel="${f#"$BACKUP_DIR"/objects/}"; rel="${rel%.cms}"
  sums="$("${COMPOSE[@]}" run --rm --no-deps -T --user "$ME" -v "$BACKUP_DIR:/backups:ro" -v "$WORK:/work:ro" --entrypoint sh backup -c '
    proto="${S3_ENDPOINT%%://*}"; host="${S3_ENDPOINT#*://}"
    export MC_HOST_src="${proto}://${S3_BACKUP_ACCESS_KEY}:${S3_BACKUP_SECRET_KEY}@${host}"
    a=$(openssl cms -decrypt -binary -inform DER -inkey /work/key.pem -in "/backups/objects/$1.cms" | sha256sum | cut -d" " -f1)
    b=$(mc cat "src/$1" 2>/dev/null | sha256sum | cut -d" " -f1)
    echo "$a $b"' sh "$rel" </dev/null)"   # compose run would otherwise eat the rest of the sample list
  objects=$((objects + 1))
  [ "${sums%% *}" = "${sums##* }" ] || { obj_mismatch=$((obj_mismatch + 1)); echo "object mismatch: $rel" >&2; }
done < "$WORK/sample"

ended_at="$(utc)"
calc() { awk "BEGIN { printf \"%.2f\", $1 }"; }
decrypt_s=$(calc "$t1 - $t0"); restore_s=$(calc "$t2 - $t1")
rpo_h=$(calc "($(date -u +%s) - $dump_epoch) / 3600")
result=pass
[ "$tables" -gt 0 ] && [ "$restore_errors" -eq 0 ] && [ "$mismatched" -eq 0 ] && [ "$missing" -eq 0 ] \
  && [ "$obj_mismatch" -eq 0 ] || result=fail
mkdir -p "$(dirname "$OUT")"
cat > "$OUT" <<EOF
{
  "schema_version": 1,
  "tool": "other",
  "role": "infra",
  "test_name": "recovery",
  "started_at": "$started_at",
  "ended_at": "$ended_at",
  "result": "$( [ "$result" = pass ] && echo partial || echo fail)",
  "device": {"platform": "server", "model": "${DRILL_ENV:-local} docker compose"},
  "metrics": {
    "dump_bytes_encrypted": $(wc -c < "$dump"),
    "decrypt_s": $decrypt_s,
    "pg_restore_s": $restore_s,
    "pg_restore_within_4h": $(awk "BEGIN { print ($restore_s <= 14400) ? \"true\" : \"false\" }"),
    "backup_age_h": $rpo_h,
    "pg_restore_errors": $restore_errors,
    "tables_compared": $tables,
    "tables_missing": $missing,
    "tables_fewer_rows": $mismatched,
    "objects_sampled": $objects,
    "objects_mismatched": $obj_mismatch,
    "drill_passed": $( [ "$result" = pass ] && echo true || echo false )
  },
  "notes": "ADR 0013 restore drill: latest encrypted pg_dump decrypted with the offline recipient key, restored into a throwaway postgres:16-alpine, row counts compared with the counts taken at backup time (restored >= counted), and a sample of encrypted objects decrypted and compared by SHA-256 with the live objects. Restored >= counted: rows added between the count and the dump are allowed, so extra or duplicated rows are not checked. Never pass: restoring from the isolated copy at the second provider, the backup interval (loss <= 15 min) and a full-size restore time are not measured here. Environment: ${DRILL_ENV:-local}."
}
EOF
echo "restore drill: $result, recorded as $( [ "$result" = pass ] && echo partial || echo fail) (restore_errors=$restore_errors tables=$tables missing=$missing fewer_rows=$mismatched objects=$objects mismatched=$obj_mismatch)"
[ "$result" = pass ]
