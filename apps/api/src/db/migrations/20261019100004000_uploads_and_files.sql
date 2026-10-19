-- Up Migration
-- ملفات المادة (الأصل لا يُمس؛ كل معالجة ملف جديد) وجلسات الرفع، ورقم إيصال الاستلام عند مطابقة بصمة الأصل.

CREATE TABLE material_files (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  material_id       uuid NOT NULL REFERENCES materials (id) ON DELETE CASCADE,
  kind              text NOT NULL,
  state             text NOT NULL DEFAULT 'uploading',
  upload_session_id uuid,                                  -- يُربط بعد إنشاء جدول الجلسات (أدناه)
  derived_from_id   uuid REFERENCES material_files (id),   -- المشتق يشير إلى مصدره؛ NULL للأصل والنسخة الخفيفة من الهاتف
  storage_key       text,
  size_bytes        bigint,
  sha256            bytea,                                 -- تُحسب على الخادم بعد التجميع
  mime_type         text,
  duration_ms       bigint,
  start_pts_us      bigint,                                -- نقطة البداية الزمنية للأصل؛ تحفظها النسخة الخفيفة
  width             integer,
  height            integer,
  proxy_mode        text,
  receipt_number    text,
  verified_at       timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT material_files_kind_check CHECK (kind IN ('original', 'proxy', 'hls', 'audio', 'thumbnail', 'voice_note')),
  CONSTRAINT material_files_state_check CHECK (state IN ('uploading', 'received', 'verified', 'failed')),
  CONSTRAINT material_files_sha256_len CHECK (sha256 IS NULL OR octet_length(sha256) = 32),
  CONSTRAINT material_files_size_nonneg CHECK (size_bytes IS NULL OR size_bytes >= 0),
  CONSTRAINT material_files_dims_positive CHECK ((width IS NULL OR width > 0) AND (height IS NULL OR height > 0)),
  CONSTRAINT material_files_proxy_mode_check CHECK (proxy_mode IS NULL OR proxy_mode IN ('urgent', 'normal')),
  CONSTRAINT material_files_proxy_mode_only_proxy CHECK (proxy_mode IS NULL OR kind = 'proxy'),
  CONSTRAINT material_files_receipt_format CHECK (receipt_number IS NULL OR receipt_number ~ '^R-[0-9]{6}-[0-9]{6}$'),
  CONSTRAINT material_files_receipt_only_original CHECK (receipt_number IS NULL OR kind = 'original'),
  CONSTRAINT material_files_verified_consistent CHECK ((state = 'verified') = (verified_at IS NOT NULL)),
  CONSTRAINT material_files_verified_has_sha CHECK (state <> 'verified' OR sha256 IS NOT NULL)
);
CREATE UNIQUE INDEX material_files_receipt_number_key ON material_files (receipt_number) WHERE receipt_number IS NOT NULL;
CREATE INDEX material_files_material_kind_idx ON material_files (material_id, kind);
-- للبحث عن المكرر بالبصمة الكاملة؛ التطابق يوفر مساحة فقط ولا يمنح حق وصول، لذا ليس فريدًا
CREATE INDEX material_files_sha256_idx ON material_files (sha256) WHERE sha256 IS NOT NULL;
CREATE TRIGGER material_files_set_updated_at BEFORE UPDATE ON material_files
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- رقم إيصال الاستلام: R-YYYYMM-NNNNNN من تسلسل عام؛ يُسند مرة واحدة عند تحقق الأصل ولا يتغير.
CREATE SEQUENCE receipt_number_seq AS bigint START 1 MAXVALUE 999999 NO CYCLE;

CREATE FUNCTION next_receipt_number() RETURNS text
LANGUAGE sql VOLATILE AS $$
  SELECT 'R-' || to_char(now() AT TIME ZONE 'UTC', 'YYYYMM') || '-' || lpad(nextval('receipt_number_seq')::text, 6, '0')
$$;

CREATE FUNCTION material_files_assign_receipt() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.kind = 'original' AND NEW.state = 'verified' AND NEW.receipt_number IS NULL THEN
    NEW.receipt_number := next_receipt_number();
  END IF;
  IF OLD.receipt_number IS NOT NULL AND NEW.receipt_number IS DISTINCT FROM OLD.receipt_number THEN
    RAISE EXCEPTION 'receipt_number is immutable once assigned (file %)', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'material_files_receipt_immutable';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER material_files_assign_receipt BEFORE UPDATE ON material_files
  FOR EACH ROW EXECUTE FUNCTION material_files_assign_receipt();

