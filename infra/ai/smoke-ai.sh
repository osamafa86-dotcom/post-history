#!/usr/bin/env bash
# فحص بيئة عامل الذكاء الاصطناعي المحلي (ADR 0019)، بنموذج صغير (ggml-tiny) وصوت اصطناعي:
#   infra/ai/smoke-ai.sh        (يحتاج infra/compose/.env؛ AI_SMOKE_EXTRA_COMPOSE لملف إضافي محلي)
# يثبت: الأوزان تُنزَّل بالبصمة وتُرفض إن خالفتها، والتحقق الثاني بلا شبكة، والعامل بتحصين عامل الوسائط وحدوده، وبلا
# خروج شبكي، والأوزان للقراءة فقط، وwhisper-cli يعمل في الحاوية المحصّنة نفسها.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CDIR="$HERE/../compose"
export AI_MODELS=ggml-tiny AI_MODEL=ggml-tiny
C=(docker compose -f "$CDIR/docker-compose.yml" ${AI_SMOKE_EXTRA_COMPOSE:+-f "$AI_SMOKE_EXTRA_COMPOSE"} --profile ai)
WORK="$(mktemp -d)"
cleanup() { "${C[@]}" rm -sf ai-worker ai-models >/dev/null 2>&1 || true; rm -rf "$WORK"; }
trap cleanup EXIT
fail() { echo "!! $*" >&2; "${C[@]}" logs --tail 30 ai-models ai-worker >&2 || true; exit 1; }
PROJECT="$("${C[@]}" config --format json | python3 -c 'import json,sys; print(json.load(sys.stdin)["name"])')"
VOL="${PROJECT}_ai-models"
PY_IMAGE="$("${C[@]}" config --format json | python3 -c 'import json,sys; print(json.load(sys.stdin)["services"]["ai-models"]["image"])')"

"${C[@]}" build -q ai-worker
"${C[@]}" up -d --wait ai-worker || fail "ai-worker did not start"
[ "$(docker inspect -f '{{.State.ExitCode}}' "$("${C[@]}" ps -aq ai-models)")" = 0 ] || fail "ai-models did not exit 0"
sha="$(awk '$1=="ggml-tiny"{print $3}' "$HERE/models.lock")"
got="$(docker run --rm -v "$VOL:/m:ro" "$PY_IMAGE" sha256sum /m/ggml-tiny.bin | cut -d' ' -f1)"
[ "$got" = "$sha" ] || fail "model on disk does not match the pinned sha256"
echo "weights fetched and pinned: ok"

# The second check needs no network: what is there and matches is not fetched again.
docker run --rm --network none --read-only -v "$VOL:/models" -v "$HERE:/ai:ro" "$PY_IMAGE" \
  python3 /ai/fetch_models.py --lock /ai/models.lock --dest /models --models ggml-tiny --offline > "$WORK/offline" \
  || { cat "$WORK/offline"; fail "offline verification failed"; }
grep -q '^present  ggml-tiny' "$WORK/offline" || fail "offline check did not find the pinned model"
# A file that does not match its pin is refused and nothing unverified is kept: a local server (no network) serves
# zeros of the pinned size under the pinned sha256.
size="$(awk '$1=="ggml-tiny"{print $2}' "$HERE/models.lock")"
mkdir -p "$WORK/srv" "$WORK/dest" && truncate -s "$size" "$WORK/srv/fake.bin" && chmod -R a+rwX "$WORK"
printf 'ggml-tiny %s %s http://127.0.0.1:8000/fake.bin\n' "$size" "$sha" > "$WORK/bad.lock"
if docker run --rm --network none -v "$WORK:/w" -v "$HERE/fetch_models.py:/ai/fetch_models.py:ro" "$PY_IMAGE" sh -c \
     'python3 -m http.server -d /w/srv -b 127.0.0.1 8000 >/dev/null 2>&1 & sleep 1;
      python3 /ai/fetch_models.py --lock /w/bad.lock --dest /w/dest --models ggml-tiny' > "$WORK/bad" 2>&1; then
  fail "a download not matching its pin was accepted"
fi
grep -q 'FAILED   ggml-tiny: sha256 does not match' "$WORK/bad" || { cat "$WORK/bad"; fail "pin mismatch not reported"; }
[ -z "$(ls -A "$WORK/dest" | grep -v '^MANIFEST$')" ] || fail "an unverified file was kept: $(ls "$WORK/dest")"
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
nets="$(insp '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}')"
[ "$nets" = "${PROJECT}_media " ] || fail "networks: $nets (want media only)"
[ "$(docker network inspect -f '{{.Internal}}' "${PROJECT}_media")" = true ] || fail "media network is not internal"
if "${C[@]}" exec -T ai-worker bash -c 'exec 3<>/dev/tcp/1.1.1.1/443' 2>/dev/null; then fail "ai-worker reached the internet"; fi
if "${C[@]}" exec -T ai-worker getent hosts huggingface.co >/dev/null 2>&1; then fail "ai-worker resolves external names"; fi
if "${C[@]}" exec -T ai-worker touch /models/x 2>/dev/null; then fail "models volume writable by the worker"; fi
echo "worker hardened, limited, no egress, models read-only: ok"

# whisper-cli in the same hardened service on 3 s of synthetic tone (no speech, no material).
python3 - "$WORK/tone.wav" <<'PY'
import math, struct, sys, wave
w = wave.open(sys.argv[1], "wb"); w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000)
w.writeframes(b"".join(struct.pack("<h", int(8000 * math.sin(2 * math.pi * 440 * i / 16000))) for i in range(48000)))
w.close()
PY
chmod 0644 "$WORK/tone.wav"
docker cp -q "$WORK/tone.wav" "$id:/scratch/tone.wav"
"${C[@]}" exec -T ai-worker whisper-cli -m /models/ggml-tiny.bin -f /scratch/tone.wav -t 2 -nt > "$WORK/out" 2>&1 \
  || { tail -20 "$WORK/out"; fail "whisper-cli failed"; }
echo "whisper-cli runs in the hardened worker: ok"
echo "ai runtime smoke: ok"
