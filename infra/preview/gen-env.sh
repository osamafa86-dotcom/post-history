#!/usr/bin/env bash
# يولّد .env المعاينة (ADR 0023) مرة على الخادم، بجانب docker-compose.preview.yml، وشهادة TLS الداخلية في tls/:
#   PREVIEW_DOMAIN=<النطاق> ./gen-env.sh
# أسرار عشوائية بصلاحية 0600 لا تُطبع. يرفض الكتابة فوق .env قائم (الأسرار تُدار مرة، ولا تُستبدل بإعادة تشغيل).
# الشهادة لاسم api.lib.internal وحده، من سلطة يُحذف مفتاحها بعد التوقيع، فلا تصدر شهادة ثانية منها.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
[ -n "${PREVIEW_DOMAIN:-}" ] || { echo "PREVIEW_DOMAIN is required (the domain stays in .env, never in the repository)" >&2; exit 2; }
[[ "$PREVIEW_DOMAIN" =~ ^[A-Za-z0-9.-]+$ ]] || { echo "PREVIEW_DOMAIN must be a bare host name" >&2; exit 2; }
[ ! -e .env ] || { echo ".env exists: not overwritten" >&2; exit 1; }
umask 077
hex() { openssl rand -hex "$1"; }
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
