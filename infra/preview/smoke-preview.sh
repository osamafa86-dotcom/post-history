#!/usr/bin/env bash
# دخان المعاينة الخفيفة (ADR 0023، 0092) على صور CI المحمّلة (post-history-preview-{api,web,media,render}:latest)، بلا بناء:
#   infra/preview/smoke-preview.sh [--json FILE] [--media-json DIR]   # MEDIA_PROFILES="1080p 2160p" لقياس العامل (1080p افتراضيًا)
# يثبت: compose يقوم بالصورتين وحدهما وبلا منفذ على المضيف، و"web" وحده على deploy_default (باسم lib-web) والخادم لا يُصل
# منها، و/health 200، والدخول عبر الويب بحساب تجريبي يرى مواده الاصطناعية، وX-Robots-Tag وشريط «معاينة»، والرفع من
# الحاسوب كما يفعله المتصفح (جلسة رفع ورمز ingest عبر الـBFF، ثم tus عبر الحافة والبوابة، وقطع واستئناف من إزاحة tusd،
# والجلسة verified) لمقطع اصطناعي بوسوم موقع وجهاز مزروعة، وعامل الوسائط (ADR 0092: تحصينه وعزله وأعلامه المطفأة، وحارس القرص
# يمنع المهمة ويبقيها معلّقة، وbackfill-media.sh يعطيه الأصل المتحقق فيصنع نسخة خفيفة ومصغّرة متحققتين ويعيد الدورة بلا أثر،
# ورابط النسخة الموقّع من /v1 يُقرأ عبر الحافة video/mp4 بلا الوسوم، والمعدّل والمقطوع والمكتوب مرفوض، والصورة لا تصله،
# وسجله بلا عنوان ولا اسم ملف ولا موقع ولا جهاز، ومستخدمه في MinIO لا يقرأ .info ولا يكتب الرفع ولا يحذف)، و/v1 العلني كما يصله بناء iOS التجريبي (ADR 0077: دخول وتحدٍّ وتسجيل مرفوض بشهادة مزيفة، ونقاط الـBFF
# وحده لا تصل: رمز الويب 404 وعنوان العميل المنتحل لا يغيّر سلة حد المعدل، وبلا /internal)، والخادم على شبكة العلنية مع الحافة وحدها
# لا على deploy_default، ومجموع حدود الذاكرة ≤ 6952 MB بلا swap واستهلاكها الفعلي (docker stats) تحته، ولا سر في السجلات.
# ونسخ قالب «مواد متداولة» (ADR 0091، ملحق ADR 0092): تحصين media-render وحدوده وعنوانه ومستخدمه في MinIO، و--add-render،
# ثم مادة مقبولة تحريريًا بمقطعها الاصطناعي ونسختها الخفيفة: حارس القرص لكل نسخة (حجم الأصل + 1 GiB فوق الحد الأدنى)، ونسخة
# عمودية بالوسم وبلا مكان تصير ready ويُقرأ ملفها برابط موقّع عبر الحافة video/mp4 بمقاس 1080×1920 وBT.709 بلا الوسوم المزروعة
# ولا العنوان، وسطر لا يتّسع يصير failed بـ title_overflow، وسجل media-render بلا عنوان ولا مكان.
# ومع --media-json: ذروة ذاكرة العامل وزمن المعالج والزمن الكلي والقرص لمقطع اصطناعي 60 ث لكل ملف تعريف (ملف قياس لكل منها)،
# ومثلها لـ media-render على نسخة عمودية من المقطع نفسه، وللنسختين على المقطع القصير.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
JSON="" MEDIA_OUT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --json) JSON="$2"; shift 2 ;;
    --media-json) MEDIA_OUT="$2"; shift 2 ;;
    *) echo "usage: $0 [--json FILE] [--media-json DIR]" >&2; exit 2 ;;
  esac
done
LIMIT_MB=6952
C=(docker compose -f "$HERE/docker-compose.preview.yml")
created_env=0 created_net=0
work="$(mktemp -d)"
chmod 755 "$work"
cleanup() {
  rm -f "$work/sampling"
  rm -rf "$work"
  [ "${KEEP:-0}" = 1 ] && return
  "${C[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
  [ "$created_env" = 1 ] && rm -rf "$HERE/.env" "$HERE/tls"
  docker rm -f ph-preview-decoy >/dev/null 2>&1 || true
  [ "$created_net" = 1 ] && docker network rm deploy_default >/dev/null 2>&1 || true
}
trap cleanup EXIT
fail() { echo "!! $*" >&2; "${C[@]}" logs --tail 40 >&2 || true; exit 1; }

docker image inspect post-history-preview-api:latest post-history-preview-web:latest post-history-preview-media:latest \
  post-history-preview-render:latest >/dev/null \
  || fail "load the CI images first"
docker network inspect deploy_default >/dev/null 2>&1 || { docker network create deploy_default >/dev/null; created_net=1; }
if [ ! -e "$HERE/.env" ]; then PREVIEW_DOMAIN=preview.localhost "$HERE/gen-env.sh" >/dev/null; created_env=1; fi
[ "$(stat -c %a "$HERE/.env")" = 600 ] || fail ".env is not 0600"
val() { sed -n "s/^$1=//p" "$HERE/.env" | tail -1; }
DOMAIN="$(val PREVIEW_DOMAIN)"
MEDIA_KEYS='^(MEDIA_WORKER_TOKEN|S3_MEDIA_ACCESS_KEY|S3_MEDIA_SECRET_KEY|PREVIEW_MEDIA_IP)='
if [ "$created_env" = 1 ]; then
  # An .env from before the worker (ADR 0092): --add-media adds the missing keys and leaves every other line as it was.
  kept="$(grep -vE "$MEDIA_KEYS" "$HERE/.env" | sha256sum)" media="$(grep -E "$MEDIA_KEYS" "$HERE/.env" | sha256sum)"
  grep -vE "$MEDIA_KEYS" "$HERE/.env" > "$work/env" && cat "$work/env" > "$HERE/.env"
  "$HERE/gen-env.sh" --add-media | grep -q "4 added" || fail "gen-env.sh --add-media did not add the four media keys"
  "$HERE/gen-env.sh" --add-media | grep -q "0 added" || fail "gen-env.sh --add-media is not repeatable"
  [ "$(grep -vE "$MEDIA_KEYS" "$HERE/.env" | sha256sum)" = "$kept" ] || fail "gen-env.sh --add-media changed a key it does not own"
  [ "$(grep -E "$MEDIA_KEYS" "$HERE/.env" | sha256sum)" != "$media" ] || fail "gen-env.sh --add-media reused old values"
  [ "$(stat -c %a "$HERE/.env")" = 600 ] || fail ".env is not 0600 after --add-media"
  echo "gen-env.sh --add-media: adds the four media keys to an older .env, leaves the rest, and is repeatable: ok"
  # An .env from before the renders (addendum to ADR 0092): --add-render adds media-render's MinIO user and address the same way.
  RENDER_KEYS='^(S3_RENDER_ACCESS_KEY|S3_RENDER_SECRET_KEY|PREVIEW_RENDER_IP)='
  kept="$(grep -vE "$RENDER_KEYS" "$HERE/.env" | sha256sum)" render="$(grep -E "$RENDER_KEYS" "$HERE/.env" | sha256sum)"
  grep -vE "$RENDER_KEYS" "$HERE/.env" > "$work/env" && cat "$work/env" > "$HERE/.env"
  "$HERE/gen-env.sh" --add-render | grep -q "3 added" || fail "gen-env.sh --add-render did not add the three render keys"
  "$HERE/gen-env.sh" --add-render | grep -q "0 added" || fail "gen-env.sh --add-render is not repeatable"
  [ "$(grep -vE "$RENDER_KEYS" "$HERE/.env" | sha256sum)" = "$kept" ] || fail "gen-env.sh --add-render changed a key it does not own"
  [ "$(grep -E "$RENDER_KEYS" "$HERE/.env" | sha256sum)" != "$render" ] || fail "gen-env.sh --add-render reused old values"
  [ "$(stat -c %a "$HERE/.env")" = 600 ] || fail ".env is not 0600 after --add-render"
  echo "gen-env.sh --add-render: adds media-render's MinIO user and address to an older .env, leaves the rest, and is repeatable: ok"
  # An .env from before tusd and the API had their own MinIO users (both ran on the root one): --add-storage adds the four keys.
  STORAGE_KEYS='^(S3_TUSD_ACCESS_KEY|S3_TUSD_SECRET_KEY|S3_API_ACCESS_KEY|S3_API_SECRET_KEY)='
  kept="$(grep -vE "$STORAGE_KEYS" "$HERE/.env" | sha256sum)" storage="$(grep -E "$STORAGE_KEYS" "$HERE/.env" | sha256sum)"
  grep -vE "$STORAGE_KEYS" "$HERE/.env" > "$work/env" && cat "$work/env" > "$HERE/.env"
  "$HERE/gen-env.sh" --add-storage | grep -q "4 added" || fail "gen-env.sh --add-storage did not add the four storage keys"
  "$HERE/gen-env.sh" --add-storage | grep -q "0 added" || fail "gen-env.sh --add-storage is not repeatable"
  [ "$(grep -vE "$STORAGE_KEYS" "$HERE/.env" | sha256sum)" = "$kept" ] || fail "gen-env.sh --add-storage changed a key it does not own"
  [ "$(grep -E "$STORAGE_KEYS" "$HERE/.env" | sha256sum)" != "$storage" ] || fail "gen-env.sh --add-storage reused old values"
  [ "$(stat -c %a "$HERE/.env")" = 600 ] || fail ".env is not 0600 after --add-storage"
  echo "gen-env.sh --add-storage: adds the tusd and API MinIO users to an older .env, leaves the rest, and is repeatable: ok"
fi

# Synthetic media only (CLAUDE.md §5): a short clip carrying planted location, device and title tags (a coordinate built at
# run time, a random device name), and one still photo, made by the worker image's own ffmpeg with no network.
MARK="phsmoke$(openssl rand -hex 4)"
GPS="+$((30 + 1)).$((5000 + 77))+0$((30 + 4)).$((4000 + 66))/"
TAGS=(-metadata "com.apple.quicktime.location.ISO6709=$GPS" -metadata "com.apple.quicktime.model=$MARK-device"
      -metadata "com.apple.quicktime.make=$MARK-make" -metadata "title=$MARK-title" -movflags +faststart+use_metadata_tags)
ff() { docker run --rm --network none --user "$(id -u):$(id -g)" -v "$work:/out" --entrypoint "$1" post-history-preview-media:latest "${@:2}"; }
gen() { ff ffmpeg -hide_banner -loglevel error -nostdin -y "$@"; }
gen -f lavfi -i "testsrc2=size=1280x720:rate=30:duration=6" -f lavfi -i "sine=frequency=440:sample_rate=48000:duration=6" \
  -vf "noise=alls=20:allf=t" -c:v libx264 -preset veryfast -b:v 10M -maxrate 10M -bufsize 20M -pix_fmt yuv420p \
  -c:a aac -b:a 96k "${TAGS[@]}" /out/smoke.mov || fail "could not make the synthetic clip"
