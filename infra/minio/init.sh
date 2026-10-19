#!/bin/sh
# تهيئة MinIO المحلي: الحاويتان، ومستخدم مستقل لعامل الوسائط (ADR 0006) بأقل صلاحية:
# قراءة على بادئة الرفع في حاوية الرفع، وكتابة على derived/ في حاوية الوسائط. بلا حذف ولا سرد خارجهما.
set -eu

mc alias set local http://minio:9000 "$S3_ACCESS_KEY" "$S3_SECRET_KEY" >/dev/null
mc mb --ignore-existing "local/$S3_BUCKET_UPLOADS"
mc mb --ignore-existing "local/$S3_BUCKET_MEDIA"

if [ -n "${S3_MEDIA_ACCESS_KEY:-}" ] && [ -n "${S3_MEDIA_SECRET_KEY:-}" ]; then
  policy=/tmp/media-worker-policy.json
  cat >"$policy" <<JSON
{
  "Version": "2012-10-17",
  "Statement": [
    {"Effect": "Allow", "Action": ["s3:GetObject"],
     "Resource": ["arn:aws:s3:::$S3_BUCKET_UPLOADS/${TUSD_OBJECT_PREFIX}*"]},
    {"Effect": "Allow", "Action": ["s3:PutObject", "s3:AbortMultipartUpload", "s3:ListMultipartUploadParts"],
     "Resource": ["arn:aws:s3:::$S3_BUCKET_MEDIA/derived/*"]}
  ]
}
JSON
  mc admin user add local "$S3_MEDIA_ACCESS_KEY" "$S3_MEDIA_SECRET_KEY" >/dev/null
  mc admin policy create local media-worker "$policy" >/dev/null 2>&1 || mc admin policy update local media-worker "$policy" >/dev/null 2>&1 || true
  mc admin policy attach local media-worker --user "$S3_MEDIA_ACCESS_KEY" >/dev/null 2>&1 || true
  echo "media worker user ready (read ${S3_BUCKET_UPLOADS}/${TUSD_OBJECT_PREFIX}*, write ${S3_BUCKET_MEDIA}/derived/*)"
fi
echo buckets ready
