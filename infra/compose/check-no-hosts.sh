#!/usr/bin/env bash
# المستودع عام: لا نطاق إنتاج ولا تجربة ولا عنوان IP عام لخادم في ملفات التشغيل. النطاقات والعناوين في ملف الأسرار
# المختوم على المضيف وحده (trial.env، host.env)، والأمثلة بـ example.* أو .invalid أو نطاقات التوثيق (RFC 5737).
# يفحص ما يُتتبَّع في infra/ وdocs/ops/ و.github/ وtools/netlab/ وكل *.env.example، ويفشل بقائمة ما وجده.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
mapfile -t files < <(git ls-files infra docs/ops .github tools/netlab '*.env.example' | sort -u)

# عناوين عامة مسموحة بالاسم: هدف فحص الخروج (العامل يجب ألا يصله)، وعيّنتا نطاقات Cloudflare المنشورة في الفحص الجاف.
ip_allow='^(1\.1\.1\.1|173\.245\.48\.0|103\.21\.244\.0)$'
ip_private='^(0\.|10\.|127\.|169\.254\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.|192\.0\.2\.|198\.51\.100\.|203\.0\.113\.|22[4-9]\.|2[3-5][0-9]\.)'
# (معرّف حزمة بترتيب DNS المعكوس مثل ABCDE12345.org.example.field لا يطابق: الاسم يجب أن ينتهي عند النطاق الأعلى.)
# نطاقات المزوّدين والأدوات العامة التي يشير إليها التشغيل (سجلات الصور، الشهادات، الأوزان، التوثيق).
host_allow='(^|\.)(example\.(com|net|org)|github\.com|githubusercontent\.com|ghcr\.io|quay\.io|docker\.(com|io)|containerd\.io|cloudflare\.com|cloudflarestorage\.com|letsencrypt\.org|huggingface\.co|crates\.io|age-encryption\.org|npmjs\.(org|com)|ubuntu\.com|debian\.org|alpinelinux\.org|apple\.com|googleapis\.com|google\.com|sentry\.io|glitchtip\.com|grafana\.com|prometheus\.io|opentelemetry\.io|min\.io|caddyserver\.com|nginx\.org|tus\.io|postgresql\.org|redis\.io)$'
tlds='com|net|org|io|dev|app|cloud|co|info|xyz|ps|news|tv|media|site|online|tech|me|ai|uk|de|fr|eu'

bad=()
while IFS=: read -r f n ip; do
  [[ "$ip" =~ $ip_private || "$ip" =~ $ip_allow ]] && continue
  IFS=. read -r a b c d <<<"$ip"; (( a <= 255 && b <= 255 && c <= 255 && d <= 255 )) || continue
  bad+=("$f:$n: public IPv4 $ip")
done < <(grep -HnIoE '(^|[^0-9.])([0-9]{1,3}\.){3}[0-9]{1,3}($|[^0-9.])' "${files[@]}" | sed -E 's/:[^0-9]?(([0-9]{1,3}\.){3}[0-9]{1,3}).*/:\1/')
while IFS=: read -r f n host; do
  host="${host,,}"
  [[ "$host" =~ $host_allow ]] && continue
  # تعابير GitHub Actions (steps.x.outputs.media) ليست أسماء مضيفين
  [[ "$host" =~ ^(steps|needs|github|inputs|matrix|env|secrets|vars|runner|job|jobs)\. ]] && continue
  bad+=("$f:$n: host $host")
done < <(grep -HnIoP "\b[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.($tlds)\b(?![.\w-])" "${files[@]}" | grep -vE ':[^:]*\.(sh|py|mjs|js|ts|yml|yaml|json|md|conf|env)$' || true)

if [ ${#bad[@]} -gt 0 ]; then
  echo "a domain or public address in the public repository (put it in the sealed secrets on the host, or allow it here if it is a public vendor):"
  printf '  %s\n' "${bad[@]}"
  exit 1
fi
echo "no domain or public address in ${#files[@]} files: ok"
