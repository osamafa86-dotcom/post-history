-- Up Migration
-- عقد v0.2 (ADR 0018)، إضافي كله:
-- 1) البصمة الإدراكية للفيديو بجوار البصمة الرخيصة (#93): مصفوفة 64-بت لكل إطار مأخوذ، حتى 32 عنصرًا. ترشيح لا حق.
-- 2) «اطّلعت» ضمن المادة: من نقل المادة إلى acknowledged ومتى، فيرى المراسل أن مادته شوهدت.
-- 3) فهرسا ترتيب لـ sort على GET /materials (ADR 0002: فهرس لكل ترتيب معلَن، لا غير).
-- 4) قواعد التنبيه التي تضبطها الإدارة وسلسلة تصعيدها، وربط الإشعار بالقاعدة التي ولّدته.
-- 5) الاسم الحقيقي للمستخدم مشفّرًا على مستوى الحقل (FieldKeyring، كـ totp_secret_enc)؛ يُقرأ خلف protected_source:read
--    وتُسجَّل كل قراءة (SEC-03). لا يُفهرس ولا يدخل أي إشعار أو حدث أو تصدير.

ALTER TABLE users ADD COLUMN legal_name_enc bytea;

ALTER TABLE material_files
  ADD COLUMN perceptual_hash bigint[],
  ADD CONSTRAINT material_files_perceptual_hash_size CHECK (
    perceptual_hash IS NULL OR (cardinality(perceptual_hash) BETWEEN 1 AND 32 AND array_position(perceptual_hash, NULL) IS NULL)),
  ADD CONSTRAINT material_files_perceptual_hash_video_only CHECK (perceptual_hash IS NULL OR kind = 'original');

ALTER TABLE materials
  ADD COLUMN acknowledged_by uuid REFERENCES users (id),
  ADD COLUMN acknowledged_at timestamptz,
  ADD CONSTRAINT materials_acknowledged_consistent CHECK ((acknowledged_by IS NULL) = (acknowledged_at IS NULL));

CREATE INDEX materials_shot_cursor_idx ON materials (shot_at DESC, id DESC);
CREATE INDEX materials_updated_cursor_idx ON materials (updated_at DESC, id DESC);

