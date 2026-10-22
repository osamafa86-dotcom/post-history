#!/usr/bin/env bash
# صورة الخادم للتجربة (ADR 0050): post-history-api:<commit>، بلا npm ci ولا بناء عند كل بدء، فيعود الخادم بعد انهيار بلا شبكة.
#   infra/deploy/api-image.sh <commit> --tag TAG    # أصول الإصدار TAG (api-image.yml في CI): بصمة sha256 والالتزام في المانيفست قبل docker load
#   infra/deploy/api-image.sh <commit> --build      # البناء على المضيف من الشجرة الحالية (--main، أو التزام بلا إصدار)
# الصورة الموجودة محليًا بالوسم نفسه لا تُعاد (التراجع إلى التزام سابق يجد صورته). RELEASE_DOWNLOAD للاختبار فقط.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP="$(cd "$HERE/../.." && pwd)"
commit="${1:-}"; shift || true
[[ "$commit" =~ ^[0-9a-f]{40}$ ]] || { echo "usage: $0 <commit sha> --tag TAG | --build" >&2; exit 2; }
mode="" tag=""
case "${1:-}" in
  --tag) mode=tag; tag="${2:?--tag TAG}" ;;
  --build) mode=build ;;
  *) echo "usage: $0 <commit sha> --tag TAG | --build" >&2; exit 2 ;;
esac
img="post-history-api:$commit"
if docker image inspect "$img" >/dev/null 2>&1; then echo "api image: $img present"; exit 0; fi

if [ "$mode" = build ]; then
  [ "$(git -C "$APP" rev-parse HEAD)" = "$commit" ] || { echo "!! the tree is not at $commit: not building" >&2; exit 1; }
  docker build -q -f "$APP/infra/preview/api.Dockerfile" -t "$img" "$APP" >/dev/null
  echo "api image: $img built here"
  exit 0
fi

base="${RELEASE_DOWNLOAD:-https://github.com/${RELEASE_REPO:-osamafa86-dotcom/post-history}/releases/download}/$tag"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
for f in post-history-api.tar.gz api-manifest.txt SHA256SUMS; do
  curl -fsSL --max-time 600 -o "$work/$f" "$base/$f" || { echo "!! release $tag has no $f" >&2; exit 1; }
done
(cd "$work" && sha256sum -c --quiet SHA256SUMS) || { echo "!! release $tag: checksum mismatch" >&2; exit 1; }
grep -qx "commit $commit" "$work/api-manifest.txt" || { echo "!! release $tag image is not built from $commit" >&2; exit 1; }
gunzip -c "$work/post-history-api.tar.gz" | docker load -q >/dev/null
docker image inspect "$img" >/dev/null 2>&1 || { echo "!! the loaded image is not $img" >&2; exit 1; }
echo "api image: $img from release $tag (sha256 and commit verified)"
