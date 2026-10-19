-- Up Migration
-- حجز خطّاف pre-create (موافقة المنسّق في التذكرة 6): tusd لا يرفض المعرّف المكرّر، فإنشاءان بمعرّف الجلسة نفسه
-- ينجحان معًا ويتشاركان الكائن. الخادم يحجز الجلسة ذريًا عند قبول pre-create ويرفض غيره ما دام الحجز حيًّا،
-- ويُفرج عنه post-create (أو انتهاء المهلة فيُعاد الإنشاء الفاشل). الحجز لا معنى له إلا والجلسة created.

ALTER TABLE upload_sessions ADD COLUMN hook_reserved_until timestamptz;
ALTER TABLE upload_sessions ADD CONSTRAINT upload_sessions_hook_reserved_created_only
  CHECK (hook_reserved_until IS NULL OR state = 'created');

-- Down Migration
ALTER TABLE upload_sessions DROP CONSTRAINT upload_sessions_hook_reserved_created_only;
ALTER TABLE upload_sessions DROP COLUMN hook_reserved_until;
