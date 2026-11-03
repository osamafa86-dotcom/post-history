# نسخ قالب «مواد متداولة» على المعاينة (ADR 0091 البند 8 للتقييم، ملحق ADR 0092): جزء من smoke-preview.sh يُقرأ منه بعد
# «الذاكرة المستعملة» (يستعمل دواله ومتغيراته: C وwork وfeed وsql وcgdir وJS_LIB وMATERIAL وMEASURED وMEDIA_OUT)، ولا يُشغَّل وحده.
# بمواد اصطناعية وحدها: المقطع الأول بوسومه المزروعة ونسخته الخفيفة، ومقاطع القياس 60 ث مع --media-json.
#   - النسخة لا تُطلب والمادة في الوارد (409 render_not_allowed، editorial_state)، ثم يقبلها المشرف تحريريًا.
#   - حارس القرص لكل نسخة: بعتبة لا يبلغها القرص، ثم بقرص فوق الحد الأدنى ودون ميزانية النسخة (حجم الأصل + 1 GiB فوقه)، لا تصل
#     media:renders والنسخة تبقى requested.
#   - نسخة عمودية بالوسم وبلا مكان تصير ready، ويُقرأ ملفها برابط موقّع من /v1 عبر الحافة: video/mp4 بمقاس 1080×1920 وH.264
#     yuv420p بنطاق tv وBT.709، بلا الوسوم المزروعة ولا العنوان؛ ولا رابط ولا قائمة للمراسل.
#   - سطر أعرض من صندوقه حتى عند 70% يصير failed بـ title_overflow بلا ملف.
#   - ذروة ذاكرة media-render (memory.peak بحدوده كما تُنشر) وخموله وزمن معالجه وقرصه، وسجله بلا عنوان ولا مكان ولا وسم.
# شرط source يقرأ فحص العامل الذي يسجّله الخادم لأصل تحقق منه بنفسه (in_process، ملحق ADR 0092)؛ غيابه رسالة صريحة.
# shellcheck shell=bash

"${C[@]}" stop media-feeder >/dev/null 2>&1 || fail "could not stop media-feeder for the renders"
SUP_EMAIL="$(val PREVIEW_SUPERVISOR_EMAIL)" SUP_PASSWORD="$(val PREVIEW_SUPERVISOR_PASSWORD)"
REPORTER_EMAIL="$(val PREVIEW_REPORTER_EMAIL)" REPORTER_PASSWORD="$(val PREVIEW_REPORTER_PASSWORD)"
export REPORTER_EMAIL REPORTER_PASSWORD
mkdir -p "$work/rendered" && chmod 777 "$work/rendered"
# As probe, with a writable /rendered for the file read through the edge (ffprobe reads it after).
probe_rw() { docker run --rm -i --network deploy_default -v "$work:/clip:ro" -v "$work/rendered:/rendered" -e DOMAIN -e EMAIL -e PASSWORD \
  -e REPORTER_EMAIL -e REPORTER_PASSWORD -e MARK -e GPS -e MATERIAL -e RENDER_OK -e RENDER_OVERFLOW \
  --entrypoint node post-history-preview-api:latest --input-type=module -; }
rfield() { python3 -c 'import json, sys; print(json.loads(sys.argv[1])["renders"][sys.argv[2]])' "$1" "$2"; }

