#!/usr/bin/env bash
# قياس القرص والذاكرة والزمن لنموذج المسار المحلي في العامل المحصّن نفسه (ADR 0019)، على كلام اصطناعي (espeak-ng)
# لا على عينات المراسلين:
#   infra/ai/measure.sh ggml-large-v3-turbo-q5_0 docs/measurements/infra/$(date +%F)-ai-worker-<model>-cpu.json
# البيئة: AI_WORKER_CPUS (2) وAI_WORKER_MEM_LIMIT (4g) كما في compose، AI_MEASURE_EXTRA_COMPOSE لملف محلي إضافي،
# AI_MEASURE_TTS_ARGS لوسائط docker run إضافية لحاوية espeak-ng.
set -euo pipefail
MODEL="${1:?model name from models.lock}" OUT="${2:?output json}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CDIR="$HERE/../compose"
export AI_MODELS="$MODEL" AI_MODEL="$MODEL"
C=(docker compose -f "$CDIR/docker-compose.yml" ${AI_MEASURE_EXTRA_COMPOSE:+-f "$AI_MEASURE_EXTRA_COMPOSE"} --profile ai)
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
cfg="$("${C[@]}" config --format json)"
PROJECT="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["name"])' <<<"$cfg")"
read -r CPUS MEM <<<"$(python3 -c 'import json,sys; s=json.load(sys.stdin)["services"]["ai-worker"]; print(s["cpus"], s["mem_limit"])' <<<"$cfg")"
started_at="$(date -u +%FT%TZ)"

"${C[@]}" build -q ai-worker
# حاوية جديدة: ذروة cgroup تبدأ من الصفر.
"${C[@]}" up -d --wait --force-recreate ai-worker
id="$("${C[@]}" ps -q ai-worker)"

# 60 ثانية تقريبًا من كلام عربي اصطناعي، 16 kHz أحادي (ما يقرؤه whisper-cli).
TEXT="نشرة تجريبية لقياس أداء التفريغ المحلي. هذا نص اصطناعي لا يمثل أي مادة حقيقية. \
تتحدث النشرة عن الطقس في المدن الساحلية، وعن حركة الأسواق صباح اليوم، وعن موعد افتتاح المكتبة العامة. \
يتكرر النص مرات عدة حتى يبلغ طوله نحو دقيقة واحدة، كي يكون القياس على كلام لا على صمت."
chmod 0777 "$WORK"
# shellcheck disable=SC2086  # AI_MEASURE_TTS_ARGS: وسائط docker run إضافية لحاوية الكلام (وكيل شبكة محلي مثلًا)
docker run --rm ${AI_MEASURE_TTS_ARGS:-} -v "$WORK:/w" -e TEXT="$TEXT" debian:trixie-slim@sha256:a29215f6a35e51e22adffa17f89e9d2ef06214e64a2bad10d765c46aea49f11f sh -c '
  apt-get update -q >/dev/null && apt-get install -y -q --no-install-recommends espeak-ng >/dev/null &&
  for i in 1 2; do printf "%s " "$TEXT"; done > /w/text.txt && espeak-ng -v ar -s 150 -f /w/text.txt -w /w/raw.wav'
docker run --rm --network none -v "$WORK:/w" --entrypoint /ffmpeg \
  mwader/static-ffmpeg:8.0.1@sha256:252705ff88532fa338e7065c21792756552f8fe7c212f84bc503d3c340689594 \
  -hide_banner -loglevel error -y -i /w/raw.wav -ar 16000 -ac 1 -c:a pcm_s16le /w/speech.wav
chmod 0644 "$WORK/speech.wav"
audio_s="$(python3 -c 'import wave,sys; w=wave.open(sys.argv[1]); print(round(w.getnframes()/w.getframerate(),2))' "$WORK/speech.wav")"

