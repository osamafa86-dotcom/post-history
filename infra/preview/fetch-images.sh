#!/usr/bin/env bash
# على الخادم المشترك (ADR 0023، 0092): ينزّل صور المعاينة الأربع (الخادم والويب وعامل الوسائط وmedia-render) من الإصدار التمهيدي
# preview-latest (المستودع عام، بلا رمز)، ويتحقق من بصماتها كلها في SHA256SUMS قبل أي docker load: بصمة واحدة لا تطابق
# أو أصل ناقص = لا تُحمَّل صورة. لا يبني شيئًا. يطبع الإيداع الذي بُنيت منه الصور.
#   ./fetch-images.sh            (PREVIEW_REPO=<owner/repo> لغير المستودع الافتراضي)
set -euo pipefail
REPO="${PREVIEW_REPO:-osamafa86-dotcom/post-history}"
BASE="https://github.com/$REPO/releases/download/preview-latest"
dir="$(mktemp -d)"
trap 'rm -rf "$dir"' EXIT
IMAGES=(api web media render)
for f in SHA256SUMS preview-manifest.txt "${IMAGES[@]/#/post-history-preview-}"; do
  case "$f" in *-api|*-web|*-media|*-render) f="$f.tar.gz" ;; esac
  curl -fsSL --retry 3 -o "$dir/$f" "$BASE/$f"
done
# Every image must be listed in SHA256SUMS (sha256sum -c alone skips a file the list does not name).
for i in "${IMAGES[@]}"; do
  grep -qE "^[0-9a-f]{64}  post-history-preview-$i\.tar\.gz$" "$dir/SHA256SUMS" || { echo "post-history-preview-$i.tar.gz is not in SHA256SUMS: nothing loaded" >&2; exit 1; }
done
(cd "$dir" && sha256sum -c --quiet SHA256SUMS) || { echo "checksum mismatch: nothing loaded" >&2; exit 1; }
for i in "${IMAGES[@]}"; do gunzip -c "$dir/post-history-preview-$i.tar.gz" | docker load -q; done
cat "$dir/preview-manifest.txt"
