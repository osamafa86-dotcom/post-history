-- Up Migration
-- عقد v0.1 بعد التجميد (ADR 0010):
-- 1) materials.row_version: يرتفع مع كل كتابة على المادة (ETag/If-Match، 412)؛ بخلاف version الذي يرتفع بعد الاعتماد.
-- 2) upload_sessions.upload_token_expires_at: انتهاء رمز الرفع مستقلًا عن انتهاء الجلسة؛ NULL = الرمز مُبطَل.
-- 3) إعادة التعيين الإلزامية بعد الاستعادة: users.credential_reset_required وسر TOTP المعلّق،
--    ورمز إعادة التعيين المُجزَّأ على recovery_requests.
-- 4) notifications.recovery_request_id لإشعارات auth.recovery_*.

ALTER TABLE materials ADD COLUMN row_version bigint NOT NULL DEFAULT 1;
ALTER TABLE materials ADD CONSTRAINT materials_row_version_positive CHECK (row_version >= 1);

CREATE FUNCTION materials_bump_row_version() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.row_version := OLD.row_version + 1;
  RETURN NEW;
END $$;

CREATE TRIGGER materials_bump_row_version BEFORE UPDATE ON materials
  FOR EACH ROW EXECUTE FUNCTION materials_bump_row_version();

ALTER TABLE upload_sessions ADD COLUMN upload_token_expires_at timestamptz;
-- الجلسات القائمة: الرمز كان ينتهي مع الجلسة
UPDATE upload_sessions SET upload_token_expires_at = expires_at WHERE upload_token_hash IS NOT NULL;
ALTER TABLE upload_sessions
  ADD CONSTRAINT upload_sessions_token_expiry_within_session
    CHECK (upload_token_expires_at IS NULL OR upload_token_expires_at <= expires_at);

ALTER TABLE users
  ADD COLUMN credential_reset_required boolean NOT NULL DEFAULT false,
  ADD COLUMN totp_pending_secret_enc   bytea;   -- سر TOTP الجديد حتى تأكيده؛ مشفر على مستوى الحقل
ALTER TABLE users
  ADD CONSTRAINT users_totp_pending_only_during_reset
    CHECK (totp_pending_secret_enc IS NULL OR credential_reset_required);

ALTER TABLE recovery_requests
  ADD COLUMN reset_token_hash       bytea,         -- sha256 لرمز إعادة التعيين؛ الرمز لا يُخزَّن
  ADD COLUMN reset_token_expires_at timestamptz,
  ADD COLUMN completed_at           timestamptz;   -- استهلاك الرمز (مرة واحدة)
ALTER TABLE recovery_requests
  ADD CONSTRAINT recovery_requests_reset_token_hash_len CHECK (reset_token_hash IS NULL OR octet_length(reset_token_hash) = 32),
  ADD CONSTRAINT recovery_requests_reset_token_consistent CHECK ((reset_token_hash IS NULL) = (reset_token_expires_at IS NULL)),
  ADD CONSTRAINT recovery_requests_reset_only_when_approved CHECK (reset_token_hash IS NULL OR state = 'approved'),
  ADD CONSTRAINT recovery_requests_completed_needs_token CHECK (completed_at IS NULL OR reset_token_hash IS NOT NULL);
CREATE UNIQUE INDEX recovery_requests_reset_token_key ON recovery_requests (reset_token_hash) WHERE reset_token_hash IS NOT NULL;

ALTER TABLE notifications ADD COLUMN recovery_request_id uuid REFERENCES recovery_requests (id) ON DELETE SET NULL;

-- Down Migration
ALTER TABLE notifications DROP COLUMN recovery_request_id;
DROP INDEX recovery_requests_reset_token_key;
ALTER TABLE recovery_requests
  DROP CONSTRAINT recovery_requests_completed_needs_token,
  DROP CONSTRAINT recovery_requests_reset_only_when_approved,
  DROP CONSTRAINT recovery_requests_reset_token_consistent,
  DROP CONSTRAINT recovery_requests_reset_token_hash_len,
  DROP COLUMN completed_at,
  DROP COLUMN reset_token_expires_at,
  DROP COLUMN reset_token_hash;
ALTER TABLE users
  DROP CONSTRAINT users_totp_pending_only_during_reset,
  DROP COLUMN totp_pending_secret_enc,
  DROP COLUMN credential_reset_required;
ALTER TABLE upload_sessions
  DROP CONSTRAINT upload_sessions_token_expiry_within_session,
  DROP COLUMN upload_token_expires_at;
DROP TRIGGER materials_bump_row_version ON materials;
DROP FUNCTION materials_bump_row_version();
ALTER TABLE materials DROP CONSTRAINT materials_row_version_positive, DROP COLUMN row_version;
