#!/bin/sh
# تهيئة MinIO المحلي: الحاويتان، ومستخدم مستقل بأقل صلاحية لكل عميل: tusd والخادم وعامل الوسائط (ADR 0006) وعامل التفريغ
# والنسخ الاحتياطي. الجذر (S3_ACCESS_KEY) لهذه الحاوية وحدها. مستخدم بلا مفتاحيه في البيئة لا يُنشأ.
set -eu

# mkuser NAME ACCESS SECRET POLICY_FILE: المستخدم بسياسته، وإعادة التشغيل تحدّث السياسة ولا تفشل.
mkuser() {
  mc admin user add local "$2" "$3" >/dev/null
  mc admin policy create local "$1" "$4" >/dev/null 2>&1 || mc admin policy update local "$1" "$4" >/dev/null 2>&1 || true
  mc admin policy attach local "$1" --user "$2" >/dev/null 2>&1 || true
}

mc alias set local http://minio:9000 "$S3_ACCESS_KEY" "$S3_SECRET_KEY" >/dev/null
mc mb --ignore-existing "local/$S3_BUCKET_UPLOADS"
mc mb --ignore-existing "local/$S3_BUCKET_MEDIA"

# tusd: يقرأ ويكتب ويحذف بادئة الرفع في حاوية الرفع وحدها (الكائن و.info و.part وأجزاء الرفع المتعدد)، ويسرد الحاوية (بلا
# سرد يرد MinIO على HEAD لكائن غائب بـ 403 لا 404، فيظنه tusd عطلًا). لا يرى حاوية الوسائط ولا الإدارة.
if [ -n "${S3_TUSD_ACCESS_KEY:-}" ] && [ -n "${S3_TUSD_SECRET_KEY:-}" ]; then
  cat >/tmp/tusd-policy.json <<JSON
{
  "Version": "2012-10-17",
  "Statement": [
    {"Effect": "Allow", "Action": ["s3:ListBucket", "s3:ListBucketMultipartUploads", "s3:GetBucketLocation"],
     "Resource": ["arn:aws:s3:::$S3_BUCKET_UPLOADS"]},
    {"Effect": "Allow", "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:AbortMultipartUpload",
                                   "s3:ListMultipartUploadParts"],
     "Resource": ["arn:aws:s3:::$S3_BUCKET_UPLOADS/${TUSD_OBJECT_PREFIX}*"]}
  ]
}
JSON
  mkuser tusd "$S3_TUSD_ACCESS_KEY" "$S3_TUSD_SECRET_KEY" /tmp/tusd-policy.json
  echo "tusd user ready (read+write ${S3_BUCKET_UPLOADS}/${TUSD_OBJECT_PREFIX}*)"
fi
# الخادم: يقرأ أصول الرفع (التحقق والروابط الموقّعة) ومشتقات حاوية الوسائط، ويحذف كائنات tus لجلسة ملغاة أو منتهية ويلغي
# رفعها المتعدد. لا يكتب ولا يدير؛ والسرد لأن رد 403 على كائن غائب يعدّه الخادم خطأ تهيئة.
if [ -n "${S3_API_ACCESS_KEY:-}" ] && [ -n "${S3_API_SECRET_KEY:-}" ]; then
  cat >/tmp/api-policy.json <<JSON
{
  "Version": "2012-10-17",
  "Statement": [
    {"Effect": "Allow", "Action": ["s3:ListBucket", "s3:GetBucketLocation"],
     "Resource": ["arn:aws:s3:::$S3_BUCKET_UPLOADS", "arn:aws:s3:::$S3_BUCKET_MEDIA"]},
    {"Effect": "Allow", "Action": ["s3:ListBucketMultipartUploads"], "Resource": ["arn:aws:s3:::$S3_BUCKET_UPLOADS"]},
    {"Effect": "Allow", "Action": ["s3:GetObject", "s3:DeleteObject", "s3:AbortMultipartUpload"],
     "Resource": ["arn:aws:s3:::$S3_BUCKET_UPLOADS/${TUSD_OBJECT_PREFIX}*"]},
    {"Effect": "Allow", "Action": ["s3:GetObject"], "Resource": ["arn:aws:s3:::$S3_BUCKET_MEDIA/*"]}
  ]
}
JSON
  mkuser api "$S3_API_ACCESS_KEY" "$S3_API_SECRET_KEY" /tmp/api-policy.json
  echo "api user ready (read ${S3_BUCKET_UPLOADS}/${TUSD_OBJECT_PREFIX}* and ${S3_BUCKET_MEDIA}/*, delete tus objects)"
