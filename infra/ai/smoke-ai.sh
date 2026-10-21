#!/usr/bin/env bash
# فحص بيئة عامل التفريغ المحلي (ADR 0019، 0020؛ صورة workers/ai)، بنموذج faster-whisper tiny المثبّت وصوت اصطناعي:
#   infra/ai/smoke-ai.sh        (يحتاج infra/compose/.env؛ AI_SMOKE_EXTRA_COMPOSE لملف إضافي محلي)
# يثبت: الأوزان تُنزَّل بالبصمة وتُرفض إن خالفتها، والتحقق الثاني بلا شبكة، والعامل بتحصين عامل الوسائط وحدوده، وبلا
# خروج شبكي، والأوزان للقراءة فقط، والخدمة تتصل بالطابور، والمحرك يعمل في الحاوية المحصّنة نفسها.
# التفريغ طرفًا لطرف (حدث ← مسودتان مسجّلتان) في transcript-draft بوظيفة media e2e، لا هنا.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CDIR="$HERE/../compose"
M=faster-whisper-tiny
export AI_MODELS=$M AI_MODEL=$M
C=(docker compose -f "$CDIR/docker-compose.yml" ${AI_SMOKE_EXTRA_COMPOSE:+-f "$AI_SMOKE_EXTRA_COMPOSE"} --profile ai)
WORK="$(mktemp -d)"
cleanup() { "${C[@]}" rm -sf ai-worker ai-models >/dev/null 2>&1 || true; rm -rf "$WORK"; }
trap cleanup EXIT
fail() { echo "!! $*" >&2; "${C[@]}" logs --tail 30 ai-models ai-worker >&2 || true; exit 1; }
cfg="$("${C[@]}" config --format json)"
PROJECT="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["name"])' <<<"$cfg")"
VOL="${PROJECT}_ai-models"
PY_IMAGE="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["services"]["ai-models"]["image"])' <<<"$cfg")"

"${C[@]}" build -q ai-worker
"${C[@]}" up -d --wait ai-worker || fail "ai-worker did not start"
[ "$(docker inspect -f '{{.State.ExitCode}}' "$("${C[@]}" ps -aq ai-models)")" = 0 ] || fail "ai-models did not exit 0"
sha="$(awk -v m=$M '$1==m && $2 ~ /\/model\.bin$/{print $4}' "$HERE/models.lock")"
got="$(docker run --rm -v "$VOL:/m:ro" "$PY_IMAGE" sha256sum /m/$M/model.bin | cut -d' ' -f1)"
[ -n "$sha" ] && [ "$got" = "$sha" ] || fail "model on disk does not match the pinned sha256"
echo "weights fetched and pinned: ok"

# The second check needs no network: what is there and matches is not fetched again.
docker run --rm --network none --read-only -v "$VOL:/models" -v "$HERE:/ai:ro" "$PY_IMAGE" \
  python3 /ai/fetch_models.py --lock /ai/models.lock --dest /models --models $M --offline > "$WORK/offline" \
  || { cat "$WORK/offline"; fail "offline verification failed"; }
[ "$(grep -c "^present  $M " "$WORK/offline")" = "$(awk -v m=$M '$1==m' "$HERE/models.lock" | wc -l)" ] \
  || fail "offline check did not find every pinned file"
# A file that does not match its pin is refused and nothing unverified is kept: a local server (no network) serves
# zeros of the pinned size under the pinned sha256.
size="$(awk -v m=$M '$1==m && $2 ~ /\/model\.bin$/{print $3}' "$HERE/models.lock")"
mkdir -p "$WORK/srv" "$WORK/dest" && truncate -s "$size" "$WORK/srv/fake.bin" && chmod -R a+rwX "$WORK"
printf '%s %s/model.bin %s %s http://127.0.0.1:8000/fake.bin\n' $M $M "$size" "$sha" > "$WORK/bad.lock"
if docker run --rm --network none -v "$WORK:/w" -v "$HERE/fetch_models.py:/ai/fetch_models.py:ro" "$PY_IMAGE" sh -c \
     "python3 -m http.server -d /w/srv -b 127.0.0.1 8000 >/dev/null 2>&1 & sleep 1;
      python3 /ai/fetch_models.py --lock /w/bad.lock --dest /w/dest --models $M" > "$WORK/bad" 2>&1; then
  fail "a download not matching its pin was accepted"