CREATE TABLE notification_rules (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                    text NOT NULL,
  event_type              text NOT NULL,
  priorities              text[],                         -- NULL = كل الأولويات
  material_types          text[],                         -- NULL = كل الأنواع
  office_id               uuid REFERENCES offices (id),   -- NULL = كل المكاتب
  recipient_roles         text[] NOT NULL DEFAULT '{}',   -- الأدوار المقيّدة بنطاق تُحصر في نطاق المادة
  recipient_permissions   text[] NOT NULL DEFAULT '{}',
  channels                text[] NOT NULL,
  delay_seconds           integer NOT NULL DEFAULT 0,
  quiet_hours_start       time,                           -- لا تنطبق على العاجل
  quiet_hours_end         time,
  quiet_hours_tz          text,
  digest_interval_minutes integer,                        -- NULL = فوري
  enabled                 boolean NOT NULL DEFAULT true,
  row_version             integer NOT NULL DEFAULT 1,
  created_by              uuid REFERENCES users (id),
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT notification_rules_name_len CHECK (char_length(name) BETWEEN 1 AND 120),
  CONSTRAINT notification_rules_event_type_check CHECK (event_type IN (
    'material.created', 'material.urgent_received', 'material.updated', 'material.version_created',
    'material.technical_transition', 'material.editorial_transition', 'material.rights_transition',
    'material.acknowledged', 'material.change_requested', 'material.accepted_for_production',
    'material.reserved', 'material.released', 'material.contributors_set', 'material.published',
    'upload.started', 'upload.proxy_received', 'upload.original_received', 'upload.verified',
    'upload.deduplicated', 'upload.failed', 'ai.draft_ready')),
  CONSTRAINT notification_rules_priorities_check CHECK (
    priorities IS NULL OR (cardinality(priorities) >= 1 AND priorities <@ ARRAY['urgent', 'important', 'normal'])),
  CONSTRAINT notification_rules_material_types_check CHECK (
    material_types IS NULL OR (cardinality(material_types) >= 1 AND material_types <@ allowed_material_types())),
  CONSTRAINT notification_rules_roles_check CHECK (recipient_roles <@ ARRAY[
    'system_admin', 'editor_in_chief', 'supervisor', 'producer', 'finance', 'reporter', 'rights_officer']),
  CONSTRAINT notification_rules_permissions_check CHECK (
    recipient_permissions <@ ARRAY['sensitive_location:read', 'protected_source:read']),
  CONSTRAINT notification_rules_has_recipient CHECK (cardinality(recipient_roles) + cardinality(recipient_permissions) >= 1),
  CONSTRAINT notification_rules_channels_check CHECK (cardinality(channels) >= 1 AND channels <@ ARRAY[
    'in_app', 'websocket', 'apns', 'fcm', 'web_push', 'email', 'telegram', 'whatsapp', 'sms']),
  CONSTRAINT notification_rules_delay_range CHECK (delay_seconds BETWEEN 0 AND 86400),
  CONSTRAINT notification_rules_quiet_hours_consistent CHECK (
    (quiet_hours_start IS NULL) = (quiet_hours_end IS NULL) AND (quiet_hours_start IS NULL) = (quiet_hours_tz IS NULL)),
  CONSTRAINT notification_rules_digest_range CHECK (digest_interval_minutes IS NULL OR digest_interval_minutes BETWEEN 15 AND 1440),
  CONSTRAINT notification_rules_row_version_pos CHECK (row_version >= 1)
);
CREATE INDEX notification_rules_event_idx ON notification_rules (event_type) WHERE enabled;
CREATE TRIGGER notification_rules_set_updated_at BEFORE UPDATE ON notification_rules
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- سلسلة التصعيد: مستوى n يُرسل إن لم يُقرّ الاستلام بعد after_seconds من الإشعار الأول.
CREATE TABLE notification_rule_escalations (
  rule_id         uuid NOT NULL REFERENCES notification_rules (id) ON DELETE CASCADE,
  level           integer NOT NULL,
  after_seconds   integer NOT NULL,
  recipient_roles text[] NOT NULL,
  channels        text[] NOT NULL,
  PRIMARY KEY (rule_id, level),
  CONSTRAINT notification_rule_escalations_level_range CHECK (level BETWEEN 1 AND 5),
  CONSTRAINT notification_rule_escalations_after_range CHECK (after_seconds BETWEEN 60 AND 86400),
  CONSTRAINT notification_rule_escalations_roles_check CHECK (cardinality(recipient_roles) >= 1 AND recipient_roles <@ ARRAY[
    'system_admin', 'editor_in_chief', 'supervisor', 'producer', 'finance', 'reporter', 'rights_officer']),
  CONSTRAINT notification_rule_escalations_channels_check CHECK (cardinality(channels) >= 1 AND channels <@ ARRAY[
    'in_app', 'websocket', 'apns', 'fcm', 'web_push', 'email', 'telegram', 'whatsapp', 'sms'])
);

ALTER TABLE notifications ADD COLUMN rule_id uuid REFERENCES notification_rules (id) ON DELETE SET NULL;

CREATE OR REPLACE FUNCTION audit_details_allowed_keys() RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT ARRAY['permission', 'target_user_id', 'material_id', 'file_id', 'upload_session_id', 'field_keys', 'track',
               'from', 'to', 'recovery_request_id', 'session_id', 'installation_id', 'form_version', 'notification_id',
               'result', 'reason_code', 'role', 'scope_kind', 'scope_id', 'approved_by', 'rule_id']::text[]
$$;

-- Down Migration
CREATE OR REPLACE FUNCTION audit_details_allowed_keys() RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT ARRAY['permission', 'target_user_id', 'material_id', 'file_id', 'upload_session_id', 'field_keys', 'track',
               'from', 'to', 'recovery_request_id', 'session_id', 'installation_id', 'form_version', 'notification_id',
               'result', 'reason_code', 'role', 'scope_kind', 'scope_id', 'approved_by']::text[]
$$;

ALTER TABLE notifications DROP COLUMN rule_id;
DROP TABLE notification_rule_escalations;
DROP TABLE notification_rules;

DROP INDEX materials_updated_cursor_idx;
DROP INDEX materials_shot_cursor_idx;

ALTER TABLE materials
  DROP CONSTRAINT materials_acknowledged_consistent,
  DROP COLUMN acknowledged_at,
  DROP COLUMN acknowledged_by;

ALTER TABLE users DROP COLUMN legal_name_enc;

ALTER TABLE material_files
  DROP CONSTRAINT material_files_perceptual_hash_video_only,
  DROP CONSTRAINT material_files_perceptual_hash_size,
  DROP COLUMN perceptual_hash;
