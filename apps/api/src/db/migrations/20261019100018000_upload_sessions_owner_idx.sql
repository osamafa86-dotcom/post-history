-- Up Migration
-- GET /uploads: جلسات المستخدم نفسه، الأحدث أولًا بالمؤشر (#151 البند 2).
CREATE INDEX upload_sessions_owner_idx ON upload_sessions (created_by, created_at DESC, id DESC);

-- Down Migration
DROP INDEX upload_sessions_owner_idx;