gen -f lavfi -i "testsrc2=size=640x480" -frames:v 1 /out/photo.jpg || fail "could not make the synthetic photo"
[ "$(stat -c %s "$work/smoke.mov")" -gt $((4 * 1048576)) ] || fail "the synthetic clip is under 4 MiB (the upload is cut at 3 MiB)"
src_tags="$(ff ffprobe -v error -show_entries format_tags -of json /out/smoke.mov)"
grep -qF "$MARK-device" <<<"$src_tags" && grep -qF "$GPS" <<<"$src_tags" || fail "the planted tags are not in the synthetic clip"
# Why the API stays the verifier here (ADR 0092): the worker's probe refuses a still photo, so as the verifier it would fail them.
ff python -c 'import sys
from media_worker.probe import InvalidMediaError, probe
try:
    probe("/out/photo.jpg")
except InvalidMediaError:
    sys.exit(0)
sys.exit(1)' || fail "the worker's probe now accepts a still photo: ADR 0092's reason to keep the API as the verifier changed"
echo "the worker's probe refuses a still photo (the API stays the verifier): ok"
export MARK GPS
echo "synthetic clip ($(($(stat -c %s "$work/smoke.mov") / 1024)) KiB, planted location and device tags) and photo: ok"

# Memory: every service has a limit with no swap on top, and the limits add up to <= LIMIT_MB.
cfg="$("${C[@]}" config --format json)"
read -r total nolimit swap <<<"$(python3 -c '
import json, sys
s = json.load(sys.stdin)["services"]
lim = {k: int(v.get("mem_limit") or 0) for k, v in s.items()}
print(sum(lim.values()) // 2**20, ",".join(k for k, v in lim.items() if not v) or "-",
      ",".join(k for k, v in s.items() if int(v.get("memswap_limit") or 0) != lim[k]) or "-")' <<<"$cfg")"
[ "$nolimit" = - ] || fail "services without mem_limit: $nolimit"
[ "$swap" = - ] || fail "services with swap (memswap_limit != mem_limit): $swap"
[ "$total" -le "$LIMIT_MB" ] || fail "memory limits add up to $total MB (> $LIMIT_MB)"
echo "memory limits: $total MB in all, no swap, every service limited: ok"

# The shared server's network carries other sites' containers: one answering to the short names "api" and "web-app"
# (418, and it logs every hit) must never receive the edge's traffic.
docker run -d --name ph-preview-decoy --network deploy_default --network-alias api --network-alias web-app \
  --entrypoint node post-history-preview-api:latest -e \
  "for (const p of [3000, 3100]) require('http').createServer((q, r) => { console.log('hit', p, q.method, q.url); r.statusCode = 418; r.end('decoy'); }).listen(p)" >/dev/null

"${C[@]}" up -d --wait >/dev/null 2>&1 || fail "preview compose did not come up"
# Postgres, Redis and MinIO on read-only roots, MinIO not as root, and the worker, media-render and the feeder healthy by
# their own checks (up --wait waited for them): connected to the queue, and a feeder cycle within the last minute.
for svc in postgres redis minio; do
  [ "$(docker inspect -f '{{.HostConfig.ReadonlyRootfs}}' "$("${C[@]}" ps -q "$svc")")" = true ] || fail "$svc root is not read-only"
done
tops="$(docker top "$("${C[@]}" ps -q minio)" -o pid,uid,args)"   # captured: pipefail + awk exit
muid="$(awk 'NR > 1 && / minio server / { print $2; exit }' <<<"$tops")"
[ "$muid" = 1000 ] || fail "MinIO runs as uid ${muid:-?}, not 1000"
for svc in media-worker media-render media-feeder; do
  [ "$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$("${C[@]}" ps -q "$svc")")" = healthy ] \
    || fail "$svc is not healthy by its own check"
done
echo "postgres, redis and MinIO on read-only roots, MinIO as uid 1000, and the worker, media-render and the feeder healthy: ok"
# The smoke hands the worker its jobs itself (backfill-media.sh), to see the disk guard and time the job; the feeder service
# starts again at the end.
"${C[@]}" stop media-feeder >/dev/null 2>&1 || fail "could not stop media-feeder"
# minio-init runs on every up on the server: a second run over the same buckets and user must pass too.
"${C[@]}" run --rm --no-deps -T minio-init >/dev/null 2>&1 || fail "minio-init does not run twice"
rcli() { "${C[@]}" exec -T redis sh -c 'REDISCLI_AUTH="$REDIS_PASSWORD" redis-cli --no-auth-warning "$@"' rcli "$@"; }

# The media worker (ADR 0092): hardened and limited as declared, on the internal network alone, everything but the light copy and
# the thumbnails switched off in its environment, and reaching /internal/media/ alone on the API with its token.
wid="$("${C[@]}" ps -q media-worker)"
[ -n "$wid" ] || fail "the media worker is not running"
python3 - "$wid" <<'PY' || fail "the media worker is not hardened and limited as ADR 0092 says"
import json, subprocess, sys
c = json.loads(subprocess.check_output(["docker", "inspect", sys.argv[1]]))[0]
h, cfg = c["HostConfig"], c["Config"]
env = dict(e.split("=", 1) for e in cfg["Env"])
want = {
    "user": (cfg["User"], "10001:10001"), "read-only root": (h["ReadonlyRootfs"], True), "cap_drop": (h["CapDrop"], ["ALL"]),
    "no-new-privileges": ("no-new-privileges:true" in (h["SecurityOpt"] or []), True),
    "memory": (h["Memory"], 1472 * 2**20), "no swap": (h["MemorySwap"], h["Memory"]), "cpus": (h["NanoCpus"], 1_500_000_000),
    "cpu shares": (h["CpuShares"], 256), "pids": (h["PidsLimit"], 128), "oom score": (h["OomScoreAdj"], 500),
    "host ports": (h["PortBindings"] or {}, {}), "networks": (sorted(c["NetworkSettings"]["Networks"]), ["post-history-preview_internal"]),
}
for flag in ("HLS", "PHASH", "EXPORT", "STORE_PREVIEW", "DELIVERY", "ALIGNMENT", "C2PA"):
    want[f"MEDIA_ENABLE_{flag}"] = (env.get(f"MEDIA_ENABLE_{flag}"), "false")
bad = [f"{k}: {v[0]!r} (want {v[1]!r})" for k, v in want.items() if v[0] != v[1]]
for k in ("AI_WORKER_TOKEN", "MEDIA_C2PA_CERT_CHAIN", "MEDIA_WATERMARK_KEY"):
    if env.get(k):
        bad.append(f"{k} is set")
print("\n".join(bad)); sys.exit(1 if bad else 0)
PY
[ "$(docker network inspect post-history-preview_internal -f '{{.Internal}}')" = true ] || fail "the worker's network has an exit"
"${C[@]}" exec -T media-worker python - <<'PY' || fail "the worker reaches more than /internal/media/ on the API"
import os, urllib.error, urllib.request, uuid
def status(path, token=None):
    req = urllib.request.Request("http://ph-preview-api:3000" + path, headers={"Authorization": f"Bearer {token}"} if token else {})
    try:
        return urllib.request.build_opener(urllib.request.ProxyHandler({})).open(req, timeout=10).status
    except urllib.error.HTTPError as err:
        return err.code
token = os.environ["MEDIA_WORKER_TOKEN"]
got = {"media, its token": status(f"/internal/media/sessions/{uuid.uuid4()}", token),
       "media, no token": status(f"/internal/media/sessions/{uuid.uuid4()}"),
       "tusd hook": status("/internal/tusd-hooks/x", token), "ingest": status("/internal/ingest/session-status?sid=x", token)}
want = {"media, its token": 410, "media, no token": 404, "tusd hook": 403, "ingest": 403}
assert got == want, got
PY
echo "media worker: user 10001, read-only, no capabilities, 1472 MB / 1.5 CPU / shares 256 / 128 pids, internal network only, HLS, AI, export, delivery and C2PA off, /internal/media/ alone: ok"

# media-render (addendum to ADR 0092): the worker's hardening with its own limits, renders on with one Remotion tab and nothing else,
# on the internal network alone with a MinIO user of its own. Renders are on for the API and media-render, not the ingest worker.
rnd="$("${C[@]}" ps -q media-render)"
[ -n "$rnd" ] || fail "media-render is not running"
python3 - "$rnd" "$wid" "$("${C[@]}" ps -q api)" <<'PY' || fail "media-render is not hardened and limited as the addendum to ADR 0092 says"
import json, subprocess, sys
c, worker, api = (json.loads(subprocess.check_output(["docker", "inspect", i]))[0] for i in sys.argv[1:4])
h, cfg = c["HostConfig"], c["Config"]
envof = lambda x: dict(e.split("=", 1) for e in x["Config"]["Env"])
env = envof(c)
want = {
    "user": (cfg["User"], "10001:10001"), "read-only root": (h["ReadonlyRootfs"], True), "cap_drop": (h["CapDrop"], ["ALL"]),
    "no-new-privileges": ("no-new-privileges:true" in (h["SecurityOpt"] or []), True),
    "memory": (h["Memory"], 4096 * 2**20), "no swap": (h["MemorySwap"], h["Memory"]), "cpus": (h["NanoCpus"], 2_000_000_000),
    "cpu shares": (h["CpuShares"], 128), "pids": (h["PidsLimit"], 512), "oom score": (h["OomScoreAdj"], 800),
    "host ports": (h["PortBindings"] or {}, {}), "networks": (sorted(c["NetworkSettings"]["Networks"]), ["post-history-preview_internal"]),
    "command": (cfg["Cmd"], ["serve", "--queue", "renders"]),
    "MEDIA_ENABLE_RENDERS": (env.get("MEDIA_ENABLE_RENDERS"), "true"), "MEDIA_RENDER_CONCURRENCY": (env.get("MEDIA_RENDER_CONCURRENCY"), "1"),
    "renders on for the API": (envof(api).get("MEDIA_ENABLE_RENDERS"), "true"),
    "renders not on the ingest worker": (envof(worker).get("MEDIA_ENABLE_RENDERS", "false"), "false"),
}
for flag in ("HLS", "PHASH", "EXPORT", "STORE_PREVIEW", "DELIVERY", "ALIGNMENT", "C2PA"):
    want[f"MEDIA_ENABLE_{flag}"] = (env.get(f"MEDIA_ENABLE_{flag}"), "false")
bad = [f"{k}: {v[0]!r} (want {v[1]!r})" for k, v in want.items() if v[0] != v[1]]
for k in ("AI_WORKER_TOKEN", "MEDIA_C2PA_CERT_CHAIN", "MEDIA_WATERMARK_KEY"):
    if env.get(k):
        bad.append(f"{k} is set")
if env.get("S3_ACCESS_KEY") == envof(worker).get("S3_ACCESS_KEY"):
    bad.append("media-render shares the media worker's MinIO user")
print("\n".join(bad)); sys.exit(1 if bad else 0)
PY
"${C[@]}" exec -T media-render python - <<'PY' || fail "media-render reaches more than renders and source files on the API"
import os, urllib.error, urllib.request, uuid
def status(path, token=None):
    req = urllib.request.Request("http://ph-preview-api:3000" + path, headers={"Authorization": f"Bearer {token}"} if token else {})
    try:
        return urllib.request.build_opener(urllib.request.ProxyHandler({})).open(req, timeout=10).status
    except urllib.error.HTTPError as err:
        return err.code