fi
grep -q "FAILED   $M: sha256 does not match" "$WORK/bad" || { cat "$WORK/bad"; fail "pin mismatch not reported"; }
[ -z "$(find "$WORK/dest" -type f ! -name MANIFEST)" ] || fail "an unverified file was kept: $(find "$WORK/dest" -type f)"
[ ! -s "$WORK/dest/MANIFEST" ] || fail "the refused model is in MANIFEST"
echo "pin enforced, second check offline: ok"

id="$("${C[@]}" ps -q ai-worker)"
insp() { docker inspect -f "$1" "$id"; }
[ "$(insp '{{.Config.User}}')" = "10002:10002" ] || fail "not the non-root user"
[ "$(insp '{{.HostConfig.ReadonlyRootfs}}')" = true ] || fail "root filesystem writable"
[ "$(insp '{{.HostConfig.CapDrop}}')" = "[ALL]" ] || fail "capabilities not dropped"
insp '{{.HostConfig.SecurityOpt}}' | grep -q 'no-new-privileges:true' || fail "no-new-privileges missing"
[ "$(insp '{{.HostConfig.PidsLimit}}')" = 256 ] || fail "pids limit"
[ "$(insp '{{.HostConfig.Memory}}')" -gt 0 ] || fail "no memory limit"
[ "$(insp '{{.HostConfig.NanoCpus}}')" -gt 0 ] || fail "no cpu limit"
nets="$(insp '{{range $k, $v := .NetworkSettings.Networks}}{{$k}}={{$v.IPAddress}} {{end}}')"
[ "$nets" = "${PROJECT}_media=172.30.251.3 " ] || fail "networks: $nets (want media only at 172.30.251.3)"
[ "$(docker network inspect -f '{{.Internal}}' "${PROJECT}_media")" = true ] || fail "media network is not internal"
py() { "${C[@]}" exec -T ai-worker python -c "$1" >/dev/null 2>&1; }
if py "import socket; socket.create_connection(('1.1.1.1', 443), 3)"; then fail "ai-worker reached the internet"; fi
if py "import socket; socket.getaddrinfo('huggingface.co', 443)"; then fail "ai-worker resolves external names"; fi
if py "open('/models/x', 'w')"; then fail "models volume writable by the worker"; fi
echo "worker hardened, limited, no egress, models read-only: ok"

# The service is up with transcription off by default, and its consumer group is on media:events (Redis on media).
"${C[@]}" logs ai-worker | grep -q 'ai worker started transcript=off' || fail "service did not start with transcription off"
set -a; . "$CDIR/.env"; set +a
export REDISCLI_AUTH="$REDIS_PASSWORD"
for _ in $(seq 1 15); do
  "${C[@]}" exec -T -e REDISCLI_AUTH redis redis-cli --no-auth-warning XINFO GROUPS media:events 2>/dev/null | grep -qx ai && break
  sleep 1
done
"${C[@]}" exec -T -e REDISCLI_AUTH redis redis-cli --no-auth-warning XINFO GROUPS media:events | grep -qx ai \
  || fail "consumer group ai not on media:events"
echo "service connected to the queue (group ai), transcription off: ok"

# The engine in the same hardened service on 3 s of synthetic tone (no speech, no material): a WebVTT draft comes out.
python3 - "$WORK/tone.wav" <<'PY'
import math, struct, sys, wave
w = wave.open(sys.argv[1], "wb"); w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000)
w.writeframes(b"".join(struct.pack("<h", int(8000 * math.sin(2 * math.pi * 440 * i / 16000))) for i in range(48000)))
w.close()
PY
chmod 0644 "$WORK/tone.wav"
docker cp -q "$WORK/tone.wav" "$id:/scratch/tone.wav"
"${C[@]}" exec -T ai-worker python -m ai_worker transcribe /scratch/tone.wav > "$WORK/out" 2> "$WORK/err" \
  || { tail -20 "$WORK/err"; fail "transcription failed"; }
head -1 "$WORK/out" | grep -q '^WEBVTT' || { cat "$WORK/out"; fail "no WebVTT output"; }
echo "engine runs in the hardened worker: ok"
echo "ai runtime smoke: ok"