# The supervisor (a render role, ADR 0091 §1) walks a material to accepted and asks for a vertical render: the title as the staff
# would write it, the tag, no location. The overflow title is 22 code points of a glyph about 1.07 em wide in the title font, so
# even the 70% floor leaves it wider than the vertical title box: title_overflow from the template, before any frame.
JS_RENDER="$JS_LIB
$(cat <<'JS'
const TITLE = ["عنوان تجريبي", "للمادة المتداولة"];
const OVERFLOW = ["Ж".repeat(22)];
const renderBody = (title_lines) => ({ template: "circulated", aspect: "vertical", title_lines, show_location: false, label: "circulated_footage" });
const BLOCKED = "render_not_allowed (source): the API holds no technical data for an original it verified itself (UPLOAD_VERIFIER=in_process): " +
  "the media worker's probe of that original was not recorded (addendum to ADR 0092)";
async function accept(mid) {
  for (const to of ["acknowledged", "reviewing", "accepted"]) {
    const t = await pub("POST", `/materials/${mid}/transitions`, { ...bearer, "idempotency-key": randomUUID() }, { track: "editorial", to, reason: "preview smoke" });
    if (t.status !== 200) die(`editorial ${to}: ${t.status} ${t.body.slice(0, 160)}`);
  }
}
async function requestRender(mid, titleLines) {
  const r = await pub("POST", `/materials/${mid}/renders`, { ...bearer, "idempotency-key": randomUUID() }, renderBody(titleLines));
  if (r.status === 409 && (JSON.parse(r.body).details?.failed ?? []).includes("source")) die(BLOCKED);
  if (r.status !== 202) die(`render request: ${r.status} ${r.body.slice(0, 200)}`);
  const b = JSON.parse(r.body);
  if (b.state !== "requested" || b.show_location !== false || b.location_text !== null || b.label !== "circulated_footage") {
    die(`render request answered ${b.state}, show_location ${b.show_location}, label ${b.label}`);
  }
  return b.id;
}
JS
)"