token = os.environ["MEDIA_WORKER_TOKEN"]
got = {"render, its token": status(f"/internal/media/renders/{uuid.uuid4()}", token),
       "source file, its token": status(f"/internal/media/files/{uuid.uuid4()}", token),
       "render, no token": status(f"/internal/media/renders/{uuid.uuid4()}"),
       "upload session": status(f"/internal/media/sessions/{uuid.uuid4()}", token),
       "tusd hook": status("/internal/tusd-hooks/x", token), "ingest": status("/internal/ingest/session-status?sid=x", token)}
want = {"render, its token": 410, "source file, its token": 410, "render, no token": 404, "upload session": 403, "tusd hook": 403,
        "ingest": 403}
assert got == want, got
PY
echo "media-render: user 10001, read-only, no capabilities, 4096 MB / 2 CPU / shares 128 / 512 pids / oom_score_adj 800, internal network only, renders on (Remotion concurrency 1) and nothing else, its own MinIO user, renders and source files alone on the API: ok"

# No host port anywhere, and only "web" on the shared server's network.
for id in $("${C[@]}" ps -aq); do
  [ "$(docker inspect -f '{{json .HostConfig.PortBindings}}' "$id")" = "{}" ] || fail "$(docker inspect -f '{{.Name}}' "$id") publishes a host port"
done
on_shared="$(docker network inspect deploy_default -f '{{range .Containers}}{{.Name}} {{end}}')"
[ "$on_shared" = "ph-preview-decoy post-history-preview-web-1 " ] || [ "$on_shared" = "post-history-preview-web-1 ph-preview-decoy " ] || fail "on deploy_default: '$on_shared' (want the web edge alone)"
echo "no host port, the web edge alone on deploy_default: ok"

# The public /v1/ location (ADR 0077) reaches the API over a second internal network that only the edge and the API share. The
# API sees the edge there from an address that is not the BFF's (BFF_SOURCE_ADDRESSES), so public callers get no BFF powers; the
# API is still not on the shared network, and the edge's address on the second network is not the trusted one.
api_id="$("${C[@]}" ps -q api)" web_id="$("${C[@]}" ps -q web)"
api_nets="$(docker inspect -f '{{range $k, $_ := .NetworkSettings.Networks}}{{$k}} {{end}}' "$api_id")"
[ "$api_nets" = "post-history-preview_internal post-history-preview_public-api " ] || fail "the API is on: '$api_nets' (want the two internal networks, never deploy_default)"
pub_net=post-history-preview_public-api
[ "$(docker network inspect "$pub_net" -f '{{.Internal}}')" = true ] || fail "$pub_net is not an internal network"
members="$(docker network inspect "$pub_net" -f '{{range .Containers}}{{.Name}}{{"\n"}}{{end}}' | sed '/^$/d' | sort | tr '\n' ' ')"
[ "$members" = "post-history-preview-api-1 post-history-preview-web-1 " ] || fail "on $pub_net: '$members' (want the API and the edge alone)"
edge_pub_ip="$(docker inspect -f '{{(index .NetworkSettings.Networks "'$pub_net'").IPAddress}}' "$web_id")"
bff_ip="$(python3 -c 'import json, sys; print(json.load(sys.stdin)["services"]["api"]["environment"]["BFF_SOURCE_ADDRESSES"].split("/")[0])' <<<"$("${C[@]}" config --format json)")"
[ -n "$edge_pub_ip" ] && [ -n "$bff_ip" ] && [ "$edge_pub_ip" != "$bff_ip" ] || fail "the edge's address on $pub_net is the BFF's trusted address"
echo "public /v1 reaches the API over a network of its own, from an address that is not the BFF's: ok"

# A probe on deploy_default, as the server's Caddy: the API image's node, no other image.
probe() { docker run --rm -i --network deploy_default -v "$work:/clip:ro" -e DOMAIN -e EMAIL -e PASSWORD -e MARK -e GPS -e MATERIAL \
  -e CLIP -e CLIP_MIME --entrypoint node post-history-preview-api:latest --input-type=module -; }
"${C[@]}" exec -T api node -e "fetch('http://127.0.0.1:3000/health').then(r => process.exit(r.status === 200 ? 0 : 1), () => process.exit(1))" \
  || fail "API /health is not 200"
echo "API /health 200: ok"

seed_out="$("$HERE/seed-preview.sh" 2>&1)" || { echo "$seed_out"; fail "seed-preview"; }
"$HERE/seed-preview.sh" >/dev/null 2>&1 || fail "seed-preview is not repeatable"
for r in SUPERVISOR EDITOR REPORTER; do
  pw="$(val "PREVIEW_${r}_PASSWORD")"
  [ "${#pw}" -ge 20 ] || fail "no generated password for $r in .env"
  if grep -qF "$pw" <<<"$seed_out"; then fail "seed-preview printed a password"; fi
done
echo "demo accounts seeded, passwords in .env only: ok"

# Through the web edge as Caddy would reach it: robots header and banner, then a demo login through the BFF (which reaches
# the API over the internal TLS listener) sees the reporter's synthetic materials; the API is not reachable from there.
out="$(DOMAIN="$DOMAIN" EMAIL="$(val PREVIEW_REPORTER_EMAIL)" PASSWORD="$(val PREVIEW_REPORTER_PASSWORD)" probe <<'JS'
import http from "node:http";
const host = process.env.DOMAIN, origin = `https://${host}`;
const say = (m) => console.log(m), die = (m) => { console.log(`FAIL ${m}`); process.exit(1); };
// node:http, not fetch: fetch rewrites Origin on a POST, and the BFF's same-origin check needs it as a browser sends it.
const req = (method, path, headers = {}, body) => new Promise((resolve) => {
  const q = http.request({ host: "lib-web", port: 8080, path, method, timeout: 15000,
    headers: { host, ...headers, ...(body ? { "content-length": Buffer.byteLength(body) } : {}) } }, (r) => {
    let d = ""; r.on("data", (c) => (d += c)); r.on("end", () => resolve({ status: r.statusCode, headers: r.headers, body: d }));
  });
  q.on("error", (e) => resolve({ status: 0, headers: {}, body: String(e) }));
  q.end(body);
});
const page = await req("GET", "/ar/login");
if (!/noindex/.test(page.headers["x-robots-tag"] ?? "")) die(`no X-Robots-Tag on a page (${page.status})`);
if (!page.body.includes("Preview: test data and accounts only")) die(`no preview banner in the page (${page.status})`);
say("noindex header and preview banner on the page: ok");
if (!(await req("GET", "/robots.txt")).body.includes("Disallow: /")) die("robots.txt does not disallow");
const font = await req("GET", "/fonts/Rubik-Bold.woff2");
if (font.status !== 200 || !/font\/woff2/.test(font.headers["content-type"] ?? "")) die(`self-hosted font through the edge: ${font.status} ${font.headers["content-type"] ?? ""}`);
const sheets = [...new Set(page.body.match(/\/_next\/static\/[A-Za-z0-9._\/-]+\.css/g) ?? [])];
const css = (await Promise.all(sheets.map((h) => req("GET", h)))).map((r) => (r.status === 200 ? r.body : "")).join("");
if (!sheets.length || !css.includes("Rubik") || !css.includes("/fonts/")) die(`page stylesheets do not load the v2 fonts (${sheets.length} sheets)`);
say(`self-hosted font and ${sheets.length} page stylesheet(s) with the v2 fonts through the edge: ok`);
const json = { origin, "x-requested-with": "post-history-web", "content-type": "application/json" };
const login = await req("POST", "/api/bff/auth/login", json, JSON.stringify({ email: process.env.EMAIL, password: process.env.PASSWORD }));
if (login.status !== 200) die(`demo login through the web: ${login.status} ${login.body}`);
const cookie = String(login.headers["set-cookie"] ?? "").split(";")[0];
if (!cookie.includes("=")) die("no session cookie");
const list = await req("GET", "/api/bff/materials", { cookie });
const items = list.status === 200 ? JSON.parse(list.body).items ?? [] : [];
if (items.length < 3) die(`materials through the web: ${list.status}, ${items.length} items`);
say(`demo login through the web sees ${items.length} synthetic materials: ok`);
const bad = await req("POST", "/api/bff/auth/login", json, JSON.stringify({ email: process.env.EMAIL, password: "wrong-password-123" }));
if (bad.status !== 401) die(`a wrong password: ${bad.status}`);
for (const url of ["http://ph-preview-api:3000/health", "https://lib-web:8443/health", "http://lib-web:8443/health"]) {
  const r = await fetch(url, { signal: AbortSignal.timeout(3000) }).then((x) => x.status, () => "unreachable");
  if (r !== "unreachable") die(`${url} answers from the shared network (${r})`);
}
say("the API is not reachable from the shared network: ok");

// Desktop upload as the browser does it (#202): a session and a web ingest token through the BFF, then tus to /files/ on
// the preview's own origin, through the edge, the ingest gate and tusd. The first PATCH is cut mid-body and resumed
// from the offset tusd reports; the API verifies it itself (in_process), and the media worker's turn comes after (ADR 0092).
// The file is the synthetic clip with planted location and device tags, under a file name carrying the run's marker.
const { createHash, randomBytes, randomUUID } = await import("node:crypto");
const bff = (path, body) => req("POST", `/api/bff/${path}`, { ...json, cookie, "idempotency-key": randomUUID() }, JSON.stringify(body));
const bytes = (await import("node:fs")).readFileSync("/clip/smoke.mov");
const created = await bff("uploads", { material_id: items[0].id, kind: "original", size_bytes: bytes.length, filename: `${process.env.MARK}-name.mov`,
  mime_type: "video/quicktime", client_sha256: createHash("sha256").update(bytes).digest("hex") });
