#!/usr/bin/env bash
# الأصول التي تحقق منها الخادم قبل عامل الوسائط (ADR 0092)، على الخادم من هذا المجلد بعد up:
#   ./backfill-media.sh          # دورة واحدة من الموزّع: يضع على media:events أصل فيديو متحققًا بلا نسخة خفيفة إن كان العامل
#                                # فارغًا والقرص يتسع، ويطبع الأعداد وحدها
#   ./backfill-media.sh --wait   # يكرر الدورة كل 15 ث حتى لا يبقى أصل ينتظر ولا مهمة جارية (أو حتى ساعتين)
# الطريق الداخلي نفسه: حدث upload.original_received على طابور العامل، والعامل يجد الجلسة verified فيسلك مسار الاستئناف
# (يطابق بصمة الأصل المسجلة ثم يبني النسخة الخفيفة والمصغّرات ويسجّلها عبر /internal/media). خدمة media-feeder تفعل الشيء
# نفسه كل 10 ث؛ هذا للتشغيل اليدوي والمتابعة. متكرر بأمان: الجلسة لا توضع مرتين (media:feed:<id>)، وما عزله العامل في
# media:dead لا يعاد، والمعالَج لم يعد مؤهلًا. السجل أعداد فقط: لا معرّف ولا عنوان ولا اسم ملف.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
C=(docker compose -f docker-compose.preview.yml)
once() { "${C[@]}" run --rm --no-deps -T media-feeder --once; }
[ "${1:-}" = --wait ] || { once; exit 0; }
deadline=$((SECONDS + 7200))
while :; do
  line="$(once)"
  echo "$line"
  if python3 -c 'import json, sys; s = json.loads(sys.argv[1]); sys.exit(0 if s["eligible"] == s["waiting"] == s["in_progress"] == 0 else 1)' "$line"; then
    echo "backfill done"; exit 0
  fi
  [ "$SECONDS" -lt "$deadline" ] || { echo "backfill still running after 2 h: see the counts above" >&2; exit 1; }
  sleep 15
done