-- جلسة رفع لكل ملف يخص مادة. حجم الجزء يُثبَّت عند البدء ولا يتغير (R2 يشترط تساوي الأجزاء).
CREATE TABLE upload_sessions (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  material_id          uuid NOT NULL REFERENCES materials (id) ON DELETE CASCADE,
  created_by           uuid NOT NULL REFERENCES users (id),
  kind                 text NOT NULL,
  state                text NOT NULL DEFAULT 'created',
  size_bytes           bigint NOT NULL,
  filename             text NOT NULL,
  mime_type            text,
  proxy_mode           text,
  part_size_bytes      integer NOT NULL,
  upload_path          text NOT NULL DEFAULT 'tusd',          -- بند القرارات 3؛ يُثبَّت بعد النموذج الأولي
  tus_upload_id        text,
  storage_key          text,
  bytes_received       bigint NOT NULL DEFAULT 0,
  client_sha256        bytea,                                  -- بصمة اختيارية يحسبها التطبيق
  client_fingerprint   jsonb,                                  -- بصمة رخيصة لترشيح المكررات فقط
  upload_token_hash    bytea,                                  -- sha256 لرمز الرفع قصير العمر
  expires_at           timestamptz NOT NULL,
  file_id              uuid REFERENCES material_files (id),
  duplicate_of_file_id uuid REFERENCES material_files (id),
  failure_reason       text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT upload_sessions_kind_check CHECK (kind IN ('original', 'proxy', 'voice_note')),
  CONSTRAINT upload_sessions_state_check CHECK (state IN ('created', 'in_progress', 'completed', 'verified', 'failed', 'deduplicated')),
  CONSTRAINT upload_sessions_size_positive CHECK (size_bytes > 0),
  CONSTRAINT upload_sessions_filename_len CHECK (char_length(filename) BETWEEN 1 AND 255),
  CONSTRAINT upload_sessions_proxy_mode_check CHECK (proxy_mode IS NULL OR proxy_mode IN ('urgent', 'normal')),
  CONSTRAINT upload_sessions_proxy_mode_only_proxy CHECK (proxy_mode IS NULL OR kind = 'proxy'),
  CONSTRAINT upload_sessions_part_size_min CHECK (part_size_bytes >= 1048576),
  CONSTRAINT upload_sessions_upload_path_check CHECK (upload_path IN ('tusd', 'direct', 'ietf')),
  CONSTRAINT upload_sessions_bytes_received_range CHECK (bytes_received >= 0 AND bytes_received <= size_bytes),
  CONSTRAINT upload_sessions_client_sha256_len CHECK (client_sha256 IS NULL OR octet_length(client_sha256) = 32),
  CONSTRAINT upload_sessions_fingerprint_is_object CHECK (client_fingerprint IS NULL OR jsonb_typeof(client_fingerprint) = 'object'),
  CONSTRAINT upload_sessions_failure_reason_check CHECK (failure_reason IS NULL OR failure_reason IN (
    'checksum_mismatch', 'invalid_file', 'expired', 'aborted', 'storage_error')),
  CONSTRAINT upload_sessions_failed_has_reason CHECK ((state = 'failed') = (failure_reason IS NOT NULL)),
  CONSTRAINT upload_sessions_dedup_has_target CHECK ((state = 'deduplicated') = (duplicate_of_file_id IS NOT NULL))
);
CREATE UNIQUE INDEX upload_sessions_tus_upload_id_key ON upload_sessions (tus_upload_id) WHERE tus_upload_id IS NOT NULL;
CREATE INDEX upload_sessions_material_idx ON upload_sessions (material_id, created_at DESC);
-- الرفع الجاري (لوحة «الوارد الآن» وكنس الجلسات المنتهية)
CREATE INDEX upload_sessions_inflight_idx ON upload_sessions (state, updated_at) WHERE state IN ('created', 'in_progress');
CREATE INDEX upload_sessions_expiry_idx ON upload_sessions (expires_at) WHERE state IN ('created', 'in_progress');
CREATE TRIGGER upload_sessions_set_updated_at BEFORE UPDATE ON upload_sessions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE material_files
  ADD CONSTRAINT material_files_upload_session_fk FOREIGN KEY (upload_session_id) REFERENCES upload_sessions (id);

-- Down Migration
ALTER TABLE material_files DROP CONSTRAINT material_files_upload_session_fk;
DROP TABLE upload_sessions;
DROP TRIGGER material_files_assign_receipt ON material_files;
DROP FUNCTION material_files_assign_receipt();
DROP FUNCTION next_receipt_number();
DROP SEQUENCE receipt_number_seq;
DROP TABLE material_files;