if (created.status !== 201) die(`upload session through the BFF: ${created.status} ${created.body}`);
const s = JSON.parse(created.body);
if (s.tus_endpoint !== `${origin}/files/` || s.ingest_token_required !== true) die(`tus endpoint ${s.tus_endpoint}, ingest required ${s.ingest_token_required}`);
const it = await bff(`uploads/${s.id}/web-ingest-token`, {});
if (it.status !== 200) die(`web ingest token through the BFF: ${it.status}`);
const ingest = JSON.parse(it.body).token;
const b64 = (v) => Buffer.from(v).toString("base64");
const tusH = { "tus-resumable": "1.0.0", authorization: `Bearer ${s.upload_token}`, "ingest-token": ingest };
const meta = Object.entries(s.tus_metadata).map(([k, v]) => `${k} ${b64(v)}`).join(",");
const noToken = await req("POST", "/files/", { "tus-resumable": "1.0.0", "upload-length": String(bytes.length), "upload-metadata": meta });
if (noToken.status !== 401) die(`tus create with no ingest token: ${noToken.status} (want 401 at the gate)`);
const tc = await req("POST", "/files/", { ...tusH, "upload-length": String(bytes.length), "upload-metadata": meta });
const loc = tc.headers.location ?? "";
if (tc.status !== 201 || !loc.startsWith(`${origin}/files/`)) die(`tus create through the edge: ${tc.status} location ${loc ? "elsewhere" : "missing"}`);
const path = new URL(loc).pathname;
// Cut: the headers announce the whole file, half a part is written, then the socket is destroyed.
await new Promise((resolve) => {
  const q = http.request({ host: "lib-web", port: 8080, path, method: "PATCH", headers: { host, ...tusH, "upload-offset": "0",
    "content-type": "application/offset+octet-stream", "content-length": bytes.length } });
  q.on("error", () => resolve()); q.on("response", () => resolve());
  q.write(bytes.subarray(0, 3 * 1024 * 1024), () => setTimeout(() => { q.destroy(); resolve(); }, 1500));
});
await new Promise((r) => setTimeout(r, 2000));
const head = await req("HEAD", path, tusH);
const offset = Number(head.headers["upload-offset"]);
if (head.status !== 200 || !(offset >= 0 && offset < bytes.length)) die(`tus HEAD after the cut: ${head.status} offset ${head.headers["upload-offset"]}`);
const rest = await req("PATCH", path, { ...tusH, "upload-offset": String(offset), "content-type": "application/offset+octet-stream" }, bytes.subarray(offset));
if (rest.status !== 204 || Number(rest.headers["upload-offset"]) !== bytes.length) die(`tus resume from ${offset}: ${rest.status} offset ${rest.headers["upload-offset"]}`);
say(`desktop upload through the edge and the ingest gate, cut at 3 MiB and resumed from offset ${offset}: ok`);
let state = "";
for (let i = 0; i < 30 && state !== "verified"; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  const g = await req("GET", `/api/bff/uploads/${s.id}`, { cookie });
  state = g.status === 200 ? JSON.parse(g.body).state : `http ${g.status}`;
}
if (state !== "verified") die(`upload session after the last byte: ${state} (want verified by the API itself)`);
say(`upload session verified by the API after tus finished (tusd post-finish hook, then in-process verification): ok`);
say(`MATERIAL=${items[0].id}`);
// One file is at most 2 GiB here: tusd refuses a larger Upload-Length (413) before any hook or byte.
const small = await bff("uploads", { material_id: items[1].id, kind: "original", size_bytes: 1024, filename: "too-big.mp4",
  client_sha256: createHash("sha256").update(randomBytes(8)).digest("hex") });
if (small.status !== 201) die(`second upload session through the BFF: ${small.status}`);
const s2 = JSON.parse(small.body);
const it2 = JSON.parse((await bff(`uploads/${s2.id}/web-ingest-token`, {})).body).token;
const big = await req("POST", "/files/", { "tus-resumable": "1.0.0", authorization: `Bearer ${s2.upload_token}`, "ingest-token": it2,
  "upload-length": String(2 * 1024 ** 3 + 1), "upload-metadata": Object.entries(s2.tus_metadata).map(([k, v]) => `${k} ${b64(v)}`).join(",") });
if (big.status !== 413) die(`tus create of 2 GiB + 1 byte: ${big.status} (want 413 from tusd -max-size)`);
say("a file over 2 GiB is refused by tusd (413): ok");
// And before that, when the session is created: the API answers 422 above UPLOAD_MAX_BYTES (#238), passed on by the BFF.
const tooBig = await bff("uploads", { material_id: items[2].id, kind: "original", size_bytes: 2 * 1024 ** 3 + 1, filename: "too-big.mp4",
  client_sha256: createHash("sha256").update(randomBytes(8)).digest("hex") });
if (tooBig.status !== 422) die(`upload session of 2 GiB + 1 byte through the BFF: ${tooBig.status} (want 422)`);
say("an upload session over 2 GiB is refused when created (422): ok");

// Public /v1 through the same edge, as the iOS test build reaches it (ADR 0077). The API sees these requests from the edge's
// address on the second network, which BFF_SOURCE_ADDRESSES does not list: no web ingest token, no client address chosen by
// the caller, and no device without a real attestation gets an ingest token.
const pub = (method, path, headers = {}, body) => req(method, `/v1${path}`,
  { "content-type": "application/json", ...headers }, body === undefined ? undefined : JSON.stringify(body));
const noAuth = await pub("GET", "/auth/me");
if (noAuth.status !== 401) die(`public GET /v1/auth/me with no token: ${noAuth.status} (want 401 from the API)`);
if (!/noindex/.test(noAuth.headers["x-robots-tag"] ?? "")) die("no X-Robots-Tag on a public /v1 answer");
if (!/no-store/.test(noAuth.headers["cache-control"] ?? "")) die("a public /v1 answer is cacheable");
if (noAuth.body.includes("Preview: test data") || /html/i.test(String(noAuth.headers["content-type"]))) die("the page banner leaked into a /v1 answer");
const pubLogin = await pub("POST", "/auth/login", {}, { email: process.env.EMAIL, password: process.env.PASSWORD });
if (pubLogin.status !== 200) die(`demo login on public /v1: ${pubLogin.status}`);
const bearer = { authorization: `Bearer ${JSON.parse(pubLogin.body).access_token}` };
const pubList = await pub("GET", "/materials", bearer);
const pubItems = pubList.status === 200 ? JSON.parse(pubList.body).items ?? [] : [];
if (pubItems.length < 3) die(`materials on public /v1: ${pubList.status}, ${pubItems.length} items`);
say(`public /v1 through the edge: login and ${pubItems.length} synthetic materials, noindex, no-store, no banner: ok`);
const idem = () => ({ ...bearer, "idempotency-key": randomUUID() });
const challenge = async () => {
  const c = await pub("POST", "/device-attestations/challenge", idem());
  if (c.status !== 200) die(`attestation challenge on public /v1: ${c.status} ${c.body}`);
  return JSON.parse(c.body).challenge_id;
};
// A device with no real attestation: the key registration and both ingest-token requests are refused with the one answer.
const registered = await pub("POST", "/device-attestations", idem(), { platform: "ios", key_id: "AAAA", attestation: "AAAA", challenge_id: await challenge() });
if (registered.status !== 403 || JSON.parse(registered.body).code !== "attestation_failed") die(`a forged App Attest registration: ${registered.status} ${registered.body.slice(0, 80)}`);
const pubSession = await pub("POST", "/uploads", idem(), { material_id: items[2].id, kind: "original", size_bytes: 1024, filename: "public-smoke.mp4",
  mime_type: "video/mp4", client_sha256: createHash("sha256").update(randomBytes(8)).digest("hex") });
if (pubSession.status !== 201) die(`upload session on public /v1: ${pubSession.status} ${pubSession.body.slice(0, 80)}`);
const ps = JSON.parse(pubSession.body);
const forgedIos = await pub("POST", `/uploads/${ps.id}/ingest-token`, idem(), { platform: "ios", key_id: "AAAA", assertion: "AAAA", challenge_id: await challenge() });
if (forgedIos.status !== 403 || JSON.parse(forgedIos.body).code !== "attestation_failed") die(`an iOS ingest token with a forged assertion: ${forgedIos.status}`);
const forgedAndroid = await pub("POST", `/uploads/${ps.id}/ingest-token`, idem(), { platform: "android", integrity_token: "forged", challenge_id: await challenge() });
if (forgedAndroid.status !== 403 || JSON.parse(forgedAndroid.body).code !== "attestation_failed") die(`an Android ingest token (Play Integrity is closed here): ${forgedAndroid.status}`);
say("a forged App Attest registration and ingest tokens (iOS, Android) are refused with 403 attestation_failed: ok");
// BFF-only: the web ingest token (no device attestation behind it) is 404 on the public path, 200 for the same session through the BFF.
const pubWeb = await pub("POST", `/uploads/${ps.id}/web-ingest-token`, idem());
if (pubWeb.status !== 404) die(`web ingest token on public /v1: ${pubWeb.status} (want 404: it is for the BFF alone)`);
const bffWeb = await bff(`uploads/${ps.id}/web-ingest-token`, {});
if (bffWeb.status !== 200) die(`the same web ingest token through the BFF: ${bffWeb.status} (the public 404 would prove nothing)`);
say("the web ingest token: 404 on public /v1, 200 through the BFF for the same session: ok");
// The caller does not choose its client address: ten failed logins for one email under ten different X-Client-Address values
// still hit that email's limit on the eleventh, because the API ignores the header from any address but the BFF's.
let throttled = 0;
for (let i = 1; i <= 11; i++) {
  const r = await pub("POST", "/auth/login", { "x-client-address": `198.51.100.${i}` }, { email: "nobody@preview-smoke.invalid", password: "wrong-password-123" });
  if (i <= 10 && r.status !== 401) die(`failed login ${i} on public /v1 with a forged client address: ${r.status} (want 401)`);
  throttled = r.status;
}
if (throttled !== 429) die(`11th failed login with ten forged client addresses: ${throttled} (want 429: the header must be ignored on public /v1)`);
say("a forged X-Client-Address does not give a public caller a rate-limit bucket of its own: ok");
// Not exposed here: the server's internal routes, its health check, and bodies beyond what JSON needs.
for (const [method, path] of [["GET", "/internal/ingest/session-status?sid=x"], ["POST", "/internal/tusd-hooks/x"], ["GET", "/health"], ["POST", "/payments/webhooks/sandbox"]]) {
  const r = await pub(method, path, bearer);
  if (r.status !== 404) die(`${method} /v1${path.split("?")[0]} on the public edge: ${r.status} (want 404)`);
}
const huge = await req("POST", "/v1/auth/login", { "content-type": "application/json" }, "x".repeat(1024 * 1024 + 1024));
if (huge.status !== 413) die(`a body over 1 MiB on public /v1: ${huge.status} (want 413 at the edge)`);
say("/v1/internal, /v1/health and webhooks are 404, a body over 1 MiB is 413 at the edge: ok");
JS
)" || { echo "$out"; fail "through the web edge"; }
echo "$out"
[ -z "$(docker logs ph-preview-decoy 2>&1)" ] || { docker logs ph-preview-decoy 2>&1 | head -5; fail "the edge sent traffic to another container named api or web-app on deploy_default"; }
echo "the edge reaches its own upstreams, not same-named containers on deploy_default: ok"
MATERIAL="$(sed -n 's/^MATERIAL=//p' <<<"$out")"
[ -n "$MATERIAL" ] || fail "the first upload printed no material"
export MATERIAL

# ---- Media worker (ADR 0092) ----
rid="$("${C[@]}" ps -q redis)"
rx() { docker exec "$rid" sh -c 'REDISCLI_AUTH="$REDIS_PASSWORD" redis-cli --no-auth-warning "$@"' rx "$@"; }
mc_image="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["services"]["minio-init"]["image"])' <<<"$cfg")"
# mc as a throwaway container on the internal network; the keys come from .env by name, never on the command line.
mcx() { docker run --rm --network post-history-preview_internal --env-file "$HERE/.env" --entrypoint sh "$mc_image" -c \
  'export MC_HOST_local="http://$S3_ACCESS_KEY:$S3_SECRET_KEY@minio:9000" MC_HOST_w="http://$S3_MEDIA_ACCESS_KEY:$S3_MEDIA_SECRET_KEY@minio:9000" MC_HOST_r="http://$S3_RENDER_ACCESS_KEY:$S3_RENDER_SECRET_KEY@minio:9000" MC_HOST_u="http://$S3_TUSD_ACCESS_KEY:$S3_TUSD_SECRET_KEY@minio:9000" MC_HOST_p="http://$S3_API_ACCESS_KEY:$S3_API_SECRET_KEY@minio:9000"; '"$1"; }
