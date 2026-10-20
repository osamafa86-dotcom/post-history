#!/usr/bin/env bash
# يقيس نواة الرفع في أندرويد (UploadEngine من apps/android/core على JVM، وحدة netlab-runner) بأداة tools/netlab/netlab.py
# عبر عقد العميل الخارجي --client-cmd: المقاييس والمرجع (عميل بايثون بالشروط نفسها) وبصمة MinIO والحكم على المرحلة (أ)
# كلها من netlab (ADR 0007)؛ الـ runner يطبع ملخص الجلسة فقط. لا شيء كاشفًا: ملف اصطناعي وعناوين محلية.
#   measure.sh build
#   measure.sh measure <scenario> <size_mb> <max_seconds> <reference_seconds> <out.json>
# reference_seconds = 0 يقيس بلا مرجع (لا حكم على المرحلة (أ)؛ للتحقق السريع على الطلبات).
set -euo pipefail
RUNNER="$PWD/apps/android/netlab-runner/build/install/netlab-runner/bin/netlab-runner"
case "${1:-}" in
  build)
    (cd apps/android && ./gradlew --no-daemon -q :netlab-runner:installDist)
    ;;
  measure)
    scenario="$2"; size_mb="$3"; max_seconds="$4"; reference_seconds="$5"; out="$6"
    workdir="${RUNNER_TEMP:-${TMPDIR:-/tmp}}"
    # netlab.py يستبدل {endpoint} {file} {chunk} {timeout} {max_seconds}. مهلة القراءة كما في التطبيق (90 ث).
    client="$RUNNER --file {file} --tus {endpoint} --part-bytes {chunk} --max-seconds {max_seconds} --timeout {timeout}"
    ref=()
    if [ "$reference_seconds" -gt 0 ]; then ref=(--reference-seconds "$reference_seconds"); fi
    python3 tools/netlab/netlab.py run --scenario "$scenario" --size-mb "$size_mb" --max-seconds "$max_seconds" \
      --timeout-s 90 --workdir "$workdir" --out "$out" --role android \
      --client-cmd "$client" \
      --client-label "apps/android UploadEngine + TusTransport (core on the JVM via netlab-runner, tus-java-client 0.5.1)" \
      "${ref[@]}"
    ;;
  *) echo "usage: $0 build | measure <scenario> <size_mb> <max_seconds> <reference_seconds> <out.json>" >&2; exit 2 ;;
esac
