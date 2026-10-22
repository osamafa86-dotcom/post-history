-- Up Migration
-- متابعة جودة #237: وقت تأكيد حذف بقايا الرفع الملغى أو المنتهي من التخزين المؤقت. تعيد مكنسة التسوية محاولة الحذف
-- لجلسات failed التي لم يُؤكَّد حذفها بعد، والفهرس الجزئي يحصر مسحها فيها وحدها.
ALTER TABLE upload_sessions ADD COLUMN storage_removed_at timestamptz;
CREATE INDEX upload_sessions_storage_pending_idx ON upload_sessions (updated_at)
  WHERE state = 'failed' AND storage_removed_at IS NULL;

-- Down Migration
DROP INDEX upload_sessions_storage_pending_idx;
ALTER TABLE upload_sessions DROP COLUMN storage_removed_at;