# One query on the preview's own database, rows space-separated.
sql() { "${C[@]}" exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At -F " " -c "$1"' sql "$1"; }
feed() { "${C[@]}" run --rm --no-deps -T "$@" media-feeder --once 2>/dev/null; }
field() { python3 -c 'import json, sys; print(json.loads(sys.argv[1])[sys.argv[2]])' "$1" "$2"; }

# The disk guard: with free space under the threshold the feeder gives the worker nothing, says so, and the verified original
# stays eligible for the next cycle (pending and retryable, nothing lost).
xlen0="$(rx XLEN media:events)"
guard="$(feed -e MEDIA_MIN_FREE_GIB=1048576)" || fail "the feeder failed with the disk guard on"
[ "$(field "$guard" state)" = paused_low_disk ] && [ "$(field "$guard" enqueued)" = 0 ] && [ "$(field "$guard" eligible)" -ge 1 ] \
  || fail "disk guard: $guard"
grep -qF "free disk under the threshold" <<<"$guard" || fail "the disk guard does not say why it holds the job"
[ "$(rx XLEN media:events)" = "$xlen0" ] || fail "a job reached the worker's queue under the disk guard"
echo "disk guard: under the threshold no job is given, it is logged, and the original stays eligible: ok"

# backfill-media.sh: one feeder cycle hands the verified original to the worker over the internal queue.
bf="$("$HERE/backfill-media.sh" 2>/dev/null)" || fail "backfill-media.sh failed"
[ "$(field "$bf" state)" = ready ] && [ "$(field "$bf" enqueued)" = 1 ] || fail "backfill: $bf"
echo "backfill-media.sh gave the worker the verified original (counts only: $bf): ok"

# Shared helpers for the probes below: requests through the edge as bytes, a public /v1 and a web login, and a whole-file
# desktop upload in parts under the 100 MB body limit that resolves once the API has verified it.
JS_LIB="$(cat <<'JS'
import http from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
const host = process.env.DOMAIN, origin = `https://${host}`;
const say = (m) => console.log(m), die = (m) => { console.log(`FAIL ${m}`); process.exit(1); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const req = (method, path, headers = {}, body) => new Promise((resolve) => {
  const q = http.request({ host: "lib-web", port: 8080, path, method, timeout: 60000,
    headers: { host, ...headers, ...(body !== undefined ? { "content-length": Buffer.byteLength(body) } : {}) } }, (r) => {
    const parts = []; r.on("data", (c) => parts.push(c));
    r.on("end", () => { const buf = Buffer.concat(parts); resolve({ status: r.statusCode, headers: r.headers, buf, body: buf.toString() }); });
  });
  q.on("error", (e) => resolve({ status: 0, headers: {}, buf: Buffer.alloc(0), body: String(e) }));
  q.end(body);
});
const pub = (method, path, headers = {}, body) => req(method, `/v1${path}`, { "content-type": "application/json", ...headers },
  body === undefined ? undefined : JSON.stringify(body));
const json = { origin, "x-requested-with": "post-history-web", "content-type": "application/json" };
const cred = JSON.stringify({ email: process.env.EMAIL, password: process.env.PASSWORD });
const login = await pub("POST", "/auth/login", {}, JSON.parse(cred));
if (login.status !== 200) die(`login on public /v1: ${login.status}`);
const bearer = { authorization: `Bearer ${JSON.parse(login.body).access_token}` };
const web = await req("POST", "/api/bff/auth/login", json, cred);
if (web.status !== 200) die(`login through the web: ${web.status}`);
const cookie = String(web.headers["set-cookie"] ?? "").split(";")[0];
const bff = (path, body) => req("POST", `/api/bff/${path}`, { ...json, cookie, "idempotency-key": randomUUID() }, JSON.stringify(body));
// chunk: the PATCH size. 8 MiB as a foreground client, 64 MiB as the iOS background session (ADR 0009).
async function upload(materialId, file, filename, mime, chunk = 8 * 1024 * 1024) {
  const bytes = Buffer.isBuffer(file) ? file : readFileSync(file);
  const c = await bff("uploads", { material_id: materialId, kind: "original", size_bytes: bytes.length, filename, mime_type: mime,
    client_sha256: createHash("sha256").update(bytes).digest("hex") });
  if (c.status !== 201) return { status: c.status };
  const s = JSON.parse(c.body);
  const it = await bff(`uploads/${s.id}/web-ingest-token`, {});
  if (it.status !== 200) die(`web ingest token: ${it.status}`);
  const tusH = { "tus-resumable": "1.0.0", authorization: `Bearer ${s.upload_token}`, "ingest-token": JSON.parse(it.body).token };
  const meta = Object.entries(s.tus_metadata).map(([k, v]) => `${k} ${Buffer.from(v).toString("base64")}`).join(",");
  const tc = await req("POST", "/files/", { ...tusH, "upload-length": String(bytes.length), "upload-metadata": meta });
  if (tc.status !== 201) die(`tus create: ${tc.status}`);
  const path = new URL(tc.headers.location).pathname;
  for (let off = 0; off < bytes.length; ) {
    const p = await req("PATCH", path, { ...tusH, "upload-offset": String(off), "content-type": "application/offset+octet-stream" },
      bytes.subarray(off, off + chunk));
    if (p.status !== 204) die(`tus PATCH at ${off}: ${p.status}`);
    off = Number(p.headers["upload-offset"]);
  }
  for (let i = 0; i < 120; i++) {
    const g = await req("GET", `/api/bff/uploads/${s.id}`, { cookie });
    const state = g.status === 200 ? JSON.parse(g.body).state : "";
    if (state === "verified") return { status: 201 };
    if (state === "failed") die("an upload session failed");
    await sleep(1000);
  }
  die("an upload was not verified within 120 s");
}
async function newMaterial() {
  const version = JSON.parse((await pub("GET", "/forms/current", bearer)).body).version;
  const mat = await pub("POST", "/materials", { ...bearer, "idempotency-key": randomUUID() }, { title: `${process.env.MARK} measurement`,
    material_types: ["report"], governorate: "gaza", city: "Test city", priority: "normal", sensitivity: { minors: false, injured: false, graphic: false },
    display_name: { mode: "network" }, form_version: version, dynamic_fields: {} });
  if (mat.status !== 201) die(`a material on public /v1: ${mat.status}`);
  return JSON.parse(mat.body).id;
}
const verified = (m, kind) => m.files.filter((f) => f.kind === kind && f.state === "verified");
async function derivatives(mid, seconds) {
  let m = { files: [] };
  for (let i = 0; i < seconds; i++) {
    const g = await pub("GET", `/materials/${mid}`, bearer);
    if (g.status === 200) m = JSON.parse(g.body);
    if (verified(m, "proxy").length && verified(m, "thumbnail").length) return m;
    await sleep(1000);
  }
  die(`no verified proxy and thumbnail after ${seconds} s: ${JSON.stringify(m.files.map((f) => [f.kind, f.state]))}`);
}
JS
)"

# The worker's output for the first upload, read as the iOS app reads it: a signed link from public /v1, fetched through the edge.
out="$(EMAIL="$(val PREVIEW_REPORTER_EMAIL)" PASSWORD="$(val PREVIEW_REPORTER_PASSWORD)" DOMAIN="$DOMAIN" probe <<<"$JS_LIB
$(cat <<'JS'
const mid = process.env.MATERIAL;
const m = await derivatives(mid, 180);
const kinds = [...new Set(m.files.map((f) => f.kind))].sort().join(",");
if (kinds !== "original,proxy,thumbnail") die(`the material has ${kinds} (want the original, one proxy and one thumbnail: nothing else runs here)`);
const proxy = verified(m, "proxy")[0], thumb = verified(m, "thumbnail")[0];
if (proxy.height !== 480 || !(proxy.duration_ms > 5000)) die(`proxy ${proxy.width}x${proxy.height}, ${proxy.duration_ms} ms (want 480p of the 6 s clip)`);
say(`the worker made a verified 480p proxy (${proxy.size_bytes} bytes) and a thumbnail, and nothing else: ok`);
const link = async (f) => {
  const r = await pub("GET", `/materials/${mid}/files/${f.id}/download-url`, bearer);
  if (r.status !== 200) die(`download-url for the ${f.kind}: ${r.status}`);
  const { url, expires_at } = JSON.parse(r.body), u = new URL(url), left = Date.parse(expires_at) - Date.now();
  if (u.origin !== origin) die(`the ${f.kind} link is not signed for the preview's own origin`);
  if (!(left > 0 && left <= 600000)) die(`the ${f.kind} link lives ${left} ms`);
  return u.pathname + u.search;
};
const proxyPath = await link(proxy);
const got = await req("GET", proxyPath);
if (got.status !== 200 || !/^video\/mp4/.test(got.headers["content-type"] ?? "")) die(`signed proxy link through the edge: ${got.status} ${got.headers["content-type"]}`);
if (got.buf.length !== proxy.size_bytes || got.buf.subarray(4, 8).toString() !== "ftyp" || createHash("sha256").update(got.buf).digest("hex") !== proxy.sha256) {
  die("the proxy read through the edge is not the registered file");
}
for (const planted of [process.env.MARK, process.env.GPS, process.env.GPS.slice(1, 8)]) {
  if (got.buf.includes(planted)) die("a planted location, device or title tag reached the proxy");
}
if (!/no-store/.test(got.headers["cache-control"] ?? "") || !/noindex/.test(got.headers["x-robots-tag"] ?? "")) die("the signed media answer is cacheable or indexable");
const ranged = await req("GET", proxyPath, { range: "bytes=0-99" });
if (ranged.status !== 206 || ranged.buf.length !== 100) die(`a ranged GET of the proxy (the player seeks): ${ranged.status}`);
const t = await req("GET", await link(thumb));
if (t.status !== 200 || !/^image\/jpeg/.test(t.headers["content-type"] ?? "") || t.buf.length !== thumb.size_bytes) die(`signed thumbnail link: ${t.status}`);
say("signed proxy and thumbnail links from public /v1, read through the edge: video/mp4 (ranges too) and image/jpeg, no-store, no planted tag: ok");
const sig = proxyPath.match(/X-Amz-Signature=([0-9a-f]+)/)[1];
const tampered = proxyPath.replace(sig, sig.slice(0, -1) + (sig.endsWith("0") ? "1" : "0"));
for (const [what, method, p] of [["a tampered signature", "GET", tampered], ["no signature", "GET", proxyPath.split("?")[0]],
  ["a PUT", "PUT", proxyPath], ["a DELETE", "DELETE", proxyPath]]) {
  const r = await req(method, p, {}, method === "PUT" ? "x" : undefined);
  if (r.status !== 403) die(`${what} on a derived file through the edge: ${r.status} (want 403)`);
}
say("a tampered or missing signature, a PUT and a DELETE on a derived file are refused (403): ok");
// A photo original: the API verifies it as before, and the worker is never given it (it makes no light copy of a still).
const list = JSON.parse((await pub("GET", "/materials", bearer)).body).items.filter((x) => x.id !== mid);
let photo;
for (const x of list) if ((await upload(x.id, "/clip/photo.jpg", `${process.env.MARK}-photo.jpg`, "image/jpeg")).status === 201) { photo = x.id; break; }
if (!photo) die("no material took the photo upload");
say("a photo original is verified by the API itself: ok");
JS
)")" || { echo "$out"; fail "the worker's output through the edge"; }
echo "$out"

# Re-running the backfill changes nothing: the clip is done and the photo is not the worker's.
bf="$("$HERE/backfill-media.sh" 2>/dev/null)" || fail "backfill-media.sh failed on a second run"
[ "$(field "$bf" eligible)" = 0 ] && [ "$(field "$bf" enqueued)" = 0 ] || fail "a second backfill: $bf"
[ "$(rx XLEN media:dead)" = 0 ] || fail "the worker dead-lettered an event"
echo "backfill-media.sh again: nothing eligible, nothing given, nothing dead-lettered: ok"

# The API keeps the worker's probe of an original it verified itself (addendum to ADR 0092; the render precondition reads it).
orig_id="$(sql "SELECT file_id FROM upload_sessions WHERE material_id = '$MATERIAL' AND kind = 'original' AND state = 'verified'")"
probe_of() { sql "SELECT technical->>'video_codec', duration_ms > 5000, width, height FROM material_files WHERE id = '$orig_id'"; }
probe0="$(probe_of)"
[ "$probe0" = "h264 t 1280 720" ] || fail "the API did not keep the worker's probe of the original it verified itself: '$probe0'"
# An original processed before that (the preview until this change) is given again for its probe alone: the worker's report
# fills it, and the existing proxy is registered as it is, not encoded again.
proxy0="$(sql "SELECT id, sha256 FROM material_files WHERE derived_from_id = '$orig_id' AND kind = 'proxy'")"
sql "UPDATE material_files SET technical = NULL, duration_ms = NULL, start_pts_us = NULL, width = NULL, height = NULL WHERE id = '$orig_id'" >/dev/null
bf="$("$HERE/backfill-media.sh" 2>/dev/null)" || fail "backfill-media.sh failed for an original with no probe"
[ "$(field "$bf" eligible)" = 1 ] && [ "$(field "$bf" enqueued)" = 1 ] || fail "an original with no probe was not given again: $bf"
for _ in $(seq 1 60); do
  "${C[@]}" logs --no-color media-worker 2>&1 | grep 'event done' | tail -1 | grep -q 'outcome=verified+proxy-existing' && break
  sleep 2
done
"${C[@]}" logs --no-color media-worker 2>&1 | grep 'event done' | tail -1 | grep -q 'outcome=verified+proxy-existing' \
  || fail "the worker did not register the existing proxy for the probe backfill"
[ "$(probe_of)" = "$probe0" ] || fail "the probe backfill did not restore the original's probe"
[ "$(sql "SELECT id, sha256 FROM material_files WHERE derived_from_id = '$orig_id' AND kind = 'proxy'")" = "$proxy0" ] \
  || fail "the probe backfill made a new proxy"
bf="$("$HERE/backfill-media.sh" 2>/dev/null)" || fail "backfill-media.sh failed after the probe backfill"
[ "$(field "$bf" eligible)" = 0 ] && [ "$(field "$bf" enqueued)" = 0 ] && [ "$(rx XLEN media:dead)" = 0 ] || fail "after the probe backfill: $bf"
echo "the API keeps the worker's probe of an original it verified itself, and an original with none is given again for it alone (proxy registered as it was): ok"

# The worker's MinIO user: reads an upload but not its tus .info (file metadata), writes derived/ only, deletes and lists nothing.
# The object of a verified upload, from the API's own record; tusd writes its metadata beside it, the same name with ".info".
key="$("${C[@]}" exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At -c "SELECT storage_key FROM upload_sessions WHERE state = '"'verified'"' AND storage_key IS NOT NULL LIMIT 1"')"
[[ "$key" =~ ^[A-Za-z0-9][A-Za-z0-9._/-]*$ && "$key" != *..* ]] || fail "no verified upload object to check the worker's MinIO user against"
policy="$(mcx "obj=$key"'
meta="$(printf "%s.%s" "$obj" info)"
t() { if echo z | mc --config-dir /tmp/mc "$@" >/dev/null 2>&1; then echo allow; else echo deny; fi; }
echo "read-upload $(t cat "w/$S3_BUCKET_UPLOADS/$obj")"
echo "read-info $(t cat "w/$S3_BUCKET_UPLOADS/$meta")"
echo "list-uploads $(t ls "w/$S3_BUCKET_UPLOADS/")"
echo "write-uploads $(t pipe "w/$S3_BUCKET_UPLOADS/policy-check")"
echo "write-derived $(t pipe "w/$S3_BUCKET_MEDIA/derived/policy-check")"
echo "read-derived $(t cat "w/$S3_BUCKET_MEDIA/derived/policy-check")"
echo "write-elsewhere $(t pipe "w/$S3_BUCKET_MEDIA/policy-check")"
echo "delete-derived $(t rm "w/$S3_BUCKET_MEDIA/derived/policy-check")"' 2>&1)" || { echo "$policy" | tail -3; fail "could not check the worker's MinIO user"; }
want_policy="read-upload allow
read-info deny
list-uploads deny
write-uploads deny
write-derived allow
read-derived allow
write-elsewhere deny
delete-derived deny"
[ "$(grep -E '^(read|list|write|delete)-' <<<"$policy")" = "$want_policy" ] || { echo "$policy" >&2; fail "the worker's MinIO user can do more or less than ADR 0092 says"; }
echo "the worker's MinIO user reads uploads but not their .info, writes derived/ only, lists and deletes nothing: ok"

# media-render's MinIO user: the same uploads, and derived/<material>/<original>/renders/ alone: not the proxy beside it.
proxy_key="$(sql "SELECT storage_key FROM material_files WHERE kind = 'proxy' AND state = 'verified' LIMIT 1")"
[[ "$proxy_key" =~ ^derived/[0-9a-f-]{36}/[0-9a-f-]{36}/proxy-480p\.mp4$ ]] || fail "no verified proxy to check media-render's MinIO user against"
rpolicy="$(mcx "obj=$key proxy=$proxy_key"'
meta="$(printf "%s.%s" "$obj" info)"
mine="${proxy%/proxy-480p.mp4}/renders/00000000-0000-4000-8000-000000000000/circulated-vertical.mp4"
t() { if echo z | mc --config-dir /tmp/mc "$@" >/dev/null 2>&1; then echo allow; else echo deny; fi; }
echo "read-upload $(t cat "r/$S3_BUCKET_UPLOADS/$obj")"
echo "read-info $(t cat "r/$S3_BUCKET_UPLOADS/$meta")"
echo "write-uploads $(t pipe "r/$S3_BUCKET_UPLOADS/policy-check")"
echo "write-render $(t pipe "r/$S3_BUCKET_MEDIA/$mine")"
echo "read-render $(t cat "r/$S3_BUCKET_MEDIA/$mine")"
echo "read-proxy $(t cat "r/$S3_BUCKET_MEDIA/$proxy")"
echo "write-beside $(t pipe "r/$S3_BUCKET_MEDIA/${proxy%.mp4}-check.mp4")"
echo "list-derived $(t ls "r/$S3_BUCKET_MEDIA/derived/")"
echo "delete-render $(t rm "r/$S3_BUCKET_MEDIA/$mine")"' 2>&1)" || { echo "$rpolicy" | tail -3; fail "could not check media-render's MinIO user"; }
want_rpolicy="read-upload allow
read-info deny
write-uploads deny
write-render allow
read-render allow
read-proxy deny
write-beside deny
list-derived deny
delete-render deny"
[ "$(grep -E '^(read|list|write|delete)-' <<<"$rpolicy")" = "$want_rpolicy" ] || { echo "$rpolicy" >&2; fail "media-render's MinIO user can do more or less than the addendum to ADR 0092 says"; }
echo "media-render's MinIO user reads uploads but not their .info, writes derived/*/*/renders/ only (not the proxy beside it), lists and deletes nothing: ok"

# tusd and the API on their own MinIO users, not the root one (minio-init's alone): tusd reads and writes the upload bucket
# only; the API reads both buckets and deletes tus objects, and writes nothing. The uploads and the renders above ran on them.
for svc in api tusd; do
  envs="$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$("${C[@]}" ps -q "$svc")")"   # captured: pipefail + grep -q
  grep -qxE "(S3_ACCESS_KEY|AWS_ACCESS_KEY_ID)=$(val S3_ACCESS_KEY)" <<<"$envs" && fail "$svc runs on MinIO's root user"
  grep -qxE "(S3_ACCESS_KEY|AWS_ACCESS_KEY_ID)=$(val "S3_${svc^^}_ACCESS_KEY")" <<<"$envs" || fail "$svc does not run on its own MinIO user"
