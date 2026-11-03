#!/usr/bin/env bash
# The backup fails closed (ADR 0013). On a real Postgres, a real MinIO (the read-only backup user of infra/minio/init.sh)
# and the backup image itself, hardened as in the trial:
#   1. a pg_dump cut short leaves no dump, no row counts and no success, in `once` and in `loop` (the image's default
#      command, where once used to run inside `if`, with set -e off, and a cut dump was kept and logged as a success);
#   2. an object read cut mid-stream leaves no copy and no success;
#   3. an object removed between the listing and the read (a cancelled upload) does not fail the backup;
#   4. every copy decrypts to its source, with its size recorded beside it; a second run copies nothing again;
#   5. a copy with no recorded size or a size that does not match the listing (a partial copy kept by the old script) is
#      copied again;
#   6. the restore drill passes on the good backup and records `fail`, not a crash, for a dump cut before encryption (what
#      the old script kept) and for a truncated encrypted file.
# Synthetic rows and random bytes only. Run from anywhere: infra/backup/test/test-backup.sh
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PG_IMAGE="postgres:16-alpine@sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea"
WORK="$(mktemp -d)"
chmod 755 "$WORK"
BT_WORK="$WORK" BT_PG_PASSWORD="$(openssl rand -hex 16)" BT_S3_ROOT=bt-admin BT_S3_ROOT_SECRET="$(openssl rand -hex 16)"
BT_BACKUP_SECRET="$(openssl rand -hex 16)"
BT_MC_ADMIN="http://$BT_S3_ROOT:$BT_S3_ROOT_SECRET@minio:9000"
MC_HOST_a="http://$BT_S3_ROOT:$BT_S3_ROOT_SECRET@127.0.0.1:9000"
export BT_WORK BT_PG_PASSWORD BT_S3_ROOT BT_S3_ROOT_SECRET BT_BACKUP_SECRET BT_MC_ADMIN MC_HOST_a
C=(docker compose -f "$HERE/compose.backup-test.yml")
cleanup() {
  docker rm -f ph-backup-test-loop >/dev/null 2>&1 || true
  "${C[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
  # The backup writes as uid 70: removed through a container, the caller may not own those files.
  docker run --rm -v "$WORK:/w" "$PG_IMAGE" rm -rf /w/backups >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT
fail() { echo "!! $*" >&2; "${C[@]}" logs --tail 30 >&2 || true; exit 1; }
ok() { echo "$*: ok"; }
failog() { cat "$WORK/$1.log" >&2; fail "$2"; }   # failog <step> <message>: the step's own output first

openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 2 -subj /CN=backup-test \
  -keyout "$WORK/recipient.key" -out "$WORK/recipient.crt" 2>/dev/null
chmod 600 "$WORK/recipient.key"; chmod 644 "$WORK/recipient.crt"
mkdir -p "$WORK/backups" && chmod 777 "$WORK/backups"   # uid 70 in the backup image writes here
B="$WORK/backups"

"${C[@]}" build -q backup >/dev/null
"${C[@]}" up -d --wait postgres minio >/dev/null 2>&1 || fail "postgres and minio did not come up"
"${C[@]}" run --rm -T minio-init >/dev/null || fail "minio-init"

# Synthetic rows (not very compressible, so the dump is well over the 4 KiB the cut keeps) and random objects.
"${C[@]}" exec -T postgres psql -v ON_ERROR_STOP=1 -U backuptest -d backuptest -Xq -c "
  create table materials (id int primary key, title text);
  insert into materials select g, md5(g::text) || md5((g * 7)::text) from generate_series(1, 5000) g;
  create table events (id bigserial primary key, at timestamptz default now());
  insert into events select from generate_series(1, 3000);" || fail "seeding postgres"
head -c 3000000 /dev/urandom > "$WORK/big"
head -c 4096 /dev/urandom > "$WORK/big.part"   # the same prefix as big, as tus's side files: mc stat matches both
head -c 65536 /dev/urandom > "$WORK/gone"
head -c 200000 /dev/urandom > "$WORK/proxy"
put_obj() { "${C[@]}" exec -T -e MC_HOST_a minio mc pipe --quiet "a/$1" < "$2" >/dev/null || fail "seeding $1"; }
put_obj uploads/tus/big "$WORK/big"
put_obj uploads/tus/big.part "$WORK/big.part"
put_obj uploads/tus/gone "$WORK/gone"
put_obj media/derived/m1/f1/proxy-480p.mp4 "$WORK/proxy"

bk() { "${C[@]}" run --rm --no-deps -T "$@" backup once </dev/null; }
dumps() { find "$B/pg" -name '*.dump.cms' 2>/dev/null | wc -l; }
last() { python3 -c 'import json, sys; print(json.load(open(sys.argv[1]))[sys.argv[2]])' "$B/last-success.json" "$1"; }
dec() { # path under backups/ -> its plaintext on stdout
  "${C[@]}" run --rm --no-deps -T --user "$(id -u):$(id -g)" -v "$WORK:/work:ro" --entrypoint openssl backup \
    cms -decrypt -binary -inform DER -inkey /work/recipient.key -in "/work/backups/$1" </dev/null
}

# 1. pg_dump cut short, once and loop.
if bk -e FAIL_PG_DUMP=1 > "$WORK/1.log" 2>&1; then failog 1 "a cut pg_dump: once exited 0"; fi
grep -q 'postgres dump failed' "$WORK/1.log" || failog 1 "a cut pg_dump is not reported"
[ "$(dumps)" = 0 ] && [ -z "$(find "$B/pg" -name '*.counts')" ] && [ ! -e "$B/last-success.json" ] \
  || fail "a cut pg_dump left a dump, row counts or a success behind (once)"
ok "a pg_dump cut short leaves nothing and fails (once)"
"${C[@]}" run -d --no-deps --name ph-backup-test-loop -e FAIL_PG_DUMP=1 backup loop >/dev/null
loop_failed() { [ -e "$B/last-failure.json" ] && docker logs ph-backup-test-loop 2>&1 | grep -q '"backup failed"'; }
for _ in $(seq 1 60); do loop_failed && break; sleep 1; done
loop_failed || fail "loop: no last-failure.json and no failure logged after a cut pg_dump"
if docker logs ph-backup-test-loop 2>&1 | grep -q '"backup ok"'; then fail "loop: a cut pg_dump logged as a success"; fi
[ "$(dumps)" = 0 ] && [ ! -e "$B/last-success.json" ] || fail "loop: a cut pg_dump left a dump or a success behind"
docker rm -f ph-backup-test-loop >/dev/null
ok "a pg_dump cut short leaves nothing and fails (loop, the image's default)"

# 2. An object read cut mid-stream.
if bk -e FAIL_CAT_KEY=uploads/tus/big > "$WORK/2.log" 2>&1; then failog 2 "a cut object read: once exited 0"; fi
grep -q 'object copy failed bucket=uploads' "$WORK/2.log" || failog 2 "a cut object read is not reported"
[ ! -e "$B/objects/uploads/tus/big.cms" ] && [ ! -e "$B/last-success.json" ] || fail "a cut object read left a copy or a success"
ok "an object read cut mid-stream leaves no copy and fails"

# 3. and 4. An object removed between the listing and the read; every copy decrypts to its source; then nothing again.
bk -e FAIL_CAT_KEY=uploads/tus/gone -e FAIL_CAT_VANISH=1 > "$WORK/3.log" 2>&1 || failog 3 "a vanished object failed the backup"
[ "$(last objects_vanished)" = 1 ] && [ ! -e "$B/objects/uploads/tus/gone.cms" ] || fail "the vanished object is not counted as such"
ok "an object removed between the listing and the read is counted, not a failure"
for o in "uploads/tus/big:big" "uploads/tus/big.part:big.part" "media/derived/m1/f1/proxy-480p.mp4:proxy"; do
  rel="objects/${o%%:*}.cms" src="$WORK/${o#*:}"
  [ "$(cat "$B/$rel.size")" = "$(wc -c < "$src")" ] || fail "$rel: recorded size is not the source's"
  [ "$(dec "$rel" | sha256sum | cut -d' ' -f1)" = "$(sha256sum < "$src" | cut -d' ' -f1)" ] || fail "$rel does not decrypt to its source"
done
ts="$(basename "$(find "$B/pg" -name '*.dump.cms' | sort | tail -1)" .dump.cms)"
[ "$(dec "pg/$ts.dump.cms" | wc -c)" = "$(cat "$B/pg/$ts.dump.cms.size")" ] || fail "the dump does not decrypt to its recorded size"
[ "$(last objects_new)" = 3 ] || fail "first full backup: objects_new is $(last objects_new), not 3"
sleep 1   # a new dump name (seconds resolution)
bk > "$WORK/4.log" 2>&1 || failog 4 "second backup"
[ "$(last objects_new)" = 0 ] && [ "$(last objects_recopied)" = 0 ] || fail "a second run copied objects again"
ok "every copy decrypts to its source with its size recorded, and a second run copies nothing again"

# 5. Partial copies kept by the old script: one with no recorded size, one whose size does not match the listing.
"${C[@]}" run --rm --no-deps -T --entrypoint sh backup -c '
  set -e
  proto="${S3_ENDPOINT%%://*}"; host="${S3_ENDPOINT#*://}"
  export MC_HOST_src="${proto}://${S3_BACKUP_ACCESS_KEY}:${S3_BACKUP_SECRET_KEY}@${host}"
  /usr/local/bin/mc cat src/uploads/tus/big | head -c 1000 \
    | openssl cms -encrypt -binary -stream -outform DER -aes-256-gcm -out /backups/objects/uploads/tus/big.cms /run/backup/recipient.crt
  rm /backups/objects/uploads/tus/big.cms.size
  echo 1 > /backups/objects/media/derived/m1/f1/proxy-480p.mp4.cms.size' </dev/null || fail "planting partial copies"
sleep 1
bk > "$WORK/5.log" 2>&1 || failog 5 "backup over partial copies"
[ "$(last objects_recopied)" = 2 ] || fail "partial copies: objects_recopied is $(last objects_recopied), not 2"
[ "$(dec objects/uploads/tus/big.cms | sha256sum | cut -d' ' -f1)" = "$(sha256sum < "$WORK/big" | cut -d' ' -f1)" ] \
  || fail "the partial copy was not replaced by a whole one"
ok "a copy without its size, or with a size that does not match the listing, is copied again"

# 6. The restore drill: passes on the good backup, records fail (and exits non-zero) on truncated dumps.
drill() { COMPOSE="${C[*]}" BACKUP_DIR="$B" SAMPLE=3 DRILL_ENV=backup-test "$HERE/../restore-drill.sh" --key "$WORK/recipient.key" --out "$WORK/$1.json"; }
field() { python3 -c 'import json, sys; d = json.load(open(sys.argv[1])); print(d["result"] if sys.argv[2] == "result" else d["metrics"][sys.argv[2]])' "$WORK/$1.json" "$2"; }
drill good > "$WORK/6.log" 2>&1 || failog 6 "the restore drill fails on a good backup"
[ "$(field good result)" = partial ] && [ "$(field good dump_plain_bytes_match)" = True ] && [ "$(field good objects_sampled)" = 3 ] \
  || fail "the drill on a good backup is not partial with the size matched and three objects sampled"
ok "the restore drill passes (partial) on the good backup, the dump at the size the backup counted"
ts="$(basename "$(find "$B/pg" -name '*.dump.cms' | sort | tail -1)" .dump.cms)"
cut="$(date -u -d '+1 hour' +%Y%m%dT%H%M%SZ)" torn="$(date -u -d '+2 hours' +%Y%m%dT%H%M%SZ)"
# Written as the backup's own user (the backup directory is its own); the half dump is synthetic rows, in the test's directory.
as_backup() { "${C[@]}" run --rm --no-deps -T -v "$WORK:/work:ro" --entrypoint sh backup -c "$@" </dev/null; }
# What the old script kept: a whole, valid encryption of a dump cut short, with a consistent size.
dec "pg/$ts.dump.cms" > "$WORK/db.dump" || fail "decrypting the good dump"
head -c "$(( $(wc -c < "$WORK/db.dump") / 2 ))" "$WORK/db.dump" > "$WORK/cut.dump" && chmod 644 "$WORK/cut.dump"
as_backup 'set -e; d=/backups/pg
  openssl cms -encrypt -binary -stream -outform DER -aes-256-gcm -in /work/cut.dump -out "$d/$2.dump.cms" /run/backup/recipient.crt
  wc -c < /work/cut.dump > "$d/$2.dump.cms.size"; cp "$d/$1.counts" "$d/$2.counts"' sh "$ts" "$cut" || fail "planting a cut dump"
if drill cut > "$WORK/7.log" 2>&1; then failog 7 "the drill passed on a dump cut short"; fi
[ "$(field cut result)" = fail ] && [ "$(field cut dump_decrypted)" = True ] && [ "$(field cut pg_restore_errors)" -ge 1 ] \
  || fail "the drill on a cut dump is not a recorded fail with pg_restore errors"
ok "the restore drill records fail for a dump cut before encryption"
as_backup 'set -e; d=/backups/pg
  head -c "$(( $(wc -c < "$d/$1.dump.cms") / 2 ))" "$d/$1.dump.cms" > "$d/$2.dump.cms"; cp "$d/$1.counts" "$d/$2.counts"' \
  sh "$ts" "$torn" || fail "planting a truncated encrypted dump"
if drill torn > "$WORK/8.log" 2>&1; then failog 8 "the drill passed on a truncated encrypted dump"; fi
[ -s "$WORK/torn.json" ] && [ "$(field torn result)" = fail ] && [ "$(field torn dump_decrypted)" = False ] \
  || fail "the drill on a truncated encrypted dump is not a recorded fail"
ok "the restore drill records fail, not a crash, for a truncated encrypted dump"
echo "backup fails closed: ok"
