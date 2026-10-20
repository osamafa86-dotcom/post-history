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
  scope_kind              text NOT NULL DEFAULT 'all',    -- كنطاق الأدوار: مكتب أو محافظة المادة
  scope_id                text NOT NULL DEFAULT '',
  recipient_roles         text[] NOT NULL DEFAULT '{}',   -- الأدوار المقيّدة بنطاق تُحصر في نطاق المادة
  recipient_permissions   text[] NOT NULL DEFAULT '{}',
  channels                text[] NOT NULL,
  delay_seconds           integer NOT NULL DEFAULT 0,
  quiet_hours_start       time,                           -- لا تنطبق على العاجل
  quiet_hours_end         time,
  quiet_hours_tz          text,
  digest_interval_minutes integer,                        -- NULL = فوري
  assignment              boolean NOT NULL DEFAULT false, -- مهمة: «أُسند» ثم «أقرّ الاستلام»، وعليها يجري التصعيد
  enabled                 boolean NOT NULL DEFAULT true,
  row_version             integer NOT NULL DEFAULT 1,
  created_by              uuid REFERENCES users (id),
  updated_by              uuid REFERENCES users (id),
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
  CONSTRAINT notification_rules_scope_kind_check CHECK (scope_kind IN ('all', 'office', 'governorate')),
  CONSTRAINT notification_rules_scope_id_check CHECK ((scope_kind = 'all') = (scope_id = '')),
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
CREATE INDEX notification_rules_event_idx ON notification_rules (event_type, enabled);
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

