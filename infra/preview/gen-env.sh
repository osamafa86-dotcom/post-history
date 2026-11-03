#!/usr/bin/env bash
# يولّد .env المعاينة (ADR 0023) مرة على الخادم، بجانب docker-compose.preview.yml، وشهادة TLS الداخلية في tls/:
#   PREVIEW_DOMAIN=<النطاق> ./gen-env.sh
#   ./gen-env.sh --add-upload     # .env قائم من قبل الرفع: يضيف مفاتيح الرفع الناقصة وحدها ولا يمس الباقي
#   ./gen-env.sh --add-media      # .env قائم من قبل عامل الوسائط (ADR 0092): يضيف كل مفتاح ناقص منها وحده ولا يمس الموجود
#   ./gen-env.sh --add-render     # .env قائم من قبل نسخ القالب (ملحق ADR 0092): مستخدم media-render في MinIO وعنوانه، كذلك
#   ./gen-env.sh --add-storage    # .env قائم من قبل مستخدمي tusd والخادم في MinIO (كانا بالجذر): مفاتيحهما الأربعة، كذلك
# أسرار عشوائية بصلاحية 0600 لا تُطبع. يرفض الكتابة فوق .env قائم (الأسرار تُدار مرة، ولا تُستبدل بإعادة تشغيل).
# الشهادة لاسم api.lib.internal وحده، من سلطة يُحذف مفتاحها بعد التوقيع، فلا تصدر شهادة ثانية منها.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
umask 077
hex() { openssl rand -hex "$1"; }
# مفاتيح الرفع من الحاسوب: زوج ES256 لرمز ingest (الخاص للخادم، العام للبوابة)، وسر البوابة، وعنوانا tusd والبوابة.
upload_env() {
  local key; key="$(openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 2>/dev/null)"
  echo "INGEST_TOKEN_SIGNING_KEY=$(printf '%s\n' "$key" | openssl pkcs8 -topk8 -nocrypt -outform DER | base64 -w0)"
  echo "INGEST_TOKEN_KEY_ID=k1"
  echo "INGEST_TOKEN_PUBLIC_KEYS=k1:$(printf '%s\n' "$key" | openssl pkey -pubout -outform DER | base64 -w0)"
  echo "INGEST_GATE_TOKEN=$(hex 32)"
  sed -n '/^PREVIEW_TUSD_IP=/p;/^PREVIEW_GATE_IP=/p' preview.env.example
}
# مفاتيح عامل الوسائط (ADR 0092): رمزه نحو /internal/media، ومستخدمه في MinIO (ينشئه minio-init.sh)، وعنوانه الثابت.
media_env() {
  echo "MEDIA_WORKER_TOKEN=$(hex 32)"
  echo "S3_MEDIA_ACCESS_KEY=preview-media-$(hex 6)"
  echo "S3_MEDIA_SECRET_KEY=$(hex 24)"
  sed -n '/^PREVIEW_MEDIA_IP=/p' preview.env.example
}
# مفاتيح media-render (نسخ قالب «مواد متداولة»، ملحق ADR 0092): مستخدمه في MinIO (يكتب derived/*/*/renders/ وحدها، ينشئه
# minio-init.sh) وعنوانه الثابت. رمزه نحو /internal/media هو MEDIA_WORKER_TOKEN نفسه، والخادم يقصر عنوانه على مسارات النسخ.
render_env() {
  echo "S3_RENDER_ACCESS_KEY=preview-render-$(hex 6)"
  echo "S3_RENDER_SECRET_KEY=$(hex 24)"
  sed -n '/^PREVIEW_RENDER_IP=/p' preview.env.example
}
# مستخدما tusd والخادم في MinIO (minio-init.sh): tusd يقرأ ويكتب حاوية الرفع وحدها، والخادم يقرأ الحاويتين ويحذف كائنات tus،
# والجذر (S3_ACCESS_KEY) لـ minio-init وحده.
storage_env() {
  echo "S3_TUSD_ACCESS_KEY=preview-tusd-$(hex 6)"
  echo "S3_TUSD_SECRET_KEY=$(hex 24)"
  echo "S3_API_ACCESS_KEY=preview-api-$(hex 6)"
  echo "S3_API_SECRET_KEY=$(hex 24)"
}
# .env قائم: يضيف كل مفتاح ناقص (أو فارغ) من المجموعة وحده، ولا يمس الموجود ولا يطبع قيمة.
add_keys() {
  local what="$1" gen="$2" added=0 line tmp
  [ -f .env ] || { echo "no .env here: run gen-env.sh without options first" >&2; exit 1; }
  while IFS= read -r line; do
    grep -q "^${line%%=*}=." .env && continue
    tmp="$(mktemp .env.XXXXXX)"
    grep -v "^${line%%=*}=" .env > "$tmp" || true
    printf '%s\n' "$line" >> "$tmp"
    chmod 600 "$tmp" && mv -f "$tmp" .env
    added=$((added + 1))
  done < <("$gen")
  echo "$what keys: $added added to .env, the rest kept (no value printed)"
}
case "${1:-}" in
  --add-media) add_keys "media worker" media_env; exit 0 ;;
  --add-render) add_keys "media-render" render_env; exit 0 ;;
  --add-storage) add_keys "tusd and API storage user" storage_env; exit 0 ;;
