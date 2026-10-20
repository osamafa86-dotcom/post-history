#!/usr/bin/env bash
# بروفة حزمة القبول الميدانية عبر الحافة (Caddy بشهادة داخلية) قبل المضيف الحقيقي. تُستدعى من infra/field-trial/smoke-trial.sh
# عبر TRIAL_AFTER_EDGE؛ البيئة المصدّرة: WORK T CA_FILE API_URL DATABASE_URL MAIN_DOMAIN. الحزمة نفسها لا تعرف أنها على الحافة:
# تأخذ https://$MAIN_DOMAIN كأي مضيف بعيد، وتثق بسلطة Caddy المحلية عبر NODE_EXTRA_CA_CERTS.
# المخرجات في ${EDGE_PACK_OUT:-$WORK/pack}: نتائج الخطوات وREPORT.md.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
OUT="${EDGE_PACK_OUT:-$WORK/pack}"
for k in WORK CA_FILE API_URL DATABASE_URL MAIN_DOMAIN; do [ -n "${!k:-}" ] || { echo "$k is required" >&2; exit 2; }; done

# الاسم يصل إلى 127.0.0.1 كما يصل إليه الجهاز بعد DNS؛ *.localhost لا يحلّه كل نظام.
getent hosts "$MAIN_DOMAIN" >/dev/null 2>&1 || echo "127.0.0.1 $MAIN_DOMAIN" | sudo tee -a /etc/hosts >/dev/null

# الحسابات تُزرع على الخادم مباشرة (كحسابات المشرف التجريبية)، وكل ما بعدها يمر من الحافة.
FT_ACCOUNTS="$(DATABASE_URL="$DATABASE_URL" API_URL="$API_URL" node "$ROOT/tools/acceptance/field-trial/rehearsal-accounts.mjs")"
export FT_ACCOUNTS NODE_EXTRA_CA_CERTS="$CA_FILE"
unset FT_API_URL FT_TUS_URL   # العنوانان الافتراضيان للمضيف: <base>/v1 و<base>/files/

node "$ROOT/tools/acceptance/run.mjs" --target "https://$MAIN_DOMAIN" --confirm --allow-publish-form --out-dir="$OUT"
[ -s "$OUT/REPORT.md" ] || { echo "no pack report" >&2; exit 1; }
head -60 "$OUT/REPORT.md"
