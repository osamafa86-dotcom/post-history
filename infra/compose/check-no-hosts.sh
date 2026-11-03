#!/usr/bin/env bash
# المستودع عام: لا نطاق إنتاج ولا تجربة ولا عنوان IP عام لخادم في ملفات التشغيل. النطاقات والعناوين في ملف الأسرار
# المختوم على المضيف وحده (trial.env، host.env)، والأمثلة بـ example.* أو .invalid أو نطاقات التوثيق (RFC 5737).
# يفحص ما يُتتبَّع في infra/ وdocs/ops/ و.github/ وtools/netlab/ وكل *.env.example، ومصدر التطبيقات والخدمات
# (apps/<التطبيق>/src/ وapps/ios/App/ وcontracts/ وworkers/: ما يُشحن في الصور أو يُقرأ في المستودع العام)، ويفشل بقائمة ما وجده.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
mapfile -t ops < <(git ls-files infra docs/ops .github tools/netlab '*.env.example' | sort -u)
# مصدر التطبيقات والخدمات: ملفات الكود فيه لا يُحسب فيها المضيف إلا داخل نص مقتبس أو مسار URL (item.id وNEW.id ومحدِّدات CSS
# وصول خصائص لا مضيفون)، وغيرها (Dockerfile، الرخص، العقود، ملفات القفل) يُفحص كملفات التشغيل.
mapfile -t src < <(git ls-files ':(glob)apps/*/src/**' apps/ios/App contracts workers | sort -u)
code=() files=("${ops[@]}")
for f in "${src[@]}"; do
  case "$f" in
    *.ts|*.tsx|*.js|*.jsx|*.mjs|*.cjs|*.css|*.sql|*.py|*.swift|*.kt) code+=("$f") ;;
    *) files+=("$f") ;;
  esac
done

# عناوين عامة مسموحة بالاسم: هدف فحص الخروج (العامل يجب ألا يصله)، وعيّنتا نطاقات Cloudflare المنشورة في الفحص الجاف.
ip_allow='^(1\.1\.1\.1|173\.245\.48\.0|103\.21\.244\.0)$'
ip_private='^(0\.|10\.|127\.|169\.254\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.|192\.0\.2\.|198\.51\.100\.|203\.0\.113\.|22[4-9]\.|2[3-5][0-9]\.)'
# (معرّف حزمة بترتيب DNS المعكوس مثل ABCDE12345.org.example.field لا يطابق: الاسم يجب أن ينتهي عند النطاق الأعلى.)
# نطاقات المزوّدين والأدوات العامة التي يشير إليها التشغيل (سجلات الصور، الشهادات، الأوزان، التوثيق، ومزوّد الدفع)، والمعايير (W3C والمخططات)
# ورخص الخطوط ومصدرا Node وChrome Headless Shell في صورة العامل، والمضيف المثالي في متجه اختبار SigV4 من توثيق AWS، واسم
# رمز SF Symbols في تطبيق iOS (ليس مضيفًا).
host_allow='(^|\.)(example\.(com|net|org)|github\.com|githubusercontent\.com|ghcr\.io|quay\.io|docker\.(com|io)|containerd\.io|cloudflare\.com|cloudflarestorage\.com|letsencrypt\.org|huggingface\.co|crates\.io|age-encryption\.org|npmjs\.(org|com)|ubuntu\.com|debian\.org|alpinelinux\.org|apple\.com|googleapis\.com|google\.com|sentry\.io|glitchtip\.com|grafana\.com|prometheus\.io|opentelemetry\.io|min\.io|caddyserver\.com|nginx\.org|tus\.io|postgresql\.org|redis\.io|stripe\.com|w3\.org|json-schema\.org|schema\.org|sil\.org|openfontlicense\.org|nodejs\.org|remotion\.media|examplebucket\.s3\.amazonaws\.com|arrow\.up\.forward\.app)$'
tlds='com|net|org|io|dev|app|cloud|co|info|xyz|ps|news|tv|media|site|online|tech|me|ai|uk|de|fr|eu'

bad=()
# `==` قبل الرقم تثبيت إصدار حزمة في requirements (إصدار من أربعة أجزاء يشبه العنوان) لا عنوان.
while IFS=: read -r f n ip; do
  [[ "$ip" =~ $ip_private || "$ip" =~ $ip_allow ]] && continue
  IFS=. read -r a b c d <<<"$ip"; (( a <= 255 && b <= 255 && c <= 255 && d <= 255 )) || continue
  bad+=("$f:$n: public IPv4 $ip")
done < <(grep -HnIoE '(^|[^0-9.=])([0-9]{1,3}\.){3}[0-9]{1,3}($|[^0-9.])' "${files[@]}" "${code[@]}" | sed -E 's/:[^0-9]?(([0-9]{1,3}\.){3}[0-9]{1,3}).*/:\1/')
host_re="[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.($tlds)\b(?![.\w(-])"   # (?!\(): استدعاء دالة (log.info() لا مضيف
while IFS=: read -r f n host; do
  host="${host,,}"
  [[ "$host" =~ $host_allow ]] && continue
  # تعابير GitHub Actions (steps.x.outputs.media) ليست أسماء مضيفين
  [[ "$host" =~ ^(steps|needs|github|inputs|matrix|env|secrets|vars|runner|job|jobs)\. ]] && continue
  bad+=("$f:$n: host $host")
done < <({ grep -HnIoP "\b$host_re" "${files[@]}" || true
           [ ${#code[@]} -eq 0 ] || grep -HnIoP "(?<=[\"'\`/])$host_re" "${code[@]}" || true; } \
         | grep -vE ':[^:]*\.(sh|py|mjs|js|ts|yml|yaml|json|md|conf|env)$' || true)

if [ ${#bad[@]} -gt 0 ]; then
  echo "a domain or public address in the public repository (put it in the sealed secrets on the host, or allow it here if it is a public vendor):"
  printf '  %s\n' "${bad[@]}"
  exit 1
fi
echo "no domain or public address in $(( ${#files[@]} + ${#code[@]} )) files: ok"
