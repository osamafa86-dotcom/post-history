#!/usr/bin/env bash
# حسابات المعاينة التجريبية ومواد اصطناعية (ADR 0023)، بعد up على الخادم، من هذا المجلد:  ./seed-preview.sh
# بريد كل حساب بنطاق .invalid وكلمة سر عشوائية تُضاف إلى .env (0600) مرة ولا تُطبع؛ تشغيل ثانٍ يعيد ضبط الحسابات بالقيم نفسها.
# لا حساب مدير نظام: ذاك بالمسار الثنائي المعتاد (cli:set-admin-status) إن لزم.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
[ -f .env ] || { echo ".env missing: run gen-env.sh first" >&2; exit 1; }
C=(docker compose -f docker-compose.preview.yml)
val() { sed -n "s/^$1=//p" .env | tail -1; }
add=()
for r in SUPERVISOR EDITOR REPORTER; do
  [ -n "$(val "PREVIEW_${r}_EMAIL")" ] || add+=("PREVIEW_${r}_EMAIL=$(tr 'A-Z' 'a-z' <<<"$r")@preview.invalid")
  [ -n "$(val "PREVIEW_${r}_PASSWORD")" ] || add+=("PREVIEW_${r}_PASSWORD=$(openssl rand -hex 12)")
done
if [ ${#add[@]} -gt 0 ]; then
  tmp="$(mktemp .env.XXXXXX)"
  grep -vE "^PREVIEW_(SUPERVISOR|EDITOR|REPORTER)_(EMAIL|PASSWORD)=$" .env > "$tmp" || true
  printf '%s\n' "${add[@]}" >> "$tmp"
  chmod 600 "$tmp" && mv -f "$tmp" .env
fi
printf '{"supervisor":{"email":"%s","password":"%s"},"editor":{"email":"%s","password":"%s"},"reporter":{"email":"%s","password":"%s"}}' \
  "$(val PREVIEW_SUPERVISOR_EMAIL)" "$(val PREVIEW_SUPERVISOR_PASSWORD)" "$(val PREVIEW_EDITOR_EMAIL)" "$(val PREVIEW_EDITOR_PASSWORD)" \
  "$(val PREVIEW_REPORTER_EMAIL)" "$(val PREVIEW_REPORTER_PASSWORD)" | "${C[@]}" exec -T api node preview/seed-preview.mjs
echo "passwords are in .env (PREVIEW_*_PASSWORD), not printed"
