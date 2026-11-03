#!/bin/sh
# تهيئة MinIO المعاينة (ADR 0023 و0092)، مرة عند كل up: الحاويتان وحصتاهما الصلبتان، ومستخدم عامل الوسائط بأقل صلاحية.
# - الرفع 10112 MiB (كما في 0023)، والمشتقات 2048 MiB (كانت 64 MiB ولا عامل)، وأجزاء tusd المؤقتة 64 MiB خارجهما.
# - عامل الوسائط: يقرأ كائنات الرفع لا ملفاتها الجانبية (.info تحمل بيانات tus الوصفية، و.part)، ويقرأ derived/ في حاوية
#   المشتقات ويكتب فيها (القراءة لإعادة تسجيل ما رفعه قبل انقطاع). لا سرد ولا حذف ولا كتابة في حاوية الرفع.
# المفاتيح من البيئة إلى ملف إعداد mc في /tmp (tmpfs)، لا في سطر الأوامر.
set -eu
m() { mc --config-dir /tmp/mc "$@"; }
m alias set local http://minio:9000 "$S3_ACCESS_KEY" "$S3_SECRET_KEY" >/dev/null
m mb --ignore-existing "local/$S3_BUCKET_UPLOADS" "local/$S3_BUCKET_MEDIA" >/dev/null
m quota set "local/$S3_BUCKET_UPLOADS" --size 10112MiB >/dev/null
m quota set "local/$S3_BUCKET_MEDIA" --size 2048MiB >/dev/null
policy=/tmp/media-worker-policy.json
cat >"$policy" <<JSON
{
  "Version": "2012-10-17",
  "Statement": [
    {"Effect": "Allow", "Action": ["s3:GetObject"], "Resource": ["arn:aws:s3:::$S3_BUCKET_UPLOADS/*"]},
    {"Effect": "Deny", "Action": ["s3:GetObject"],
     "Resource": ["arn:aws:s3:::$S3_BUCKET_UPLOADS/*.info", "arn:aws:s3:::$S3_BUCKET_UPLOADS/*.part"]},
    {"Effect": "Allow", "Action": ["s3:GetObject", "s3:PutObject"], "Resource": ["arn:aws:s3:::$S3_BUCKET_MEDIA/derived/*"]}
  ]
}
JSON
m admin user add local "$S3_MEDIA_ACCESS_KEY" "$S3_MEDIA_SECRET_KEY" >/dev/null
m admin policy create local preview-media-worker "$policy" >/dev/null
m admin policy attach local preview-media-worker --user "$S3_MEDIA_ACCESS_KEY" >/dev/null 2>&1 || true
echo "buckets, quotas and the media worker user ready"