# التشغيل داخل الحاوية المحصّنة الجارية (التحصين والحدود والشبكة الداخلية)، والذروة من cgroup الحاوية.
threads="$(python3 -c "import math; print(max(1, math.floor(float('$CPUS'))))")"
docker cp -q "$WORK/speech.wav" "$id:/scratch/speech.wav"
# الذروة من المضيف: docker stats كل نصف ثانية أثناء التشغيل (memory.peak لا يُقرأ داخل كل حاوية).
( while :; do docker stats --no-stream --format '{{.MemUsage}}' "$id" 2>/dev/null | cut -d/ -f1; sleep 0.5; done ) > "$WORK/mem" &
poll=$!
"${C[@]}" exec -T ai-worker sh -c "
  s=\$(date +%s.%N); whisper-cli -m /models/$MODEL.bin -f /scratch/speech.wav -l ar -t $threads -nt > /tmp/out.txt 2>/tmp/err.txt; rc=\$?
  e=\$(date +%s.%N); echo \"rc=\$rc wall=\$(echo \"\$e - \$s\" | awk '{print \$1-\$3}') words=\$(wc -w < /tmp/out.txt)\"
" > "$WORK/run" 2>&1
kill "$poll" 2>/dev/null || true
peak="$(python3 - "$WORK/mem" <<'PY'
import re, sys
mult = {"B": 1, "KiB": 1024, "MiB": 1024**2, "GiB": 1024**3}
vals = [float(m.group(1)) * mult[m.group(2)] for l in open(sys.argv[1]) for m in [re.match(r"\s*([\d.]+)(B|KiB|MiB|GiB)", l)] if m]
print(int(max(vals)) if vals else 0)
PY
)"
cat "$WORK/run"
eval "$(grep -o 'rc=[0-9]* wall=[0-9.]* words=[0-9]*' "$WORK/run")"
model_bytes="$(awk -v m="$MODEL" '$1==m{s+=$3} END{print s}' "$HERE/models.lock")"
model_sha="$(awk -v m="$MODEL" '$1==m{print $4; exit}' "$HERE/models.lock")"
image_bytes="$(docker image inspect -f '{{.Size}}' "$("${C[@]}" config --images | grep ai-worker | head -1)")"
commit="$(sed -n 's/^ARG WHISPER_COMMIT=//p' "$HERE/runtime/Dockerfile")"
cpu_model="$(awk -F': ' '/model name/{print $2; exit}' /proc/cpuinfo)"
mkdir -p "$(dirname "$OUT")"
python3 - "$OUT" <<PY
import json, sys
rc, wall, audio = int("$rc"), float("$wall"), float("$audio_s")
doc = {
  "schema_version": 1, "tool": "other", "role": "infra", "started_at": "$started_at",
  "ended_at": __import__("datetime").datetime.now(__import__("datetime").timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
  "result": "info" if rc == 0 else "fail",
  "device": {"platform": "server", "model": "$cpu_model, ai-worker cpus=$CPUS mem_limit=$MEM (docker compose)"},
  "metrics": {
    "model": "$MODEL", "model_sha256": "$model_sha", "model_bytes": int("$model_bytes"),
    "runtime_image_bytes": int("$image_bytes"), "disk_total_bytes": int("$model_bytes") + int("$image_bytes"),
    "whisper_cpp_commit": "$commit", "backend": "cpu", "threads": int("$threads"),
    "audio_seconds": audio, "wall_seconds": round(wall, 2), "real_time_factor": round(wall / audio, 3) if audio else None,
    "peak_memory_bytes": int("$peak"), "output_words": int("$words"), "exit_code": rc,
  },
  "notes": "ADR 0019. whisper-cli in the hardened ai-worker service (read-only root, no capabilities, internal network, "
           "compose limits), on about a minute of synthetic Arabic speech from espeak-ng (no real material). Peak memory is the "
           "highest container usage sampled by docker stats every 0.5 s. Accuracy is not measured here (synthetic voice); that belongs to tools/asr-bench.",
}
json.dump(doc, open(sys.argv[1], "w"), indent=2, ensure_ascii=False); open(sys.argv[1], "a").write("\n")
PY
cat "$OUT"
[ "$rc" = 0 ]
