#!/usr/bin/env bash
# تمرين الاستعادة لأي لحظة (ADR 0051): من نسخ WAL-G لدى المزوّد الثاني إلى Postgres مؤقت، حتى لحظة محددة.
#   infra/backup/pitr-drill.sh --key private.asc --target '2026-10-26 05:14:45+00' --out result.json \
#     [--check "SQL" --expect VALUE]
# المفتاح الخاص يحضره المالك للتمرين ثم يُزال، ولا يكون على مضيف التجربة (شرط ADR 0051). يقيس: زمن جلب النسخة الأساسية،
# وزمن تطبيق WAL حتى اللحظة، والمجموع؛ ويتحقق بالاستعلام أن الحالة المستعادة هي حالة تلك اللحظة.
# البيئة: PITR_IMAGE (صورة infra/postgres)، PITR_NETWORK (شبكة Docker للمزوّد في التمرين المحلي، فارغة على مضيف منفصل)،
# WALG_S3_PREFIX وAWS_ENDPOINT وAWS_ACCESS_KEY_ID وAWS_SECRET_ACCESS_KEY (مفتاح يقرأ؛ ليس مفتاح الكتابة على المضيف)،
# AWS_REGION (us-east-1)، PITR_DB_USER (المستخدم الأعلى في القاعدة المستعادة، الافتراضي postgres)، PITR_ENV (يدخل في النتيجة)، PITR_TMP (مجلد العمل، الافتراضي /dev/shm).
set -euo pipefail
KEY="" TARGET="" OUT="" CHECK="" EXPECT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --key) KEY="$2"; shift 2 ;; --target) TARGET="$2"; shift 2 ;; --out) OUT="$2"; shift 2 ;;
    --check) CHECK="$2"; shift 2 ;; --expect) EXPECT="$2"; shift 2 ;;
    *) echo "usage: $0 --key FILE --target TIMESTAMP --out FILE [--check SQL --expect VALUE]" >&2; exit 2 ;;
  esac
done
[ -r "$KEY" ] && [ -n "$TARGET" ] && [ -n "$OUT" ] || { echo "usage: $0 --key FILE --target TIMESTAMP --out FILE" >&2; exit 2; }
: "${PITR_IMAGE:?image built from infra/postgres}" "${WALG_S3_PREFIX:?}" "${AWS_ACCESS_KEY_ID:?}" "${AWS_SECRET_ACCESS_KEY:?}"
WORK="$(mktemp -d -p "${PITR_TMP:-/dev/shm}")"
VOL="pitr-drill-$$"
cleanup() { docker volume rm -f "$VOL" >/dev/null 2>&1 || true; rm -rf "$WORK"; }
trap cleanup EXIT
install -m 644 "$KEY" "$WORK/private.asc"   # read by uid 70 in the container; the directory is the caller's, 0700
chmod 711 "$WORK"
cat > "$WORK/run.sh" <<'SH'
#!/bin/sh
set -eu
D=/var/lib/postgresql/data
t() { date +%s.%N; }
t0=$(t)
wal-g backup-fetch "$D" LATEST >/tmp/fetch.log 2>&1 || { tail -5 /tmp/fetch.log >&2; exit 9; }
t1=$(t)
touch "$D/recovery.signal"
{
  echo "restore_command = 'wal-g wal-fetch %f %p'"
  echo "recovery_target_time = '$TARGET'"
  echo "recovery_target_action = 'promote'"
  echo "archive_mode = off"
} >> "$D/postgresql.auto.conf"
pg_ctl -D "$D" -l /tmp/pg.log -w -t 600 start -o "-c listen_addresses=" >/dev/null 2>&1 || { tail -20 /tmp/pg.log >&2; exit 8; }
# Promotion ends recovery; a server that stopped instead (target not reached, missing WAL) fails the drill with its log.
for _ in $(seq 1 600); do
  pg_ctl -D "$D" status >/dev/null 2>&1 || { tail -20 /tmp/pg.log >&2; exit 7; }
  [ "$(psql -U "$DB_USER" -d postgres -XAtq -c 'select pg_is_in_recovery()' 2>/dev/null)" = f ] && break; sleep 0.5
done
t2=$(t)
got=""
[ -z "$CHECK" ] || got="$(psql -U "$DB_USER" -d "${CHECK_DB:-postgres}" -XAtq -f /work/check.sql 2>&1 || true)"
reached=$(grep -c 'recovery stopping before\|recovery stopping after' /tmp/pg.log || true)
pg_ctl -D "$D" -m fast stop >/dev/null 2>&1 || true
printf '%s %s %s %s\n' "$t0" "$t1" "$t2" "$reached"
printf '%s\n' "$got"
SH
printf '%s\n' "$CHECK" > "$WORK/check.sql"
started_at="$(date -u +%FT%TZ)"
net=(); [ -z "${PITR_NETWORK:-}" ] || net=(--network "$PITR_NETWORK")
rc=0
res="$(docker run --rm "${net[@]}" -u 70:70 -v "$VOL:/var/lib/postgresql/data" -v "$WORK:/work:ro" \
  -e WALG_S3_PREFIX -e AWS_ENDPOINT -e AWS_ACCESS_KEY_ID -e AWS_SECRET_ACCESS_KEY -e AWS_REGION="${AWS_REGION:-us-east-1}" \
  -e AWS_S3_FORCE_PATH_STYLE=true -e WALG_PGP_KEY_PATH=/work/private.asc -e TARGET="$TARGET" -e CHECK="$CHECK" \
  -e CHECK_DB="${CHECK_DB:-postgres}" -e DB_USER="${PITR_DB_USER:-postgres}" --entrypoint sh "$PITR_IMAGE" /work/run.sh)" || rc=$?
read -r t0 t1 t2 reached <<<"$(sed -n 1p <<<"$res")"
got="$(sed -n '2,$p' <<<"$res")"
python3 - "$OUT" "$started_at" "$rc" "${t0:-0}" "${t1:-0}" "${t2:-0}" "${reached:-0}" "$got" "$EXPECT" "$CHECK" "${PITR_ENV:-local}" <<'PY'
import json, sys, datetime
out, started, rc, t0, t1, t2, reached, got, expect, check, env = sys.argv[1:]
ok = rc == "0" and (not check or got == expect) and int(reached or 0) > 0
m = {
  "exit_code": int(rc), "base_fetch_s": round(float(t1) - float(t0), 2), "wal_replay_s": round(float(t2) - float(t1), 2),
  "restore_total_s": round(float(t2) - float(t0), 2), "target_reached": int(reached or 0) > 0,
  "state_matches_target": (got == expect) if check else None, "drill_passed": ok,
}
json.dump({
  "schema_version": 1, "tool": "other", "role": "infra", "test_name": "recovery",
  "started_at": started, "ended_at": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
  "result": "partial" if ok else "fail",
  "device": {"platform": "server", "model": env},
  "metrics": {k: v for k, v in m.items() if v is not None},
  "notes": ("ADR 0051 point-in-time restore: the latest WAL-G base backup fetched from the second provider and decrypted "
            "with the offline private key, WAL replayed up to the target time, then the restored state checked by a query. "
            "Partial unless run on a separate host against the real second provider (the monthly drill)."),
}, open(out, "w"), indent=2)
open(out, "a").write("\n")
print(("pitr drill passed" if ok else "pitr drill FAILED") + f": fetch {m['base_fetch_s']} s, replay {m['wal_replay_s']} s, target reached {m['target_reached']}")
sys.exit(0 if ok else 1)
PY