fi
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
# مستخدم عامل التفريغ (ADR 0019، 0020): قراءة نسخة المعاينة 480p ونسخة الصوت audio-16k.m4a (الملاحظة الصوتية)، وقراءة ملفي التفريغ وكتابتهما (العامل يعيد استعمال
# مسودة رُفعت قبل انقطاعه بدل تفريغ جديد)، في derived/ بحاوية
# الوسائط. لا يرى الأصل ولا حاوية الرفع، ولا يحذف ولا يسرد.
if [ -n "${S3_AI_ACCESS_KEY:-}" ] && [ -n "${S3_AI_SECRET_KEY:-}" ]; then
  policy=/tmp/ai-worker-policy.json
  cat >"$policy" <<JSON
{
  "Version": "2012-10-17",
  "Statement": [
    {"Effect": "Allow", "Action": ["s3:GetObject"],
     "Resource": ["arn:aws:s3:::$S3_BUCKET_MEDIA/derived/*/*/proxy-480p.mp4", "arn:aws:s3:::$S3_BUCKET_MEDIA/derived/*/*/audio-16k.m4a"]},
    {"Effect": "Allow", "Action": ["s3:GetObject", "s3:PutObject", "s3:AbortMultipartUpload", "s3:ListMultipartUploadParts"],
     "Resource": ["arn:aws:s3:::$S3_BUCKET_MEDIA/derived/*/*/transcript.json", "arn:aws:s3:::$S3_BUCKET_MEDIA/derived/*/*/transcript.vtt",
                  "arn:aws:s3:::$S3_BUCKET_MEDIA/derived/*/*/shots.json", "arn:aws:s3:::$S3_BUCKET_MEDIA/derived/*/*/shot_list.json"]}
  ]
}
JSON
  mc admin user add local "$S3_AI_ACCESS_KEY" "$S3_AI_SECRET_KEY" >/dev/null
  mc admin policy create local ai-worker "$policy" >/dev/null 2>&1 || mc admin policy update local ai-worker "$policy" >/dev/null 2>&1 || true
  mc admin policy attach local ai-worker --user "$S3_AI_ACCESS_KEY" >/dev/null 2>&1 || true
  echo "ai worker user ready (read ${S3_BUCKET_MEDIA}/derived/*/*/{proxy-480p.mp4,audio-16k.m4a}, read+write derived/*/*/{transcript.json,transcript.vtt,shots.json,shot_list.json})"
fi
# مستخدم النسخ الاحتياطي (ADR 0013): سرد وقراءة على الحاويتين، بلا كتابة ولا حذف.
if [ -n "${S3_BACKUP_ACCESS_KEY:-}" ] && [ -n "${S3_BACKUP_SECRET_KEY:-}" ]; then
  policy=/tmp/backup-policy.json
  cat >"$policy" <<JSON
{
  "Version": "2012-10-17",
  "Statement": [
    {"Effect": "Allow", "Action": ["s3:ListBucket", "s3:GetBucketLocation"],
     "Resource": ["arn:aws:s3:::$S3_BUCKET_UPLOADS", "arn:aws:s3:::$S3_BUCKET_MEDIA"]},
    {"Effect": "Allow", "Action": ["s3:GetObject"],
     "Resource": ["arn:aws:s3:::$S3_BUCKET_UPLOADS/*", "arn:aws:s3:::$S3_BUCKET_MEDIA/*"]}
  ]
}
JSON
  mc admin user add local "$S3_BACKUP_ACCESS_KEY" "$S3_BACKUP_SECRET_KEY" >/dev/null
  mc admin policy create local backup-read "$policy" >/dev/null 2>&1 || mc admin policy update local backup-read "$policy" >/dev/null 2>&1 || true
  mc admin policy attach local backup-read --user "$S3_BACKUP_ACCESS_KEY" >/dev/null 2>&1 || true
  echo "backup user ready (read-only on ${S3_BUCKET_UPLOADS} and ${S3_BUCKET_MEDIA})"
fi
echo buckets ready