done
spolicy="$(mcx "obj=$key proxy=$proxy_key"'
echo z | mc --config-dir /tmp/mc pipe "local/$S3_BUCKET_UPLOADS/policy-check-api" >/dev/null || exit 1
echo z | mc --config-dir /tmp/mc pipe "local/$S3_BUCKET_MEDIA/derived/policy-check-api" >/dev/null || exit 1
t() { if echo z | mc --config-dir /tmp/mc "$@" >/dev/null 2>&1; then echo allow; else echo deny; fi; }
echo "tusd-read-upload $(t cat "u/$S3_BUCKET_UPLOADS/$obj")"
echo "tusd-write-upload $(t pipe "u/$S3_BUCKET_UPLOADS/policy-check-tusd")"
echo "tusd-delete-upload $(t rm "u/$S3_BUCKET_UPLOADS/policy-check-tusd")"
echo "tusd-read-derived $(t cat "u/$S3_BUCKET_MEDIA/$proxy")"
echo "tusd-write-derived $(t pipe "u/$S3_BUCKET_MEDIA/derived/policy-check")"
echo "tusd-admin $(t admin user list u)"
echo "api-read-upload $(t cat "p/$S3_BUCKET_UPLOADS/$obj")"
echo "api-read-derived $(t cat "p/$S3_BUCKET_MEDIA/$proxy")"
echo "api-write-upload $(t pipe "p/$S3_BUCKET_UPLOADS/policy-check-api-write")"
echo "api-write-derived $(t pipe "p/$S3_BUCKET_MEDIA/derived/policy-check")"
echo "api-delete-derived $(t rm "p/$S3_BUCKET_MEDIA/derived/policy-check-api")"
echo "api-delete-upload $(t rm "p/$S3_BUCKET_UPLOADS/policy-check-api")"
echo "api-admin $(t admin user list p)"' 2>&1)" || { echo "$spolicy" | tail -3; fail "could not check the tusd and API MinIO users"; }
want_spolicy="tusd-read-upload allow
tusd-write-upload allow
tusd-delete-upload allow
tusd-read-derived deny
tusd-write-derived deny
tusd-admin deny
api-read-upload allow
api-read-derived allow
api-write-upload deny
api-write-derived deny
api-delete-derived deny
api-delete-upload allow
api-admin deny"
[ "$(grep -E '^(tusd|api)-' <<<"$spolicy")" = "$want_spolicy" ] || { echo "$spolicy" >&2; fail "the tusd or API MinIO user can do more or less than minio-init.sh says"; }
echo "tusd and the API on their own MinIO users (tusd: the upload bucket only; the API: reads both, deletes tus objects, writes nothing), not the root one: ok"

# Measurement (--media-json): a synthetic 60 s clip per profile, end to end on the worker as deployed (its limits, the edge,
# the API's verification, the feeder), timed from the job's delivery to its acknowledgement on the queue.
cgdir() { local id d; id="$(docker inspect -f '{{.Id}}' "$1")"
  for d in "/sys/fs/cgroup/system.slice/docker-$id.scope" "/sys/fs/cgroup/docker/$id"; do [ -r "$d/memory.current" ] && { echo "$d"; return; }; done; }