# media-render's cgroup from the host (or inside it), and its scratch volume.
rscratch_vol="$(docker volume inspect -f '{{.Mountpoint}}' post-history-preview_render-scratch)"
rcat() { if [ -n "$rcg" ]; then cat "$rcg/$1"; else docker exec "$rnd" cat "/sys/fs/cgroup/$1"; fi; }
rscratch() { if [ "$host_du" = 1 ]; then sudo -n du -sb "$rscratch_vol" | cut -f1; else docker exec "$rnd" du -sb /scratch | cut -f1; fi; }
# render_run LABEL SOURCE ID:EXPECT...: a fresh cgroup for media-render (restart), its idle memory, then feeder cycles every 3 s
# until every render is ready or failed; memory.peak (page cache included), sampled anon and scratch, CPU time, each render's own
# time (started to completed, from the API's record) and output size. EXPECT is ready or a failure reason. --media-json writes
# preview-media-render-LABEL.json.
render_run() {
  local label="$1" source="$2"; shift 2
  local ids=() expect=() x idle cpu0 cpu1 t0 t1 spid deadline done_n peak oom rows q
  for x in "$@"; do ids+=("${x%%:*}"); expect+=("${x#*:}"); done
  q="$(printf "'%s'," "${ids[@]}")"; q="${q%,}"
  docker restart "$rnd" >/dev/null && sleep 5
  rcg="$(cgdir "$rnd")"
  idle="$(rcat memory.current)"
  cpu0="$(rcat cpu.stat | awk '$1 == "usage_usec" { print $2 }')"
  touch "$work/rsampling"
  ( while [ -e "$work/rsampling" ]; do
      echo "$(rcat memory.current) $(rcat memory.stat | awk '$1 == "anon" { print $2 }') $(rscratch)"; sleep 0.5
    done ) > "$work/rsamples-$label" 2>/dev/null &
  spid=$!
  t0="$(date +%s.%N)" deadline=$((SECONDS + 1200))
  while :; do
    feed >/dev/null || true
    done_n="$(sql "SELECT count(*) FROM material_renders WHERE id IN ($q) AND state IN ('ready', 'failed')")"
    [ "$done_n" = "${#ids[@]}" ] && break
    if [ "$SECONDS" -ge "$deadline" ]; then
      rm -f "$work/rsampling"; sql "SELECT state, coalesce(failure_reason, '-') FROM material_renders WHERE id IN ($q)" >&2
      "${C[@]}" logs --no-color --tail 20 media-render >&2 || true
      fail "renders not finished within 20 min ($label)"
    fi
    sleep 3
  done
  t1="$(date +%s.%N)"
  rm -f "$work/rsampling"; wait "$spid" || true
  cpu1="$(rcat cpu.stat | awk '$1 == "usage_usec" { print $2 }')"
  peak="$(rcat memory.peak 2>/dev/null || echo "")" oom="$(rcat memory.events | awk '$1 == "oom_kill" { print $2 }')"
  rows="$(sql "SELECT r.id, r.state, coalesce(r.failure_reason, '-'), coalesce(round(extract(epoch FROM r.completed_at - r.started_at)::numeric, 1), -1),
    coalesce(f.size_bytes, 0) FROM material_renders r LEFT JOIN material_files f ON f.id = r.file_id WHERE r.id IN ($q)")"
  python3 - "${MEDIA_OUT:+$MEDIA_OUT/preview-media-render-$label.json}" "$label" "$source" "$work/rsamples-$label" "$idle" "$cpu0" \
    "$cpu1" "$t0" "$t1" "${peak:-}" "${oom:-0}" "$rows" "$*" <<'PY' || fail "media-render on $label"
import datetime, json, os, sys
out, label, source, samples, idle, cpu0, cpu1, t0, t1, peak, oom, rows, expect = sys.argv[1:14]
want = dict(x.split(":", 1) for x in expect.split())
samp = [[int(v) for v in l.split()] for l in open(samples) if len(l.split()) == 3]
mib = lambda b: round(int(b) / 2**20, 1)
peak_b = int(peak) if peak else max(r[0] for r in samp)
limit = 4096 * 2**20
got, metrics = {}, {}
for i, line in enumerate(sorted(rows.splitlines(), key=lambda l: list(want).index(l.split()[0]))):
    rid, state, reason, secs, size = line.split()
    got[rid] = state if state == "ready" else reason
    tag = "ready" if want[rid] == "ready" else want[rid]
    metrics.update({f"{tag}__state": state, f"{tag}__failure_reason": "none" if reason == "-" else reason,
                    f"{tag}__render_s": float(secs), f"{tag}__output_bytes": int(size)})
ok = int(oom) == 0 and peak_b < limit and got == want
ts = lambda t: datetime.datetime.fromtimestamp(float(t), datetime.timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
metrics = {"source": source, "aspect": "vertical", "render_mem_limit_mib": 4096, "render_cpus": 2, "render_cpu_shares": 128,
           "remotion_concurrency": 1, "render_idle_mib": mib(idle), "render_memory_peak_mib": mib(peak_b),
           "render_memory_peak_source": "cgroup memory.peak" if peak else "sampled memory.current",
           "render_anon_peak_mib_sampled": mib(max(r[1] for r in samp)) if samp else None, "render_oom_kills": int(oom),
           "render_cpu_s": round((int(cpu1) - int(cpu0)) / 1e6, 1), "feed_to_done_s": round(float(t1) - float(t0), 1),
           "scratch_peak_mib_sampled": mib(max(r[2] for r in samp)) if samp else None, "samples": len(samp), **metrics}
# measurement.json: numbers, strings and booleans only
metrics = {k: v for k, v in metrics.items() if v is not None}
print(json.dumps(metrics))
if out:
    json.dump({"schema_version": 1, "tool": "other", "role": "infra", "test_name": f"preview-media-render-{label}",
               "started_at": ts(t0), "ended_at": ts(t1), "result": "pass" if ok else "fail",
               "device": {"platform": "server", "model": os.environ.get("MEASURE_HOST", "local docker compose")}, "upload_path": "n/a",
               "metrics": metrics,
               "notes": ("infra/preview/smoke-preview.sh (smoke-renders.sh, addendum to ADR 0092): media-render as the preview runs it "
                         "(the render target of workers/media, 4096 MiB with no swap, 2 CPU, cpu_shares 128, read-only, Remotion "
                         "concurrency 1, internal network only), restarted for a fresh cgroup, then given vertical circulated-template "
                         "renders of a synthetic clip by the feeder, one at a time. memory.peak is the cgroup high-water mark with page "
                         "cache; anon and scratch sampled every 0.5 s; idle is memory.current 5 s after the restart. render_s is "
                         "started_at to completed_at in the API's record; feed_to_done_s adds the feeder's 3 s cycles. Synthetic "
                         "content; not the shared server itself.")},
              open(out, "w"), indent=2)
sys.exit(0 if ok else 1)
PY
}

# 1. The material of the first upload (verified, with its proxy): refused in the inbox, then accepted, then two renders.
out="$(EMAIL="$SUP_EMAIL" PASSWORD="$SUP_PASSWORD" DOMAIN="$DOMAIN" probe_rw <<<"$JS_RENDER
$(cat <<'JS'
const mid = process.env.MATERIAL;
const early = await pub("POST", `/materials/${mid}/renders`, { ...bearer, "idempotency-key": randomUUID() }, renderBody(TITLE));
const e = early.status === 409 ? JSON.parse(early.body) : {};
if ((e.details?.failed ?? []).includes("source")) die(BLOCKED);
if (e.code !== "render_not_allowed" || !(e.details?.failed ?? []).includes("editorial_state")) die(`a render of a material in the inbox: ${early.status} ${early.body.slice(0, 160)}`);
say("a render of a material still in the inbox is refused (409 render_not_allowed, editorial_state): ok");
await accept(mid);
say(`RENDER_OK=${await requestRender(mid, TITLE)}`);
say(`RENDER_OVERFLOW=${await requestRender(mid, OVERFLOW)}`);
say("the supervisor accepted the material and asked for a vertical render and a title_overflow one (202, requested, no location): ok");
JS
)")" || { echo "$out"; fail "render requests"; }
echo "$out"
RENDER_OK="$(sed -n 's/^RENDER_OK=//p' <<<"$out")" RENDER_OVERFLOW="$(sed -n 's/^RENDER_OVERFLOW=//p' <<<"$out")"
[ -n "$RENDER_OK" ] && [ -n "$RENDER_OVERFLOW" ] || fail "the render requests printed no ids"
export RENDER_OK RENDER_OVERFLOW

# 2. The disk guard per render: under the floor, and above the floor but under the render's budget (its source + 1 GiB on top),
# nothing reaches media:renders and both renders stay requested.
xr0="$(rx XLEN media:renders)"
g1="$(feed -e MEDIA_MIN_FREE_GIB=1048576)" || fail "the feeder failed with the disk guard on"
[ "$(rfield "$g1" state)" = paused_low_disk ] && [ "$(rfield "$g1" enqueued)" = 0 ] && [ "$(rfield "$g1" eligible)" = 2 ] \
  || fail "render disk guard under the floor: $g1"
free_mb="$(field "$g1" free_mb)"
floor="$(python3 -c 'import sys; print(round((int(sys.argv[1]) - 512) / 1024, 3))' "$free_mb")"
g2="$(feed -e MEDIA_MIN_FREE_GIB="$floor")" || fail "the feeder failed with the disk guard at $floor GiB"
[ "$(field "$g2" state)" != paused_low_disk ] && [ "$(rfield "$g2" state)" = paused_low_disk ] && [ "$(rfield "$g2" enqueued)" = 0 ] \
  && [ "$(rfield "$g2" need_mb)" -gt "$(field "$g2" free_mb)" ] || fail "render disk guard above the floor, under the render's budget: $g2"
grep -qF "no new render" <<<"$g2" || fail "the render disk guard does not say why it holds the render"
[ "$(rx XLEN media:renders)" = "$xr0" ] || fail "a render reached media:renders under the disk guard"
[ "$(sql "SELECT count(*) FROM material_renders WHERE id IN ('$RENDER_OK', '$RENDER_OVERFLOW') AND state = 'requested'")" = 2 ] \
  || fail "a render left requested under the disk guard"
echo "render disk guard: under the floor, and above it but under the render's budget (source + 1 GiB), no render is given, it is logged, and both stay requested: ok"

# 3. The feeder gives them one at a time: one ready, one title_overflow.
render_run 6s-720p "synthetic 6 s 1280x720 H.264 30 fps with AAC, planted location and device tags" \
  "$RENDER_OK:ready" "$RENDER_OVERFLOW:title_overflow"

# 4. Read as the newsroom reads it: the list, then a signed link from public /v1 through the edge; the reporter gets neither.
out="$(EMAIL="$SUP_EMAIL" PASSWORD="$SUP_PASSWORD" DOMAIN="$DOMAIN" probe_rw <<<"$JS_RENDER
$(cat <<'JS'
const mid = process.env.MATERIAL;
const list = await pub("GET", `/materials/${mid}/renders`, bearer);
if (list.status !== 200) die(`render list: ${list.status}`);
const items = JSON.parse(list.body).items;
const a = items.find((x) => x.id === process.env.RENDER_OK), b = items.find((x) => x.id === process.env.RENDER_OVERFLOW);
if (!a || a.state !== "ready" || !a.file_id || a.failure_reason !== null || a.aspect !== "vertical" || a.location_text !== null) {
  die(`the render: ${JSON.stringify(a && { state: a.state, failure_reason: a.failure_reason, file: Boolean(a.file_id) })}`);
}
if (!b || b.state !== "failed" || b.failure_reason !== "title_overflow" || b.file_id !== null) {
  die(`the overflow render: ${JSON.stringify(b && { state: b.state, failure_reason: b.failure_reason })}`);
}
say("render list: the vertical render ready with its file, the overflowing title failed with title_overflow and no file: ok");
const m = JSON.parse((await pub("GET", `/materials/${mid}`, bearer)).body);
if (m.files.some((f) => f.id === a.file_id || f.kind === "circulated_render")) die("the render is listed in Material.files");
const r = await pub("GET", `/materials/${mid}/files/${a.file_id}/download-url`, bearer);
if (r.status !== 200 || !/no-store/.test(r.headers["cache-control"] ?? "")) die(`render download-url: ${r.status}`);
const { url, expires_at } = JSON.parse(r.body), u = new URL(url), left = Date.parse(expires_at) - Date.now();
if (u.origin !== origin) die("the render link is not signed for the preview's own origin");
if (!(left > 0 && left <= 600000)) die(`the render link lives ${left} ms`);
if (!/\/derived\/[0-9a-f-]{36}\/[0-9a-f-]{36}\/renders\/[0-9a-f-]{36}\/circulated-vertical\.mp4$/.test(u.pathname)) die("the render link is not the render's own key");
const got = await req("GET", u.pathname + u.search);
if (got.status !== 200 || !/^video\/mp4/.test(got.headers["content-type"] ?? "")) die(`the render through the edge: ${got.status} ${got.headers["content-type"]}`);
if (got.buf.subarray(4, 8).toString() !== "ftyp") die("the render read through the edge is not an MP4 file");
for (const planted of [process.env.MARK, process.env.GPS, process.env.GPS.slice(1, 8), ...TITLE]) {
  if (got.buf.includes(planted)) die("a planted tag or the title text reached the render's bytes");
}
if (!/no-store/.test(got.headers["cache-control"] ?? "") || !/noindex/.test(got.headers["x-robots-tag"] ?? "")) die("the render answer is cacheable or indexable");
const ranged = await req("GET", u.pathname + u.search, { range: "bytes=0-99" });
if (ranged.status !== 206 || ranged.buf.length !== 100) die(`a ranged GET of the render: ${ranged.status}`);
(await import("node:fs")).writeFileSync("/rendered/render.mp4", got.buf);
say(`the render through the edge on a signed link: 200 video/mp4 (${got.buf.length} bytes, ranges too), no-store, no planted tag or title text: ok`);
const rl = await pub("POST", "/auth/login", {}, { email: process.env.REPORTER_EMAIL, password: process.env.REPORTER_PASSWORD });
if (rl.status !== 200) die(`reporter login: ${rl.status}`);
const rb = { authorization: `Bearer ${JSON.parse(rl.body).access_token}` };
const rlist = await pub("GET", `/materials/${mid}/renders`, rb), rlink = await pub("GET", `/materials/${mid}/files/${a.file_id}/download-url`, rb);
if (![403, 404].includes(rlist.status) || rlink.status !== 404) die(`the reporter's render list ${rlist.status} and link ${rlink.status} (want no list and 404)`);
say(`the reporter (not a render role) gets no render list (${rlist.status}) and no render link (404): ok`);
JS
)")" || { echo "$out"; fail "the render through the edge"; }
echo "$out"
[ -s "$work/rendered/render.mp4" ] || fail "the render read through the edge was not kept"
rinfo="$(ff ffprobe -v error -show_entries stream=codec_type,codec_name,profile,width,height,pix_fmt,color_range,color_space,color_primaries,color_transfer,sample_rate:format=duration:format_tags \
  -of json /out/rendered/render.mp4)" || fail "ffprobe could not read the render"
python3 - "$rinfo" <<'PY' || fail "the render is not the vertical H.264 BT.709 file ADR 0091 §4 describes"
import json, os, sys
d = json.loads(sys.argv[1])
v = [x for x in d["streams"] if x["codec_type"] == "video"]
a = [x for x in d["streams"] if x["codec_type"] == "audio"]
dur = float(d["format"]["duration"])
got = {"video": (v[0]["codec_name"], v[0]["width"], v[0]["height"], v[0]["pix_fmt"], v[0].get("color_range"), v[0].get("color_space"),
                 v[0].get("color_primaries"), v[0].get("color_transfer")) if len(v) == 1 else None,
       "audio": (a[0]["codec_name"], a[0]["sample_rate"]) if len(a) == 1 else None,
       "duration": 5.8 <= dur <= 6.2, "tags": sorted(d["format"].get("tags", {}))}
want = {"video": ("h264", 1080, 1920, "yuv420p", "tv", "bt709", "bt709", "bt709"), "audio": ("aac", "48000"), "duration": True}
bad = {k: got[k] for k in want if got[k] != want[k]}
mark = os.environ["MARK"]
if any(mark in str(t) for t in d["format"].get("tags", {}).values()):
    bad["tags"] = "a planted tag"
print(f"render: {got['video']}, {got['audio']}, {dur:.2f} s" if not bad else f"wrong: {bad}")
sys.exit(1 if bad else 0)
PY
echo "the render is 1080x1920 H.264 yuv420p, tv range, BT.709, AAC 48 kHz, the source's 6 s: ok"

# 5. Measurement (--media-json): a vertical render of each 60 s clip measured above, with media-render's limits as deployed.
if [ -n "$MEDIA_OUT" ]; then
  for pm in "${MEASURED[@]}"; do
    prof="${pm%%:*}" mat="${pm#*:}"
    out="$(EMAIL="$SUP_EMAIL" PASSWORD="$SUP_PASSWORD" DOMAIN="$DOMAIN" MATERIAL="$mat" probe_rw <<<"$JS_RENDER
$(cat <<'JS'
await accept(process.env.MATERIAL);
say(`RENDER=${await requestRender(process.env.MATERIAL, TITLE)}`);
JS
)")" || { echo "$out"; fail "the $prof render request"; }
    rid="$(sed -n 's/^RENDER=//p' <<<"$out")"
    case "$prof" in 1080p) size=1920x1080 ;; *) size=3840x2160 ;; esac
    render_run "60s-$prof" "synthetic 60 s $size H.264 30 fps with AAC (the media worker's measurement clip)" "$rid:ready"
    echo "measured media-render on the 60 s $prof clip: see $MEDIA_OUT/preview-media-render-60s-$prof.json"
  done
fi

# 6. No title, location, file name or device in what media-render and the feeder log (CLAUDE.md §5).
render_logs="$("${C[@]}" logs --no-color media-render media-feeder 2>&1)"
for planted in "$MARK" "$GPS" "${GPS:1:7}" "عنوان تجريبي" "للمادة المتداولة" "ЖЖЖЖ" "مادة" "Test city"; do
  if grep -qF -- "$planted" <<<"$render_logs"; then fail "the media-render or feeder log carries a title, location, file name or device"; fi
done
grep -q 'event done' <<<"$("${C[@]}" logs --no-color media-render 2>&1)" || fail "nothing in the media-render log (cannot check it)"
[ "$(rx XLEN media:dead)" = 0 ] || fail "a render was dead-lettered"
echo "media-render and feeder logs: no title, location, file name or device tag, nothing dead-lettered: ok"

started="$("${C[@]}" up -d --no-deps media-feeder 2>&1)" || { echo "$started" | tail -5; fail "media-feeder does not start again after the renders"; }
echo "circulated-template renders on the preview: ok"