esac
if [ "${1:-}" = --add-upload ]; then
  [ -f .env ] || { echo "no .env here: run without --add-upload first" >&2; exit 1; }
  if grep -q '^INGEST_TOKEN_SIGNING_KEY=.' .env; then echo "upload keys exist in .env: not changed"; exit 0; fi
  upload_env >> .env
  echo "upload keys added to .env (no value printed)"
  exit 0
fi
[ -n "${PREVIEW_DOMAIN:-}" ] || { echo "PREVIEW_DOMAIN is required (the domain stays in .env, never in the repository)" >&2; exit 2; }
[[ "$PREVIEW_DOMAIN" =~ ^[A-Za-z0-9.-]+$ ]] || { echo "PREVIEW_DOMAIN must be a bare host name" >&2; exit 2; }
[ ! -e .env ] || { echo ".env exists: not overwritten (--add-upload adds the upload keys to it)" >&2; exit 1; }
{
  sed -n '/^PREVIEW_SUBNET=/p;/^PREVIEW_EDGE_IP=/p' preview.env.example
  cat <<ENV
PREVIEW_DOMAIN=$PREVIEW_DOMAIN
POSTGRES_DB=posthistory
POSTGRES_USER=posthistory
POSTGRES_PASSWORD=$(hex 24)
REDIS_PASSWORD=$(hex 24)
S3_ACCESS_KEY=preview-$(hex 6)
S3_SECRET_KEY=$(hex 24)
S3_BUCKET_UPLOADS=preview-uploads
S3_BUCKET_MEDIA=preview-media
JWT_SECRET=$(hex 32)
FIELD_ENCRYPTION_KEY=$(openssl rand -base64 32)
TUSD_HOOK_SECRET=$(hex 32)
WEB_SESSION_KEY=$(openssl rand -base64 32)
ENV
  upload_env
  media_env
  render_env
  storage_env
} > .env.tmp
mv .env.tmp .env

mkdir -p tls
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 825 -subj "/CN=post-history preview internal CA" \
  -keyout tls/ca.key -out tls/ca.crt 2>/dev/null
openssl req -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -subj /CN=api.lib.internal \
  -keyout tls/api.key -out tls/api.csr 2>/dev/null
printf 'subjectAltName=DNS:api.lib.internal\nextendedKeyUsage=serverAuth\n' > tls/ext
openssl x509 -req -in tls/api.csr -CA tls/ca.crt -CAkey tls/ca.key -CAcreateserial -days 825 -extfile tls/ext -out tls/api.crt 2>/dev/null
rm -f tls/ca.key tls/ca.srl tls/api.csr tls/ext
# Read inside the containers: the CA by the node user, the key by nginx (uid 101).
chmod 0644 tls/ca.crt tls/api.crt
if [ "$(id -u)" = 0 ]; then chown 101:101 tls/api.key; chmod 0400 tls/api.key; else chmod 0644 tls/api.key; fi
chmod 0755 tls
echo "preview .env and internal certificate written (no value printed)"