cgread() { if [ -n "$cg" ]; then cat "$cg/$1"; else docker exec "$wid" cat "/sys/fs/cgroup/$1"; fi; }
scratch_vol="$(docker volume inspect -f '{{.Mountpoint}}' post-history-preview_media-scratch)"
host_du=0
sudo -n du -sb "$scratch_vol" >/dev/null 2>&1 && host_du=1
scratch_bytes() { if [ "$host_du" = 1 ]; then sudo -n du -sb "$scratch_vol" | cut -f1; else docker exec "$wid" du -sb /scratch | cut -f1; fi; }
measure() {
  local prof="$1" size br g0 gen_s mout mid cpu0 cpu1 t_on="" t_off="" p deadline spid
  case "$prof" in 1080p) size=1920x1080 br=16M ;; 2160p) size=3840x2160 br=45M ;; *) fail "unknown profile $prof" ;; esac
  g0=$SECONDS
  gen -f lavfi -i "testsrc2=size=$size:rate=30:duration=60" -f lavfi -i "sine=frequency=1000:sample_rate=48000:duration=60" \
    -vf "noise=alls=8:allf=t" -c:v libx264 -preset veryfast -b:v "$br" -maxrate "$br" -bufsize "$br" -pix_fmt yuv420p \
    -c:a aac -b:a 128k "${TAGS[@]}" "/out/m-$prof.mov" || fail "could not make the $prof clip"
  gen_s=$((SECONDS - g0))
  mout="$(EMAIL="$(val PREVIEW_REPORTER_EMAIL)" PASSWORD="$(val PREVIEW_REPORTER_PASSWORD)" DOMAIN="$DOMAIN" CLIP="/clip/m-$prof.mov" probe <<<"$JS_LIB
$(cat <<'JS'
const id = await newMaterial();
// 64 MiB PATCHes, as the iOS background session sends them (ADR 0009).
if ((await upload(id, process.env.CLIP, `${process.env.MARK}-measure.mov`, "video/quicktime", 64 * 1024 * 1024)).status !== 201) {
  die("the measurement upload");
}
say(`MATERIAL=${id}`);
JS
)")" || { echo "$mout"; api_state; fail "the $prof measurement upload"; }
  mid="$(sed -n 's/^MATERIAL=//p' <<<"$mout")"
  MEASURED+=("$prof:$mid")
  # A fresh cgroup for the worker, so memory.peak is this job's.
  docker restart "$wid" >/dev/null && sleep 3
  cg="$(cgdir "$wid")"
  cpu0="$(cgread cpu.stat | awk '$1 == "usage_usec" { print $2 }')"
  touch "$work/sampling"
  ( while [ -e "$work/sampling" ]; do
      echo "$(cgread memory.current) $(cgread memory.stat | awk '$1 == "anon" { print $2 }') $(scratch_bytes)"; sleep 0.5
    done ) > "$work/samples-$prof" 2>/dev/null &
  spid=$!
  bf="$(feed)" && [ "$(field "$bf" enqueued)" = 1 ] || { rm -f "$work/sampling"; fail "the $prof job was not given to the worker: $bf"; }
  deadline=$((SECONDS + 900))
  while [ "$SECONDS" -lt "$deadline" ]; do
    p="$(rx XPENDING media:events media | head -1)"
    if [ -z "$t_on" ] && [ "$p" != 0 ]; then t_on="$(date +%s.%N)"; fi
    if [ -n "$t_on" ] && [ "$p" = 0 ]; then t_off="$(date +%s.%N)"; break; fi
    sleep 0.25
  done
  rm -f "$work/sampling"; wait "$spid" || true
  [ -n "$t_off" ] || fail "the $prof job did not finish within 15 min"
  cpu1="$(cgread cpu.stat | awk '$1 == "usage_usec" { print $2 }')"
  local peak oom outcome objects
  peak="$(cgread memory.peak 2>/dev/null || echo "")"
  oom="$(cgread memory.events | awk '$1 == "oom_kill" { print $2 }')"
  outcome="$("${C[@]}" logs --no-color media-worker 2>&1 | grep 'event done' | tail -1 | sed -n 's/.*outcome=\([a-z+-]*\).*/\1/p')"
  mcx "mc --config-dir /tmp/mc ls --recursive --json local/\$S3_BUCKET_MEDIA/derived/$mid/" > "$work/objects-$prof" \
    || fail "could not list the $prof outputs"
  mkdir -p "$MEDIA_OUT"
  python3 - "$MEDIA_OUT/preview-media-worker-$prof.json" "$prof" "$work/samples-$prof" "$work/m-$prof.mov" "$gen_s" "$cpu0" "$cpu1" \
    "$t_on" "$t_off" "${peak:-}" "${oom:-0}" "$outcome" "$work/objects-$prof" <<'PY' || fail "the $prof measurement"
