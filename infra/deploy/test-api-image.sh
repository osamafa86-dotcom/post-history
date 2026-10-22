#!/usr/bin/env bash
# فحص api-image.sh (ADR 0050) على صورة صغيرة بوسم post-history-api:<commit> ونقطة إصدارات محلية، بلا شبكة خارجية:
#   infra/deploy/test-api-image.sh
# يثبت: تحميل صورة الإصدار بعد البصمة والالتزام، وعدم إعادتها إن وُجدت، ورفض التزام آخر وبصمة معدّلة وإصدار ناقص،
# ورفض البناء والشجرة على التزام آخر.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
A="$HERE/api-image.sh"
fail() { echo "!! $*" >&2; exit 1; }
W="$(mktemp -d)" port=18099
sha="$(printf 'a%.0s' {1..40})" other="$(printf 'b%.0s' {1..40})"
cleanup() { [ -n "${srv:-}" ] && kill "$srv" 2>/dev/null; docker rmi -f "post-history-api:$sha" >/dev/null 2>&1 || true; rm -rf "$W"; }
trap cleanup EXIT
base="$(docker image ls --format '{{.Repository}}:{{.Tag}}' | grep -v '<none>' | head -1)"
[ -n "$base" ] || { docker pull -q alpine:3.20 >/dev/null; base=alpine:3.20; }
docker tag "$base" "post-history-api:$sha"
mkdir -p "$W/rel/v9.9.9"
docker save "post-history-api:$sha" | gzip -1 > "$W/rel/v9.9.9/post-history-api.tar.gz"
printf 'commit %s\n' "$sha" > "$W/rel/v9.9.9/api-manifest.txt"
(cd "$W/rel/v9.9.9" && sha256sum post-history-api.tar.gz api-manifest.txt > SHA256SUMS)
docker rmi -f "post-history-api:$sha" >/dev/null
(cd "$W/rel" && exec python3 -m http.server "$port" --bind 127.0.0.1 >/dev/null 2>&1) & srv=$!
for _ in $(seq 50); do curl -fsS -o /dev/null "http://127.0.0.1:$port/v9.9.9/SHA256SUMS" 2>/dev/null && break; sleep 0.2; done
export RELEASE_DOWNLOAD="http://127.0.0.1:$port" NO_PROXY="127.0.0.1,${NO_PROXY:-}"

"$A" "$sha" --tag v9.9.9 | grep -q "sha256 and commit verified" || fail "the release image was not loaded"
docker image inspect "post-history-api:$sha" >/dev/null || fail "no post-history-api:$sha after loading"
"$A" "$sha" --tag v9.9.9 | grep -q present || fail "a present image is fetched again"
docker rmi -f "post-history-api:$sha" >/dev/null
"$A" "$other" --tag v9.9.9 >"$W/o" 2>&1 && fail "accepted an image built from another commit"
grep -q "not built from $other" "$W/o" || fail "no reason for the other commit"
"$A" "$sha" --tag v0.0.0 >"$W/o" 2>&1 && fail "accepted a release without the image"
echo tampered >> "$W/rel/v9.9.9/api-manifest.txt"
"$A" "$sha" --tag v9.9.9 >"$W/o" 2>&1 && fail "accepted a tampered release"
grep -q "checksum mismatch" "$W/o" || fail "no reason for the tampered release"
docker image inspect "post-history-api:$sha" >/dev/null 2>&1 && fail "a refused release left an image behind"
"$A" "$sha" --build >"$W/o" 2>&1 && fail "built while the tree is at another commit"
"$A" "$sha" >"$W/o" 2>&1 && fail "ran with neither --tag nor --build"
echo "api image fetch: verified load, no refetch, other commit / tampered / missing / wrong tree refused: ok"
