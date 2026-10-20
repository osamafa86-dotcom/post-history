#!/usr/bin/env bash
# لوحة نصية بالعربية للمشرف الميداني (ADR 0013). بصلاحية root على المضيف:
#   sudo infra/observability/status.sh
# تعرض: صحة الخدمات (healthcheck.sh)، والرفوعات الجارية وحصيلة آخر 24 ساعة، وطابور الوسائط، وآخر نسخة احتياطية،
# والقرص. أعداد وحالات فقط: لا أسماء ملفات ولا أشخاص ولا مواقع.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP="$(cd "$HERE/../.." && pwd)"
T="${TRIAL_SH:-$APP/infra/field-trial/trial.sh}"
ENV_FILE="${TRIAL_ENV_FILE:-/run/post-history/trial.env}"
BACKUP_DIR="$(sed -n 's/^BACKUP_DIR=//p' "$ENV_FILE" 2>/dev/null | tail -1)"; BACKUP_DIR="${BACKUP_DIR:-/srv/post-history/backups}"
sql() { "$T" exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -XAtq -F " " -c "$1"' sh "$1" 2>/dev/null; }
rcli() { "$T" exec -T redis sh -c 'REDISCLI_AUTH="$REDIS_PASSWORD" redis-cli "$@"' sh "$@" 2>/dev/null; }
field() { awk -v k="$1" 'NR%2==1{key=$0} NR%2==0 && key==k{print $0; exit}'; }

echo "حالة بيئة التجربة — $(date -u '+%Y-%m-%d %H:%M') UTC"
echo
echo "■ الخدمات"
health="$(TRIAL_SH="$T" "$HERE/healthcheck.sh" 2>/dev/null)"; hrc=$?
fails="$(grep -c '^FAIL' <<<"$health")"
if [ "$hrc" = 0 ]; then echo "  ✓ كل الفحوص سليمة ($(grep -c '^ok' <<<"$health"))"
else
  echo "  ✗ فحوص فاشلة: $fails"
  sed -n 's/^FAIL  \([^:]*:[^:]*\).*/    - \1/p' <<<"$health"
fi
echo
echo "■ الرفوعات"
counts="$(sql "select state, count(*) from upload_sessions where state in ('created','in_progress') or updated_at > now() - interval '24 hours' group by state")"
if [ -z "$counts" ]; then echo "  (تعذّرت قراءة القاعدة أو لا رفوعات)"; else
  n() { v="$(awk -v s="$1" '$1==s{print $2}' <<<"$counts")"; echo "${v:-0}"; }
  echo "  جارية الآن:            $(n in_progress)"
  echo "  أُنشئت ولم تبدأ:        $(n created)"
  echo "  اكتملت (24 ساعة):       $(( $(n completed) + $(n verified) + $(n deduplicated) ))"
  echo "  فشلت (24 ساعة):         $(n failed)"
fi
echo
echo "■ طابور الوسائط"
groups="$(rcli XINFO GROUPS media:events)"
if [ -z "$groups" ] || grep -q ERR <<<"$groups"; then echo "  لا طابور بعد"; else
  # كل مجموعة وحدها: media لعامل الوسائط، وai لعامل التفريغ إن وُجدت.
  num() { awk -v g="$1" -v k="$2" 'NR%2==1{key=$0} NR%2==0{if(key=="name")cur=$0; else if(cur==g && key==k){print $0+0; f=1; exit}} END{if(!f)print 0}' <<<"$groups"; }
  echo "  بانتظار المعالجة:      $(num media lag)"
  echo "  قيد المعالجة:          $(num media pending)"
  echo "  عمّال متصلون:          $(num media consumers)"
  if grep -qx ai <<<"$groups"; then
    echo "  التفريغ بانتظار:       $(num ai lag)، قيد المعالجة $(num ai pending)، عمّال $(num ai consumers)"
  fi
fi
dead="$(rcli XLEN media:dead | tr -dc 0-9)"; echo "  معزولة (media:dead):   ${dead:-0}"
echo
echo "■ النسخ الاحتياطي"
last="$BACKUP_DIR/last-success.json"
if [ -f "$last" ]; then
  age_h=$(( ($(date +%s) - $(stat -c %Y "$last")) / 3600 ))
  echo "  آخر نسخة ناجحة:        $(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["finished_at"])' "$last" 2>/dev/null) (قبل ${age_h} ساعة)"
  echo "  الكائنات المنسوخة:      $(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["objects_total"])' "$last" 2>/dev/null)"
  echo "  لدى المزوّد الثاني:     $(python3 -c 'import json,sys; print("نعم" if json.load(open(sys.argv[1]))["remote"] else "لا")' "$last" 2>/dev/null)"
else echo "  ✗ لا نسخة ناجحة بعد"; fi
[ -f "$BACKUP_DIR/last-failure.json" ] && [ "$BACKUP_DIR/last-failure.json" -nt "$last" ] && echo "  ✗ فشلت نسخة بعد آخر نجاح"
echo
echo "■ القرص"
for p in / /var/lib/docker "$BACKUP_DIR"; do
  [ -d "$p" ] && printf '  %-28s %s مستخدم\n' "$p" "$(df --output=pcent "$p" | tail -1 | tr -d ' ')"
done
exit "$hrc"