import datetime, json, os, sys
out, prof, samples, clip, gen_s, cpu0, cpu1, t_on, t_off, peak, oom, outcome, listing = sys.argv[1:14]
rows = [[int(x) for x in l.split()] for l in open(samples) if len(l.split()) == 3]
objs = [json.loads(l) for l in open(listing) if l.startswith("{")]
size = lambda name: sum(o.get("size", 0) for o in objs if o.get("key", "").endswith(name))
mib = lambda b: round(b / 2**20, 1)
derived = sum(o.get("size", 0) for o in objs)
orig = os.path.getsize(clip)
peak_b = int(peak) if peak else max(r[0] for r in rows)
limit = 1472 * 2**20
ok = int(oom) == 0 and peak_b < limit and outcome == "verified+proxy+thumbnails"
ts = lambda t: datetime.datetime.fromtimestamp(float(t), datetime.timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
res = {"schema_version": 1, "tool": "other", "role": "infra", "test_name": f"preview-media-worker-60s-{prof}",
       "started_at": ts(t_on), "ended_at": ts(t_off), "result": "pass" if ok else "fail",
       "device": {"platform": "server", "model": os.environ.get("MEASURE_HOST", "local docker compose")},
       "upload_path": "tusd",
       "file": {"size_bytes": orig, "duration_s": 60.0, "bitrate_kbps": round(orig * 8 / 60 / 1000), "codec": "h264", "vfr": False, "hdr": False},
       "metrics": {"resolution": {"1080p": "1920x1080", "2160p": "3840x2160"}[prof], "frame_rate": 30,
                   "worker_mem_limit_mib": 1472, "worker_cpus": 1.5,
                   "worker_memory_peak_mib": mib(peak_b), "worker_memory_peak_source": "cgroup memory.peak" if peak else "sampled memory.current",
                   "worker_anon_peak_mib_sampled": mib(max(r[1] for r in rows)), "worker_oom_kills": int(oom),
                   "worker_cpu_s": round((int(cpu1) - int(cpu0)) / 1e6, 1), "job_wall_s": round(float(t_off) - float(t_on), 1),
                   "scratch_peak_mib_sampled": mib(max(r[2] for r in rows)), "original_mib": mib(orig),
                   "derived_total_bytes": derived, "proxy_bytes": size("proxy-480p.mp4"), "poster_bytes": size("poster.jpg"),
                   "contact_sheet_bytes": size("contact-sheet.jpg"), "derived_to_original_pct": round(100 * derived / orig, 2),
                   "worker_outcome": outcome, "clip_generate_s": int(gen_s), "samples": len(rows)},
       "notes": ("infra/preview/smoke-preview.sh --media-json (ADR 0092): a synthetic clip (ffmpeg testsrc2 with temporal noise and a "
                 "sine tone, H.264 at a phone-like bit rate, planted location and device tags) uploaded through the preview edge, "
                 "verified by the API, then given to the media worker by the feeder. Wall time is from the job's delivery to its "
                 "acknowledgement on media:events (download, hash match, 480p proxy, poster and contact sheet, registration), polled "
                 "every 0.25 s. CPU time from the worker's cgroup cpu.stat; memory.peak includes page cache; anon is sampled every "
                 "0.5 s. Worker limits as deployed (1472 MiB, no swap, 1.5 CPU). Synthetic content, not a phone file; not the shared "
                 "server itself.")}
json.dump(res, open(out, "w"), indent=2)
print(json.dumps(res["metrics"]))
sys.exit(0 if ok else 1)
PY
  echo "measured $prof: see $MEDIA_OUT/preview-media-worker-$prof.json"
}
# The API verifies every upload itself (in_process), large ones included, and a login's argon2 hash comes on top: after each
# large upload its restarts, OOM flag and cgroup memory.peak are printed (kept for the --json file), and a restart fails.
api_peak_mb=0
MEASURED=()
api_state() {
  local aid acg s r o pk
  aid="$("${C[@]}" ps -q api)"
  for _ in $(seq 1 60); do [ "$(docker inspect -f '{{.State.Health.Status}}' "$aid")" = healthy ] && break; sleep 1; done
  read -r s r o <<<"$(docker inspect -f '{{.State.Health.Status}} {{.RestartCount}} {{.State.OOMKilled}}' "$aid")"
  acg="$(cgdir "$aid")"
  pk="$([ -n "$acg" ] && echo $(( $(cat "$acg/memory.peak") / 1048576 )) || echo 0)"
  [ "$pk" -gt "$api_peak_mb" ] && api_peak_mb="$pk"
  echo "api: $s, restarts $r, last exit OOM-killed $o, memory.peak $pk MiB of $(( $(docker inspect -f '{{.HostConfig.Memory}}' "$aid") / 1048576 ))"
  [ "$r" = 0 ] && [ "$o" = false ] && [ "$s" = healthy ] || fail "the API restarted or is unhealthy after a large upload (restarts $r, OOM-killed $o)"
}
# tusd under one 64 MiB PATCH (the iOS background session's size, ADR 0009) with the preview's 5 MiB parts: a fresh cgroup,
# then memory.peak (with page cache) and anon sampled every 10 ms from the host. Random bytes as application/octet-stream,
# so the feeder never gives them to the worker.
measure_tusd() {
  local tid tcg peak oom t0 t1 tout limit
  tid="$("${C[@]}" ps -q tusd)"
  docker restart "$tid" >/dev/null
  for _ in $(seq 1 30); do [ "$(docker inspect -f '{{.State.Health.Status}}' "$tid")" = healthy ] && break; sleep 1; done
  tcg="$(cgdir "$tid")"
  [ -n "$tcg" ] || fail "no host cgroup for tusd (the 64 MiB PATCH measurement reads memory.peak there)"
  rm -f "$work/tusd-stop"
  python3 - "$tcg" "$work/tusd-stop" > "$work/tusd-sampled" <<'PY' &
import os, sys, time
cg, stop = sys.argv[1], sys.argv[2]
cur = anon = 0
while not os.path.exists(stop):
    try:
        cur = max(cur, int(open(cg + "/memory.current").read()))
        anon = max(anon, next(int(l.split()[1]) for l in open(cg + "/memory.stat") if l.startswith("anon ")))
    except (OSError, ValueError, StopIteration):
        pass
    time.sleep(0.01)
print(cur, anon)
PY
  local sp=$!
  t0="$(date +%s.%N)"
  tout="$(EMAIL="$(val PREVIEW_REPORTER_EMAIL)" PASSWORD="$(val PREVIEW_REPORTER_PASSWORD)" DOMAIN="$DOMAIN" probe <<<"$JS_LIB
$(cat <<'JS'
const id = await newMaterial();
const size = 64 * 1024 * 1024;
if ((await upload(id, (await import("node:crypto")).randomBytes(size), `${process.env.MARK}-tusd.bin`, "application/octet-stream", size)).status !== 201) {
  die("the 64 MiB single-PATCH upload");
}
say("one 64 MiB PATCH through the edge, the gate and tusd, verified: ok");
JS
)")" || { touch "$work/tusd-stop"; echo "$tout"; fail "the 64 MiB single-PATCH upload (tusd OOM-killed: $(cat "$tcg/memory.events" 2>/dev/null | tr '\n' ' '))"; }
  t1="$(date +%s.%N)"
  touch "$work/tusd-stop"; wait "$sp" || true
  echo "$tout"
  peak="$(cat "$tcg/memory.peak")" oom="$(awk '$1 == "oom_kill" { print $2 }' "$tcg/memory.events")"
  limit="$(docker inspect -f '{{.HostConfig.Memory}}' "$tid")"
  python3 - "$MEDIA_OUT/preview-tusd-64mib-patch.json" "$peak" "$oom" "$limit" "$t0" "$t1" $(cat "$work/tusd-sampled") <<'PY' || fail "tusd under one 64 MiB PATCH"
import datetime, json, os, sys
out, peak, oom, limit, t0, t1, cur, anon = sys.argv[1:9]
mib = lambda b: round(int(b) / 2**20, 1)
ts = lambda t: datetime.datetime.fromtimestamp(float(t), datetime.timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
ok = int(oom) == 0 and int(peak) < int(limit)
json.dump({"schema_version": 1, "tool": "other", "role": "infra", "test_name": "preview-tusd-one-64mib-patch",
           "started_at": ts(t0), "ended_at": ts(t1), "result": "pass" if ok else "fail",
           "device": {"platform": "server", "model": os.environ.get("MEASURE_HOST", "local docker compose")}, "upload_path": "tusd",
           "file": {"size_bytes": 64 * 2**20},
           "metrics": {"patch_bytes": 64 * 2**20, "tusd_part_size_bytes": 5 * 2**20, "tusd_mem_limit_mib": mib(limit),
                       "tusd_memory_peak_mib": mib(peak), "tusd_memory_current_peak_mib_sampled": mib(cur),
                       "tusd_anon_peak_mib_sampled": mib(anon), "tusd_oom_kills": int(oom), "upload_s": round(float(t1) - float(t0), 1)},
           "notes": ("infra/preview/smoke-preview.sh --media-json (ADR 0092): tusd v2.10.1 as the preview runs it (-s3-part-size and "
                     "-s3-min-part-size 5 MiB, temporary parts on a volume, GOMEMLIMIT 40MiB), restarted for a fresh cgroup, then one "
                     "upload of 64 MiB of random bytes in a single PATCH through the edge and the ingest gate, as the iOS background "
                     "session sends (ADR 0009). memory.peak is the cgroup high-water mark, page cache of the temporary parts included; "
                     "anon and memory.current sampled every 10 ms from the host. Upload time includes the probe container, two logins "
                     "and the API's verification.")},
          open(out, "w"), indent=2)
print(f"tusd: memory.peak {mib(peak)} MiB, anon {mib(anon)} MiB, limit {mib(limit)} MiB, oom kills {oom}")
sys.exit(0 if ok else 1)
PY
}
if [ -n "$MEDIA_OUT" ]; then
  mkdir -p "$MEDIA_OUT"
  measure_tusd
  api_state
  for prof in ${MEDIA_PROFILES:-1080p}; do measure "$prof"; api_state; done
fi

# The feeder as a service: back on, it logs that it started and nothing else while there is nothing to do.
started="$("${C[@]}" up -d --no-deps media-feeder 2>&1)" || { echo "$started" | tail -5; fail "media-feeder does not start"; }
sleep 12
"${C[@]}" logs --no-color media-feeder 2>&1 | grep -q '"msg":"media feeder started"' || fail "media-feeder did not start its loop"
[ "$(docker inspect -f '{{.State.Running}}' "$("${C[@]}" ps -q media-feeder)")" = true ] || fail "media-feeder is not running"

# No title, file name, location or device in what the worker and the feeder log (CLAUDE.md §5), and only counts from the feeder.
media_logs="$("${C[@]}" logs --no-color media-worker media-feeder 2>&1)"
for planted in "$MARK" "$GPS" "${GPS:1:7}" "مادة" "Test city"; do
  if grep -qF -- "$planted" <<<"$media_logs"; then fail "the worker or feeder log carries a title, file name, location or device"; fi
done
grep -q 'event done' <<<"$media_logs" || fail "nothing in the worker log (cannot check it)"
echo "worker and feeder logs: no title, file name, location or device tag: ok"

# MinIO healthy before its admin API is read. A restart under the large uploads above is a finding, not something to wait out:
# its restart count and OOM flag are printed, and an OOM kill fails the smoke.
minio_id="$("${C[@]}" ps -q minio)"
minio_ready() {
  local s r o
  for _ in $(seq 1 60); do [ "$(docker inspect -f '{{.State.Health.Status}}' "$minio_id")" = healthy ] && break; sleep 1; done
  read -r s r o <<<"$(docker inspect -f '{{.State.Health.Status}} {{.RestartCount}} {{.State.OOMKilled}}' "$minio_id")"
  local mcg; mcg="$(cgdir "$minio_id")"
  echo "minio: $s, restarts $r, last exit OOM-killed $o${mcg:+, memory.peak $(( $(cat "$mcg/memory.peak") / 1048576 )) MiB of $(( $(docker inspect -f '{{.HostConfig.Memory}}' "$minio_id") / 1048576 )), oom_kill $(awk '$1 == "oom_kill" { print $2 }' "$mcg/memory.events")}"
  [ "$o" = false ] || fail "MinIO was OOM-killed under the uploads above"
  [ "$s" = healthy ] || fail "MinIO is not healthy"
}
minio_ready

# Storage ceiling: hard quotas, uploads 10112 MiB and derived files 2048 MiB, tusd's 64 MiB outside, stale uploads after 24 h.
storage="$(docker run --rm --network post-history-preview_internal --env-file "$HERE/.env" --entrypoint sh "$mc_image" -c 'mc --config-dir /tmp/mc alias set local http://minio:9000 "$S3_ACCESS_KEY" "$S3_SECRET_KEY" >/dev/null && mc --config-dir /tmp/mc quota info --json "local/$S3_BUCKET_UPLOADS" && mc --config-dir /tmp/mc quota info --json "local/$S3_BUCKET_MEDIA" && mc --config-dir /tmp/mc admin config get local api' 2>&1)" \
  || { echo "$storage" | tail -5; minio_ready; fail "could not read the storage quotas"; }
quota_total="$(python3 -c '
import json, sys
print(sum(json.loads(l).get("quota", 0) for l in sys.stdin if l.startswith("{")))' <<<"$storage")"
[ "$quota_total" = $((10112 * 1048576 + 2048 * 1048576)) ] || fail "bucket quotas add up to $quota_total bytes (want 10112 MiB of uploads and 2048 MiB of derived files)"
grep -qx '# MINIO_API_STALE_UPLOADS_EXPIRY=24h' <<<"$storage" || fail "abandoned multipart uploads are not set to expire after 24 h"
echo "storage ceiling: hard quotas $((quota_total / 1048576)) MiB + 64 MiB for tusd parts, stale uploads deleted after 24 h: ok"

# Actual use after the requests above, under the same limit.
sleep 5
used_mb="$(docker stats --no-stream --format '{{.MemUsage}}' $("${C[@]}" ps -q) | python3 -c '
import re, sys
unit = {"B": 1, "KiB": 2**10, "MiB": 2**20, "GiB": 2**30, "kB": 1e3, "MB": 1e6, "GB": 1e9}
t = 0
for line in sys.stdin:
    n, u = re.match(r"\s*([\d.]+)\s*([A-Za-z]+)", line).groups(); t += float(n) * unit[u]
print(round(t / 2**20))')"
docker stats --no-stream --format '{{.Name}} {{.MemUsage}}' $("${C[@]}" ps -q)
[ "$used_mb" -lt "$total" ] || fail "memory in use $used_mb MB is not under the limits ($total MB)"
echo "memory in use: $used_mb MB of $total MB limits (ceiling $LIMIT_MB MB): ok"

# ---- Circulated-template renders (ADR 0091 §8: evaluation on the preview; addendum to ADR 0092) ----
. "$HERE/smoke-renders.sh"

logs="$("${C[@]}" logs --no-color 2>&1)"
# Upload ids are bearer capabilities (SEC-06): the edge, the gate and the proxy log /files/-, never /files/<id>.
edge_logs="$("${C[@]}" logs --no-color web ingest-gate tusd-proxy 2>&1)"
# Anchored to the tus path itself (method, then a path starting /files/): /v1/materials/<id>/files/<id>/download-url carries
# material and file ids, which are not capabilities.
tus_id_re=' (GET|HEAD|PATCH|POST|PUT|DELETE|OPTIONS) /files/[A-Za-z0-9]'
if grep -qE "$tus_id_re" <<<"$edge_logs"; then grep -E "$tus_id_re" <<<"$edge_logs" | head -3 | cut -c1-200 >&2; fail "an upload id in an edge log"; fi
grep -qF '/files/-' <<<"$edge_logs" || fail "no redacted upload path in the edge logs (nothing logged?)"
for k in POSTGRES_PASSWORD REDIS_PASSWORD S3_SECRET_KEY JWT_SECRET PREVIEW_REPORTER_PASSWORD TUSD_HOOK_SECRET INGEST_GATE_TOKEN \
         MEDIA_WORKER_TOKEN S3_MEDIA_SECRET_KEY S3_RENDER_SECRET_KEY S3_TUSD_SECRET_KEY S3_API_SECRET_KEY; do
  if grep -qF "$(val "$k")" <<<"$logs"; then fail "$k appears in a container log"; fi
done
echo "no secret in the logs: ok"

if [ -n "$JSON" ]; then
  mkdir -p "$(dirname "$JSON")"
  python3 - "$JSON" "$total" "$used_mb" "$LIMIT_MB" "$api_peak_mb" <<'PY'
import json, os, sys, datetime
out, total, used, ceiling, api_peak = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), int(sys.argv[4]), int(sys.argv[5])
now = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
json.dump({"schema_version": 1, "tool": "other", "role": "infra", "started_at": now, "ended_at": now,
           "result": "pass" if used < total <= ceiling else "fail",
           "device": {"platform": "server", "model": os.environ.get("MEASURE_HOST", "local docker compose")},
           "metrics": {"memory_limits_mb": total, "memory_used_mb": used, "memory_ceiling_mb": ceiling,
                       "api_memory_peak_mib_after_large_uploads": api_peak},
           "notes": "infra/preview/smoke-preview.sh (ADR 0023, 0092): preview compose on images built in CI (infra/preview/*.Dockerfile and workers/media), with tusd, its proxy, the ingest gate, the media worker and its feeder, after a demo login, a few page loads, a synthetic clip and photo uploaded through the edge and the worker's proxy and thumbnail (and any --media-json clips). Not the shared server itself."},
          open(out, "w"), indent=2)
PY
fi
echo "light preview smoke: ok"
