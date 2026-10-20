#!/usr/bin/env bash
# يبني عميل القياس Swift (apps/ios UploadCore) داخل حاوية swift ويشغّله عبر netlab.py --client-cmd.
# البناء والتشغيل داخل الحاوية نفسها (--network host) كي لا نحتاج Swift على المشغّل ولا ربطًا ساكنًا لـ FoundationNetworking.
set -euo pipefail
# swift:6.1-noble مثبّتة بالبصمة (قائمة البيان amd64+arm64) كي لا يتغيّر ما يُقاس به بين تشغيل وآخر.
IMAGE="swift@sha256:04b28d4aff67fa4ff4029d6e27dd40f9737cc69cc558a37b06f18b3dceb8942f"
PKG="$PWD/apps/ios/Packages/PostHistoryKit"
BIN="/src/.build/release/upload-netlab"
case "${1:-}" in
  build)
    docker run --rm -v "$PKG:/src" -w /src -e HTTPS_PROXY -e HTTP_PROXY -e NO_PROXY "$IMAGE" \
      swift build -c release --product upload-netlab
    ;;
  measure)
    scenario="$2"; size_mb="$3"; max_seconds="$4"; out="$5"
    # netlab.py يستبدل {endpoint} {file} {chunk} {timeout} {max_seconds}؛ الملف في RUNNER_TEMP يُركَّب بالمسار نفسه داخل الحاوية.
    client="docker run --rm --network host -v $PKG:/src -v $RUNNER_TEMP:$RUNNER_TEMP $IMAGE $BIN \
      --file {file} --endpoint {endpoint} --chunk-bytes {chunk} --timeout-s {timeout} --max-seconds {max_seconds}"
    python3 tools/netlab/netlab.py run --scenario "$scenario" --size-mb "$size_mb" --max-seconds "$max_seconds" \
      --workdir "$RUNNER_TEMP" --out "$out" --role ios \
      --client-cmd "$client" \
      --client-label "apps/ios UploadCore (PostHistoryKit upload-netlab, Swift 6.1 on Linux)"
    ;;
  *) echo "usage: $0 build | measure <scenario> <size_mb> <max_seconds> <out.json>" >&2; exit 2 ;;
esac
