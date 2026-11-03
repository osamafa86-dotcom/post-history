#!/bin/sh
# تهيئة MinIO المعاينة (ADR 0023 و0092)، مرة عند كل up: الحاويتان وحصتاهما الصلبتان، ومستخدم بأقل صلاحية لكل عميل: tusd
# والخادم وعامل الوسائط وmedia-render. الجذر (S3_ACCESS_KEY) لهذه الحاوية وحدها.
# - الرفع 10112 MiB (كما في 0023)، والمشتقات 2048 MiB (كانت 64 MiB ولا عامل)، وأجزاء tusd المؤقتة 64 MiB خارجهما.
# - tusd: يقرأ ويكتب ويحذف في حاوية الرفع وحدها (الكائن و.info و.part وأجزاء الرفع المتعدد)، ويسردها (بلا سرد يرد MinIO على
#   HEAD لكائن غائب بـ 403 لا 404). لا حاوية المشتقات ولا الإدارة.
# - الخادم: يقرأ الرفع (التحقق والروابط الموقّعة) والمشتقات، ويحذف كائنات tus لجلسة ملغاة ويلغي رفعها المتعدد. لا كتابة ولا إدارة.
# - عامل الوسائط: يقرأ كائنات الرفع لا ملفاتها الجانبية (.info تحمل بيانات tus الوصفية، و.part)، ويقرأ derived/ في حاوية
#   المشتقات ويكتب فيها (القراءة لإعادة تسجيل ما رفعه قبل انقطاع). لا سرد ولا حذف ولا كتابة في حاوية الرفع.
# - media-render (نسخ قالب «مواد متداولة»، ADR 0091، ملحق ADR 0092): يقرأ كائنات الرفع كالعامل، ويقرأ ويكتب
#   derived/<المادة>/<الأصل>/renders/ وحدها، فلا يمس النسخ الخفيفة ولا المصغّرات. لا سرد ولا حذف.
# المفاتيح من البيئة إلى ملف إعداد mc في /tmp (tmpfs)، لا في سطر الأوامر.
set -eu
m() { mc --config-dir /tmp/mc "$@"; }
m alias set local http://minio:9000 "$S3_ACCESS_KEY" "$S3_SECRET_KEY" >/dev/null
m mb --ignore-existing "local/$S3_BUCKET_UPLOADS" "local/$S3_BUCKET_MEDIA" >/dev/null
m quota set "local/$S3_BUCKET_UPLOADS" --size 10112MiB >/dev/null
m quota set "local/$S3_BUCKET_MEDIA" --size 2048MiB >/dev/null
tusd_policy=/tmp/tusd-policy.json
cat >"$tusd_policy" <<JSON
{
  "Version": "2012-10-17",
  "Statement": [
    {"Effect": "Allow", "Action": ["s3:ListBucket", "s3:ListBucketMultipartUploads", "s3:GetBucketLocation"],
     "Resource": ["arn:aws:s3:::$S3_BUCKET_UPLOADS"]},
    {"Effect": "Allow", "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:AbortMultipartUpload",
                                   "s3:ListMultipartUploadParts"],
     "Resource": ["arn:aws:s3:::$S3_BUCKET_UPLOADS/*"]}
  ]
}
JSON
m admin user add local "$S3_TUSD_ACCESS_KEY" "$S3_TUSD_SECRET_KEY" >/dev/null
m admin policy create local preview-tusd "$tusd_policy" >/dev/null
m admin policy attach local preview-tusd --user "$S3_TUSD_ACCESS_KEY" >/dev/null 2>&1 || true
api_policy=/tmp/api-policy.json
cat >"$api_policy" <<JSON
{
  "Version": "2012-10-17",
  "Statement": [
    {"Effect": "Allow", "Action": ["s3:ListBucket", "s3:GetBucketLocation"],
     "Resource": ["arn:aws:s3:::$S3_BUCKET_UPLOADS", "arn:aws:s3:::$S3_BUCKET_MEDIA"]},
    {"Effect": "Allow", "Action": ["s3:ListBucketMultipartUploads"], "Resource": ["arn:aws:s3:::$S3_BUCKET_UPLOADS"]},
    {"Effect": "Allow", "Action": ["s3:GetObject", "s3:DeleteObject", "s3:AbortMultipartUpload"],
     "Resource": ["arn:aws:s3:::$S3_BUCKET_UPLOADS/*"]},
    {"Effect": "Allow", "Action": ["s3:GetObject"], "Resource": ["arn:aws:s3:::$S3_BUCKET_MEDIA/*"]}
  ]
}
JSON
m admin user add local "$S3_API_ACCESS_KEY" "$S3_API_SECRET_KEY" >/dev/null
m admin policy create local preview-api "$api_policy" >/dev/null
m admin policy attach local preview-api --user "$S3_API_ACCESS_KEY" >/dev/null 2>&1 || true
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
render_policy=/tmp/media-render-policy.json
cat >"$render_policy" <<JSON
{
  "Version": "2012-10-17",
  "Statement": [
    {"Effect": "Allow", "Action": ["s3:GetObject"], "Resource": ["arn:aws:s3:::$S3_BUCKET_UPLOADS/*"]},
    {"Effect": "Deny", "Action": ["s3:GetObject"],
     "Resource": ["arn:aws:s3:::$S3_BUCKET_UPLOADS/*.info", "arn:aws:s3:::$S3_BUCKET_UPLOADS/*.part"]},
    {"Effect": "Allow", "Action": ["s3:GetObject", "s3:PutObject"], "Resource": ["arn:aws:s3:::$S3_BUCKET_MEDIA/derived/*/*/renders/*"]}
  ]
}
JSON
m admin user add local "$S3_RENDER_ACCESS_KEY" "$S3_RENDER_SECRET_KEY" >/dev/null
m admin policy create local preview-media-render "$render_policy" >/dev/null
m admin policy attach local preview-media-render --user "$S3_RENDER_ACCESS_KEY" >/dev/null 2>&1 || true
echo "buckets, quotas and the tusd, API, media worker and media-render users ready"
