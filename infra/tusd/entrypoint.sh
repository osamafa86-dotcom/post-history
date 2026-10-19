#!/bin/sh
# يشغّل tusd ويحقن رمز الخطّاف في مسار العنوان (SEC-06)، ويحجبه من السجل:
# tusd يطبع عنوان الخطّاف كاملًا عند البدء وفي رسائل فشل الاستدعاء.
set -eu

: "${TUSD_HOOK_URL:?TUSD_HOOK_URL is required}"
: "${TUSD_HOOK_SECRET:?TUSD_HOOK_SECRET is required (openssl rand -hex 32)}"
case "$TUSD_HOOK_SECRET" in
  *[!A-Za-z0-9_-]*) echo "TUSD_HOOK_SECRET: only [A-Za-z0-9_-] allowed" >&2; exit 2 ;;
esac
if [ "${#TUSD_HOOK_SECRET}" -lt 32 ] || [ "${#TUSD_HOOK_SECRET}" -gt 128 ]; then
  echo "TUSD_HOOK_SECRET: length must be 32-128" >&2
  exit 2
fi

fifo="$(mktemp -u)"
mkfifo "$fifo"
# awk with fflush: busybox sed buffers when stdout is not a tty, delaying log lines.
awk '{ gsub(/\/internal\/tusd-hooks\/[A-Za-z0-9_-]+/, "/internal/tusd-hooks/[REDACTED]"); print; fflush() }' <"$fifo" &
tusd "$@" -hooks-http="${TUSD_HOOK_URL%/}/${TUSD_HOOK_SECRET}" >"$fifo" 2>&1 &
pid=$!
trap 'kill -TERM "$pid" 2>/dev/null' TERM INT

status=0
wait "$pid" || status=$?
if kill -0 "$pid" 2>/dev/null; then
  wait "$pid" || status=$?
fi
exit "$status"
