#!/usr/bin/env bash
# نافذة مفتاح الاختبار qa- على مضيف التجربة (ADR 0022)، بصلاحية root، لتشغيل حزمة القبول برموز ingest يوقّعها المشغّل:
#   sudo infra/field-trial/qa-window.sh open --email <بريد حساب القبول> [--hours 24] [--out /run/post-history/qa]
#   sudo infra/field-trial/qa-window.sh open --user-id <uuid> ...
#   sudo infra/field-trial/qa-window.sh close
# open: مفتاح P-256 جديد لكل نافذة (لا يُعاد استعماله ولا يدخل المستودع)، معرّفه qa-<UTC>-<عشوائي>، وانتهاؤه بعد --hours
# (حد أقصى QA_WINDOW_MAX_HOURS، افتراضيًا 72). يكتب في ملف الأسرار المفكوك (tmpfs) المفتاح العام وانتهاءه ومعرّف حساب
# القبول، ثم يعيد إنشاء الخادم والبوابة. المفتاح الخاص في --out (tmpfs، 0600) وحده؛ لا يُطبع ولا يُكتب في سجل.
# الملف المختوم على القرص لا يتغير: إعادة الإقلاع تغلق النافذة. close: يزيل الثلاثة ويحذف المفتاح الخاص ويعيد الإنشاء.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
T="${TRIAL_SH:-$HERE/trial.sh}"
ENV_FILE="${TRIAL_ENV_FILE:-/run/post-history/trial.env}"
MAX_HOURS="${QA_WINDOW_MAX_HOURS:-72}"
KEYS=(INGEST_QA_PUBLIC_KEY INGEST_QA_KEY_EXPIRES ACCEPTANCE_UPLOADER_USER_ID)
UUID_RE='^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
die() { echo "qa-window: $*" >&2; exit 1; }
usage() { echo "usage: $0 open (--email EMAIL | --user-id UUID) [--hours N] [--out DIR] | close [--out DIR]" >&2; exit 2; }

[ $# -ge 1 ] || usage
cmd="$1"; shift
email="" user="" hours=24 out="${QA_WINDOW_DIR:-/run/post-history/qa}"
while [ $# -gt 0 ]; do
  case "$1" in
    --email) email="$2"; shift 2 ;;
    --user-id) user="$2"; shift 2 ;;
    --hours) hours="$2"; shift 2 ;;
    --out) out="$2"; shift 2 ;;
    *) usage ;;
  esac
done
[ -f "$ENV_FILE" ] || die "secrets file $ENV_FILE missing (unseal first)"

# Rewrites the secrets file without the qa slot plus the given lines, keeping its mode (written next to it, then moved).
rewrite() {
  local tmp
  tmp="$(mktemp "$(dirname "$ENV_FILE")/.trial.env.XXXXXX")"
  grep -vE "^($(IFS='|'; echo "${KEYS[*]}"))=" "$ENV_FILE" > "$tmp" || true
  [ $# -eq 0 ] || printf '%s\n' "$@" >> "$tmp"
  chmod "$(stat -c %a "$ENV_FILE")" "$tmp"
  mv -f "$tmp" "$ENV_FILE"
}
recreate() { "$T" up -d --wait --no-deps --force-recreate api ingest-gate >/dev/null; }

case "$cmd" in
  open)
    grep -qE '^INGEST_QA_PUBLIC_KEY=.' "$ENV_FILE" && die "a window is already open: close it first (a key is never reused)"
    [[ "$hours" =~ ^[0-9]+$ ]] && [ "$hours" -ge 1 ] && [ "$hours" -le "$MAX_HOURS" ] || die "--hours must be 1..$MAX_HOURS"
    if [ -n "$email" ]; then
      # Looked up inside the postgres container; the address goes in on stdin, not on the host's command line.
      user="$(printf '%s\n' "$email" | "$T" exec -T postgres sh -c '
        read -r e
        echo "SELECT id FROM users WHERE lower(email) = lower(:'"'"'e'"'"') AND status = '"'"'active'"'"';" |
          psql -XAtq -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v e="$e"')" || die "account lookup failed"
    fi
    [[ "$user" =~ $UUID_RE ]] || die "no active acceptance account (give --email of an active account or --user-id)"
    umask 077
    mkdir -p "$out"
    rm -f "$out/qa-signing.pem"
    openssl ecparam -name prime256v1 -genkey -noout -out "$out/qa-signing.pem" 2>/dev/null
    spki="$(openssl ec -in "$out/qa-signing.pem" -pubout -outform DER 2>/dev/null | base64 -w0)"
    kid="qa-$(date -u +%Y%m%d%H%M)-$(openssl rand -hex 3)"
    expires="$(date -u -d "+$hours hours" +%FT%TZ)"
    rewrite "INGEST_QA_PUBLIC_KEY=$kid:$spki" "INGEST_QA_KEY_EXPIRES=$expires" "ACCEPTANCE_UPLOADER_USER_ID=$user"
    recreate
    echo "qa window open until $expires"
    echo "  FT_INGEST_KID=$kid FT_INGEST_SIGNING_KEY=$out/qa-signing.pem (copy the key off the host over ssh; never into the repository)"
    echo "  close it with: $0 close"
    ;;
  close)
    rewrite
    rm -f "$out/qa-signing.pem"
    recreate
    echo "qa window closed: no qa key at the gate, no acceptance account at the API"
    ;;
  *) usage ;;
esac