-- 7) transcript (application/json) وcaptions (text/vtt) من عامل التفريغ، مشتقان زمنيان كالنسخة الخفيفة.
-- 6) حزمة التصدير عند الطلب لا عند الاستيعاب (#99): نوع مشتق export، وطلب لكل أصل، وحدث export.requested.
--    الحزمة لا تحمل بيانات كاشفة أبدًا مهما كانت صلاحيات الطالب (CLAUDE.md §5: «لا بيانات كاشفة في أي تصدير»).
ALTER TABLE material_files DROP CONSTRAINT material_files_kind_check;
ALTER TABLE material_files ADD CONSTRAINT material_files_kind_check
  CHECK (kind IN ('original', 'proxy', 'hls', 'audio', 'thumbnail', 'voice_note', 'export', 'transcript', 'captions'));

CREATE TABLE material_exports (
  source_file_id uuid PRIMARY KEY REFERENCES material_files (id) ON DELETE CASCADE,
  material_id    uuid NOT NULL REFERENCES materials (id) ON DELETE CASCADE,
  requested_by   uuid NOT NULL REFERENCES users (id),
  state          text NOT NULL DEFAULT 'requested',
  file_id        uuid REFERENCES material_files (id) ON DELETE SET NULL,
  failure_reason text,
  requested_at   timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT material_exports_state_check CHECK (state IN ('requested', 'ready', 'failed')),
  CONSTRAINT material_exports_ready_has_file CHECK ((state = 'ready') = (file_id IS NOT NULL)),
  CONSTRAINT material_exports_failure_reason_check CHECK (
    (state = 'failed') = (failure_reason IS NOT NULL) AND (failure_reason IS NULL OR failure_reason IN ('source_unavailable', 'build_failed')))
);
CREATE INDEX material_exports_material_idx ON material_exports (material_id);
CREATE TRIGGER material_exports_set_updated_at BEFORE UPDATE ON material_exports
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE outbox_events DROP CONSTRAINT outbox_events_type_check;
ALTER TABLE outbox_events ADD CONSTRAINT outbox_events_type_check CHECK (type IN (
    'material.created', 'material.urgent_received', 'material.updated', 'material.version_created',
    'material.technical_transition', 'material.editorial_transition', 'material.rights_transition',
    'material.acknowledged', 'material.change_requested', 'material.accepted_for_production',
    'material.reserved', 'material.released', 'material.contributors_set', 'material.published',
    'upload.started', 'upload.proxy_received', 'upload.original_received', 'upload.verified',
    'upload.deduplicated', 'upload.failed',
    'form.published', 'ai.draft_ready', 'notification.escalated',
    'auth.recovery_requested', 'auth.recovery_approved', 'user.status_changed', 'auth.recovery_completed',
    'export.requested'));

CREATE OR REPLACE FUNCTION outbox_payload_allowed_keys(event_type text) RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE
    WHEN event_type IN ('material.created', 'material.urgent_received', 'material.updated', 'material.version_created',
                        'material.acknowledged', 'material.change_requested', 'material.accepted_for_production',
                        'material.reserved', 'material.released', 'material.contributors_set', 'material.published')
      THEN ARRAY['material_id', 'priority', 'office_id', 'material_version', 'editorial_state', 'technical_state',
                 'rights_state', 'reserved_by', 'note_timecode_ms']
    WHEN event_type IN ('material.technical_transition', 'material.editorial_transition', 'material.rights_transition')
      THEN ARRAY['material_id', 'priority', 'office_id', 'track', 'from', 'to', 'note_timecode_ms']
    WHEN event_type IN ('upload.started', 'upload.proxy_received', 'upload.original_received', 'upload.verified',
                        'upload.deduplicated', 'upload.failed')
      THEN ARRAY['material_id', 'upload_session_id', 'file_id', 'kind', 'priority', 'receipt_number', 'failure_reason',
                 'duplicate_of_file_id']
    WHEN event_type = 'form.published'          THEN ARRAY['version']
    WHEN event_type = 'ai.draft_ready'          THEN ARRAY['material_id', 'job_id', 'route']
    WHEN event_type = 'notification.escalated'  THEN ARRAY['notification_id', 'material_id', 'priority', 'escalation_level', 'escalated_to']
    WHEN event_type IN ('auth.recovery_requested', 'auth.recovery_approved') THEN ARRAY['recovery_request_id', 'office_id']
    WHEN event_type = 'user.status_changed'     THEN ARRAY['user_id', 'status', 'reason_code', 'actor_id', 'occurred_at']
    WHEN event_type = 'auth.recovery_completed' THEN ARRAY['recovery_request_id', 'office_id']
    WHEN event_type = 'export.requested'        THEN ARRAY['material_id', 'source_file_id', 'requested_by']
    ELSE ARRAY[]::text[]
  END
$$;

-- Down Migration
CREATE OR REPLACE FUNCTION outbox_payload_allowed_keys(event_type text) RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE
    WHEN event_type IN ('material.created', 'material.urgent_received', 'material.updated', 'material.version_created',
                        'material.acknowledged', 'material.change_requested', 'material.accepted_for_production',
                        'material.reserved', 'material.released', 'material.contributors_set', 'material.published')
      THEN ARRAY['material_id', 'priority', 'office_id', 'material_version', 'editorial_state', 'technical_state',
                 'rights_state', 'reserved_by', 'note_timecode_ms']
    WHEN event_type IN ('material.technical_transition', 'material.editorial_transition', 'material.rights_transition')
      THEN ARRAY['material_id', 'priority', 'office_id', 'track', 'from', 'to', 'note_timecode_ms']
    WHEN event_type IN ('upload.started', 'upload.proxy_received', 'upload.original_received', 'upload.verified',
                        'upload.deduplicated', 'upload.failed')
      THEN ARRAY['material_id', 'upload_session_id', 'file_id', 'kind', 'priority', 'receipt_number', 'failure_reason',
                 'duplicate_of_file_id']
    WHEN event_type = 'form.published'          THEN ARRAY['version']
    WHEN event_type = 'ai.draft_ready'          THEN ARRAY['material_id', 'job_id', 'route']
    WHEN event_type = 'notification.escalated'  THEN ARRAY['notification_id', 'material_id', 'priority', 'escalation_level', 'escalated_to']
    WHEN event_type IN ('auth.recovery_requested', 'auth.recovery_approved') THEN ARRAY['recovery_request_id', 'office_id']
    WHEN event_type = 'user.status_changed'     THEN ARRAY['user_id', 'status', 'reason_code', 'actor_id', 'occurred_at']
    WHEN event_type = 'auth.recovery_completed' THEN ARRAY['recovery_request_id', 'office_id']
    ELSE ARRAY[]::text[]
  END
$$;

ALTER TABLE outbox_events DROP CONSTRAINT outbox_events_type_check;
ALTER TABLE outbox_events ADD CONSTRAINT outbox_events_type_check CHECK (type IN (
    'material.created', 'material.urgent_received', 'material.updated', 'material.version_created',
    'material.technical_transition', 'material.editorial_transition', 'material.rights_transition',
    'material.acknowledged', 'material.change_requested', 'material.accepted_for_production',
    'material.reserved', 'material.released', 'material.contributors_set', 'material.published',
    'upload.started', 'upload.proxy_received', 'upload.original_received', 'upload.verified',
    'upload.deduplicated', 'upload.failed',
    'form.published', 'ai.draft_ready', 'notification.escalated',
    'auth.recovery_requested', 'auth.recovery_approved', 'user.status_changed', 'auth.recovery_completed'));

DROP TABLE material_exports;
ALTER TABLE material_files DROP CONSTRAINT material_files_kind_check;
ALTER TABLE material_files ADD CONSTRAINT material_files_kind_check
  CHECK (kind IN ('original', 'proxy', 'hls', 'audio', 'thumbnail', 'voice_note'));
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
