#!/usr/bin/env bash
# دخان المعاينة الخفيفة (ADR 0023) على صورتي CI المحمّلتين (post-history-preview-{api,web}:latest)، بلا بناء:
#   infra/preview/smoke-preview.sh [--json FILE]
# يثبت: compose يقوم بالصورتين وحدهما وبلا منفذ على المضيف، و"web" وحده على deploy_default (باسم lib-web) والخادم لا يُصل
# منها، و/health 200، والدخول عبر الويب بحساب تجريبي يرى مواده الاصطناعية، وX-Robots-Tag وشريط «معاينة»، والرفع من
# الحاسوب كما يفعله المتصفح (جلسة رفع ورمز ingest عبر الـBFF، ثم tus عبر الحافة والبوابة، وقطع واستئناف من إزاحة tusd،
# والجلسة completed)، ومجموع حدود الذاكرة ≤ 960 MB بلا swap واستهلاكها الفعلي (docker stats) تحته، ولا سر في السجلات.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
JSON=""
[ "${1:-}" = --json ] && JSON="$2"
LIMIT_MB=960
C=(docker compose -f "$HERE/docker-compose.preview.yml")
created_env=0 created_net=0
cleanup() {
  [ "${KEEP:-0}" = 1 ] && return
  "${C[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
  [ "$created_env" = 1 ] && rm -rf "$HERE/.env" "$HERE/tls"
  docker rm -f ph-preview-decoy >/dev/null 2>&1 || true
  [ "$created_net" = 1 ] && docker network rm deploy_default >/dev/null 2>&1 || true
}
trap cleanup EXIT
fail() { echo "!! $*" >&2; "${C[@]}" logs --tail 40 >&2 || true; exit 1; }

docker image inspect post-history-preview-api:latest post-history-preview-web:latest >/dev/null || fail "load the CI images first"
docker network inspect deploy_default >/dev/null 2>&1 || { docker network create deploy_default >/dev/null; created_net=1; }
if [ ! -e "$HERE/.env" ]; then PREVIEW_DOMAIN=preview.localhost "$HERE/gen-env.sh" >/dev/null; created_env=1; fi
[ "$(stat -c %a "$HERE/.env")" = 600 ] || fail ".env is not 0600"
val() { sed -n "s/^$1=//p" "$HERE/.env" | tail -1; }
DOMAIN="$(val PREVIEW_DOMAIN)"

# Memory: every service has a limit with no swap on top, and the limits add up to <= 900 MB.
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

# No host port anywhere, and only "web" on the shared server's network.
for id in $("${C[@]}" ps -aq); do
  [ "$(docker inspect -f '{{json .HostConfig.PortBindings}}' "$id")" = "{}" ] || fail "$(docker inspect -f '{{.Name}}' "$id") publishes a host port"
done
on_shared="$(docker network inspect deploy_default -f '{{range .Containers}}{{.Name}} {{end}}')"
[ "$on_shared" = "ph-preview-decoy post-history-preview-web-1 " ] || [ "$on_shared" = "post-history-preview-web-1 ph-preview-decoy " ] || fail "on deploy_default: '$on_shared' (want the web edge alone)"
echo "no host port, the web edge alone on deploy_default: ok"

# A probe on deploy_default, as the server's Caddy: the API image's node, no other image.
probe() { docker run --rm -i --network deploy_default -e DOMAIN -e EMAIL -e PASSWORD --entrypoint node post-history-preview-api:latest --input-type=module -; }
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
// from the offset tusd reports; the session ends completed (no media worker here: the material stays awaiting processing).
const { createHash, randomBytes, randomUUID } = await import("node:crypto");
const bff = (path, body) => req("POST", `/api/bff/${path}`, { ...json, cookie, "idempotency-key": randomUUID() }, JSON.stringify(body));
const bytes = randomBytes(6 * 1024 * 1024 + 4321);
const created = await bff("uploads", { material_id: items[0].id, kind: "original", size_bytes: bytes.length, filename: "preview-smoke.mp4",
  mime_type: "video/mp4", client_sha256: createHash("sha256").update(bytes).digest("hex") });
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
for (let i = 0; i < 30 && !["completed", "verified"].includes(state); i++) {
  await new Promise((r) => setTimeout(r, 1000));
  const g = await req("GET", `/api/bff/uploads/${s.id}`, { cookie });
  state = g.status === 200 ? JSON.parse(g.body).state : `http ${g.status}`;
}
if (!["completed", "verified"].includes(state)) die(`upload session after the last byte: ${state}`);
say(`upload session ${state} after tus finished (tusd post-finish hook to the API): ok`);
JS
)" || { echo "$out"; fail "through the web edge"; }
echo "$out"
[ -z "$(docker logs ph-preview-decoy 2>&1)" ] || { docker logs ph-preview-decoy 2>&1 | head -5; fail "the edge sent traffic to another container named api or web-app on deploy_default"; }
echo "the edge reaches its own upstreams, not same-named containers on deploy_default: ok"

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

logs="$("${C[@]}" logs --no-color 2>&1)"
# Upload ids are bearer capabilities (SEC-06): the edge, the gate and the proxy log /files/-, never /files/<id>.
edge_logs="$("${C[@]}" logs --no-color web ingest-gate tusd-proxy 2>&1)"
if grep -qE '/files/[A-Za-z0-9]' <<<"$edge_logs"; then grep -E '/files/[A-Za-z0-9]' <<<"$edge_logs" | head -3 | cut -c1-200 >&2; fail "an upload id in an edge log"; fi
grep -qF '/files/-' <<<"$edge_logs" || fail "no redacted upload path in the edge logs (nothing logged?)"
for k in POSTGRES_PASSWORD REDIS_PASSWORD S3_SECRET_KEY JWT_SECRET PREVIEW_REPORTER_PASSWORD TUSD_HOOK_SECRET INGEST_GATE_TOKEN; do
  if grep -qF "$(val "$k")" <<<"$logs"; then fail "$k appears in a container log"; fi
done
echo "no secret in the logs: ok"

if [ -n "$JSON" ]; then
  mkdir -p "$(dirname "$JSON")"
  python3 - "$JSON" "$total" "$used_mb" "$LIMIT_MB" <<'PY'
import json, os, sys, datetime
out, total, used, ceiling = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), int(sys.argv[4])
now = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
json.dump({"schema_version": 1, "tool": "other", "role": "infra", "started_at": now, "ended_at": now,
           "result": "pass" if used < total <= ceiling else "fail",
           "device": {"platform": "server", "model": os.environ.get("MEASURE_HOST", "local docker compose")},
           "metrics": {"memory_limits_mb": total, "memory_used_mb": used, "memory_ceiling_mb": ceiling},
           "notes": "infra/preview/smoke-preview.sh (ADR 0023): preview compose on images built from infra/preview/*.Dockerfile, idle after a demo login and a few page loads. Not the shared server itself."},
          open(out, "w"), indent=2)
PY
fi
echo "light preview smoke: ok"
