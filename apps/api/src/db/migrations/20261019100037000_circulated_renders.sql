-- Up Migration
-- نسخ قالب «مواد متداولة» (ADR 0091، قرار المالك 2026-11-02 «نعم نربطه بخط الإنتاج»): طلب يكتبه الطاقم لكل نسخة،
-- ومشتق circulated_render من الأصل المتحقق يكتبه عامل الوسائط، وثلاثة أحداث بمعرّفات فقط. الأصل لا يُمس، ولا تتغيّر
-- أيٌّ من الحالات الثلاث للمادة. فرادة الملف لكل نسخة في material_renders.file_id.
-- عدة نسخ للأصل الواحد مسموحة في العقد (نسخة لكل طلب)، لكن الفهرس material_files_derived_kind_key يبقى هنا كما هو: تسجيل
-- المشتق في الخادم (media.service) يستدل الفهرس الجزئي بشرطه الحرفي (اختبار الدخان)، فاستثناء النوع منه يغيّر الشرطين معًا
-- في طلب الخادم (ADR 0091، الطلب ب). لا كاتب لهذا النوع قبله، فلا أثر للفرق.
--
-- نص العنوان وسطر المكان يكتبان في الفيديو، فقاعدتهما قاعدة MaterialTag (ADR 0086) بالمجموعات نفسها من المحارف:
--   مسافات الطرفين (صنف \s في JSON Schema): U+0009–U+000D وU+0020 وU+00A0 وU+1680 وU+2000–U+200A وU+2028 وU+2029
--   وU+202F وU+205F وU+3000 وU+FEFF؛ التحكم: U+0001–U+001F وU+007F–U+009F؛ الاتجاه: U+061C وU+200E/U+200F
--   وU+202A–U+202E وU+2066–U+2069.
-- السطر 1–22 نقطة ترميز، والأسطر 1–3، والمكان ≤ 44 (مقيسة على إطارات VT بخط القالب؛ ADR 0091 «الدليل»)، والحدود
-- نفسها في RenderTitleLine وMaterialRender.location_text بـ openapi.yaml: تغيير إحداهما يوجب تغيير الأخرى في الطلب نفسه.
-- التهريبات \uXXXX من صيغة ARE لا محارف حرفية، ولا \s ولا [[:space:]] (تتبع LC_CTYPE)، ولا btrim (يقصّ U+0020 وحدها).
-- الدالتان مثبّتتان بـ search_path وتستدعي الثانية الأولى باسم مؤهَّل (#71)، فتعملان أثناء الاستعادة.
CREATE FUNCTION render_text_valid(t text, max_chars integer) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path = public, pg_temp
AS $$
  SELECT t IS NOT NULL
     AND char_length(t) BETWEEN 1 AND max_chars
     AND t !~ '^[\u0009-\u000d\u0020\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]|[\u0009-\u000d\u0020\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]$'
     AND t !~ '[\x01-\x1f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]'
$$;

CREATE FUNCTION render_title_lines_valid(lines text[]) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path = public, pg_temp
AS $$
  SELECT cardinality(lines) BETWEEN 1 AND 3
     AND array_ndims(lines) = 1
     AND NOT EXISTS (SELECT 1 FROM unnest(lines) AS l WHERE NOT public.render_text_valid(l, 22))
$$;

ALTER TABLE material_files DROP CONSTRAINT material_files_kind_check;
ALTER TABLE material_files ADD CONSTRAINT material_files_kind_check
  CHECK (kind IN ('original', 'proxy', 'hls', 'audio', 'thumbnail', 'voice_note', 'export', 'transcript', 'captions',
                  'watermarked_preview', 'shot_list', 'delivery', 'produced', 'circulated_render'));
-- النسخة مشتقة من الأصل دائمًا
ALTER TABLE material_files ADD CONSTRAINT material_files_circulated_render_derived_check
  CHECK (kind <> 'circulated_render' OR derived_from_id IS NOT NULL);

CREATE TABLE material_renders (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  material_id      uuid NOT NULL REFERENCES materials (id) ON DELETE CASCADE,
  material_version integer NOT NULL,
  source_file_id   uuid NOT NULL REFERENCES material_files (id) ON DELETE CASCADE,
  template         text NOT NULL,
  aspect           text NOT NULL,
  title_lines      text[] NOT NULL,
  location_text    text,
  label            text NOT NULL,
  state            text NOT NULL DEFAULT 'requested',
  file_id          uuid UNIQUE REFERENCES material_files (id) ON DELETE SET NULL,
  failure_reason   text,
  requested_by     uuid NOT NULL REFERENCES users (id),
  requested_at     timestamptz NOT NULL DEFAULT now(),
  completed_at     timestamptz,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT material_renders_material_version_check CHECK (material_version >= 1),
  CONSTRAINT material_renders_template_check CHECK (template IN ('circulated')),
  CONSTRAINT material_renders_aspect_check CHECK (aspect IN ('vertical', 'horizontal', 'square')),
  CONSTRAINT material_renders_label_check CHECK (label IN ('circulated_footage', 'none')),
  CONSTRAINT material_renders_title_lines_valid CHECK (public.render_title_lines_valid(title_lines)),
  CONSTRAINT material_renders_location_text_valid CHECK (location_text IS NULL OR public.render_text_valid(location_text, 44)),
  CONSTRAINT material_renders_state_check CHECK (state IN ('requested', 'ready', 'failed')),
  CONSTRAINT material_renders_ready_has_file CHECK ((state = 'ready') = (file_id IS NOT NULL)),
  CONSTRAINT material_renders_failure_reason_check CHECK (
    (state = 'failed') = (failure_reason IS NOT NULL)
    AND (failure_reason IS NULL OR failure_reason IN ('source_unavailable', 'title_overflow', 'render_failed'))),
  CONSTRAINT material_renders_completed_at_check CHECK ((state = 'requested') = (completed_at IS NULL))
);
CREATE INDEX material_renders_material_idx ON material_renders (material_id, requested_at DESC);
CREATE TRIGGER material_renders_set_updated_at BEFORE UPDATE ON material_renders
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE outbox_events DROP CONSTRAINT outbox_events_type_check;
ALTER TABLE outbox_events ADD CONSTRAINT outbox_events_type_check CHECK (type IN (
    'material.created', 'material.urgent_received', 'material.updated', 'material.version_created',
    'material.technical_transition', 'material.editorial_transition', 'material.rights_transition',
    'material.acknowledged', 'material.change_requested', 'material.accepted_for_production',
    'material.reserved', 'material.released', 'material.contributors_set', 'material.published',
    'upload.started', 'upload.progress', 'upload.proxy_received', 'upload.original_received', 'upload.verified',
    'upload.deduplicated', 'upload.failed',
    'form.published', 'ai.draft_ready', 'notification.escalated',
    'auth.recovery_requested', 'auth.recovery_approved', 'user.status_changed', 'auth.recovery_completed',
    'export.requested', 'setting.changed',
    'catalog.listing_changed', 'license.delivery_requested',
    'order.status_changed', 'license.issued', 'license.revoked',
    'payout.status_changed',
    'render.requested', 'render.completed', 'render.failed'));

-- حمولة أحداث النسخة معرّفات وحدها (ADR SEC-03): لا عنوان ولا مكان ولا اسم ملف ولا مفتاح تخزين
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
    WHEN event_type = 'upload.progress'
      THEN ARRAY['material_id', 'upload_session_id', 'kind', 'priority', 'bytes_received', 'size_bytes']
    WHEN event_type = 'form.published'          THEN ARRAY['version']
    WHEN event_type = 'ai.draft_ready'          THEN ARRAY['material_id', 'job_id', 'route']
    WHEN event_type = 'notification.escalated'  THEN ARRAY['notification_id', 'material_id', 'priority', 'escalation_level', 'escalated_to']
    WHEN event_type IN ('auth.recovery_requested', 'auth.recovery_approved') THEN ARRAY['recovery_request_id', 'office_id']
    WHEN event_type = 'user.status_changed'     THEN ARRAY['user_id', 'status', 'reason_code', 'actor_id', 'occurred_at']
    WHEN event_type = 'auth.recovery_completed' THEN ARRAY['recovery_request_id', 'office_id']
    WHEN event_type = 'export.requested'        THEN ARRAY['material_id', 'source_file_id', 'requested_by']
    WHEN event_type = 'setting.changed'         THEN ARRAY['setting', 'value', 'actor_id', 'reason_code', 'occurred_at']
    WHEN event_type = 'catalog.listing_changed' THEN ARRAY['listing_id', 'material_id', 'material_version', 'source_file_id', 'state', 'suspended_reason']
    WHEN event_type = 'license.delivery_requested' THEN ARRAY['license_id', 'material_id', 'source_file_id', 'deliverables', 'produced_file_id']
    WHEN event_type = 'order.status_changed'    THEN ARRAY['order_id', 'organization_id', 'status', 'cancel_reason']
    WHEN event_type = 'license.issued'          THEN ARRAY['license_id', 'order_id', 'organization_id', 'material_id', 'material_version', 'license_type']
    WHEN event_type = 'license.revoked'         THEN ARRAY['license_id', 'organization_id', 'material_id', 'revoked_reason']
    WHEN event_type = 'payout.status_changed'   THEN ARRAY['payout_request_id', 'user_id', 'state', 'reason_code']
    WHEN event_type = 'render.requested'        THEN ARRAY['material_id', 'render_id', 'source_file_id', 'requested_by']
    WHEN event_type = 'render.completed'        THEN ARRAY['material_id', 'render_id', 'file_id']
    WHEN event_type = 'render.failed'           THEN ARRAY['material_id', 'render_id', 'failure_reason']
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
    WHEN event_type = 'upload.progress'
      THEN ARRAY['material_id', 'upload_session_id', 'kind', 'priority', 'bytes_received', 'size_bytes']
    WHEN event_type = 'form.published'          THEN ARRAY['version']
    WHEN event_type = 'ai.draft_ready'          THEN ARRAY['material_id', 'job_id', 'route']
    WHEN event_type = 'notification.escalated'  THEN ARRAY['notification_id', 'material_id', 'priority', 'escalation_level', 'escalated_to']
    WHEN event_type IN ('auth.recovery_requested', 'auth.recovery_approved') THEN ARRAY['recovery_request_id', 'office_id']
    WHEN event_type = 'user.status_changed'     THEN ARRAY['user_id', 'status', 'reason_code', 'actor_id', 'occurred_at']
    WHEN event_type = 'auth.recovery_completed' THEN ARRAY['recovery_request_id', 'office_id']
    WHEN event_type = 'export.requested'        THEN ARRAY['material_id', 'source_file_id', 'requested_by']
    WHEN event_type = 'setting.changed'         THEN ARRAY['setting', 'value', 'actor_id', 'reason_code', 'occurred_at']
    WHEN event_type = 'catalog.listing_changed' THEN ARRAY['listing_id', 'material_id', 'material_version', 'source_file_id', 'state', 'suspended_reason']
    WHEN event_type = 'license.delivery_requested' THEN ARRAY['license_id', 'material_id', 'source_file_id', 'deliverables', 'produced_file_id']
    WHEN event_type = 'order.status_changed'    THEN ARRAY['order_id', 'organization_id', 'status', 'cancel_reason']
    WHEN event_type = 'license.issued'          THEN ARRAY['license_id', 'order_id', 'organization_id', 'material_id', 'material_version', 'license_type']
    WHEN event_type = 'license.revoked'         THEN ARRAY['license_id', 'organization_id', 'material_id', 'revoked_reason']
    WHEN event_type = 'payout.status_changed'   THEN ARRAY['payout_request_id', 'user_id', 'state', 'reason_code']
    ELSE ARRAY[]::text[]
  END
$$;

DELETE FROM outbox_events WHERE type IN ('render.requested', 'render.completed', 'render.failed');
ALTER TABLE outbox_events DROP CONSTRAINT outbox_events_type_check;
ALTER TABLE outbox_events ADD CONSTRAINT outbox_events_type_check CHECK (type IN (
    'material.created', 'material.urgent_received', 'material.updated', 'material.version_created',
    'material.technical_transition', 'material.editorial_transition', 'material.rights_transition',
    'material.acknowledged', 'material.change_requested', 'material.accepted_for_production',
    'material.reserved', 'material.released', 'material.contributors_set', 'material.published',
    'upload.started', 'upload.progress', 'upload.proxy_received', 'upload.original_received', 'upload.verified',
    'upload.deduplicated', 'upload.failed',
    'form.published', 'ai.draft_ready', 'notification.escalated',
    'auth.recovery_requested', 'auth.recovery_approved', 'user.status_changed', 'auth.recovery_completed',
    'export.requested', 'setting.changed',
    'catalog.listing_changed', 'license.delivery_requested',
    'order.status_changed', 'license.issued', 'license.revoked',
    'payout.status_changed'));

DROP TABLE material_renders;
DELETE FROM material_files WHERE kind = 'circulated_render';
ALTER TABLE material_files DROP CONSTRAINT material_files_circulated_render_derived_check;
ALTER TABLE material_files DROP CONSTRAINT material_files_kind_check;
ALTER TABLE material_files ADD CONSTRAINT material_files_kind_check
  CHECK (kind IN ('original', 'proxy', 'hls', 'audio', 'thumbnail', 'voice_note', 'export', 'transcript', 'captions',
                  'watermarked_preview', 'shot_list', 'delivery', 'produced'));
DROP FUNCTION render_title_lines_valid(text[]);
DROP FUNCTION render_text_valid(text, integer);
