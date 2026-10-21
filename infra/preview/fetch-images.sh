#!/usr/bin/env bash
# على الخادم المشترك (ADR 0023): ينزّل صورتي المعاينة من الإصدار التمهيدي preview-latest (المستودع عام، بلا رمز)، ويتحقق
# من بصماتها في SHA256SUMS قبل docker load. لا يبني شيئًا. يطبع الإيداع الذي بُنيت منه الصورتان.
#   ./fetch-images.sh            (PREVIEW_REPO=<owner/repo> لغير المستودع الافتراضي)
set -euo pipefail
REPO="${PREVIEW_REPO:-osamafa86-dotcom/post-history}"
BASE="https://github.com/$REPO/releases/download/preview-latest"
dir="$(mktemp -d)"
trap 'rm -rf "$dir"' EXIT
for f in SHA256SUMS preview-manifest.txt post-history-preview-api.tar.gz post-history-preview-web.tar.gz; do
  curl -fsSL --retry 3 -o "$dir/$f" "$BASE/$f"
done
(cd "$dir" && sha256sum -c --quiet SHA256SUMS) || { echo "checksum mismatch: nothing loaded" >&2; exit 1; }
for i in api web; do gunzip -c "$dir/post-history-preview-$i.tar.gz" | docker load -q; done
cat "$dir/preview-manifest.txt"
