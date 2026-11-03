-- Up Migration
-- إدارة الوسوم (ADR 0098): القائمة المقترحة للمراسلين بترتيبها، وسجل الدمج وإعادة التسمية بالمواد التي مسّها كلٌّ منهما.
-- الوسم نص حرّ قد يحوي اسمًا حساسًا (ADR 0086)، فلا يدخل حدثًا ولا سجل تدقيق: الحدثان والتدقيق معرّفات وأرقام وحدها، والنص
-- في جدوليه هنا لمدير النظام وحده. القاعدة لكل وسم قاعدة MaterialTag نفسها (render_text_valid بحدّ 40، ترحيل 037):
-- 1–40 محرفًا، بلا مسافة في الطرفين ولا محارف تحكم أو اتجاه.

-- قائمة وسوم بلا تكرار ولا NULL، كلٌّ بقاعدة MaterialTag، وعددها حتى max_count. مثبّتة بـ search_path (#71).
CREATE FUNCTION tag_list_valid(tags text[], max_count integer) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path = public, pg_temp
AS $$
  SELECT cardinality(tags) <= max_count
     AND cardinality(tags) = (SELECT count(DISTINCT t) FROM unnest(tags) AS t)
     AND NOT EXISTS (SELECT 1 FROM unnest(tags) AS t WHERE NOT public.render_text_valid(t, 40))
$$;

-- صف واحد: القائمة بترتيب ظهورها للمراسل، وإصدار يرتفع مع كل تغيير (ETag)
CREATE TABLE tag_suggestions (
  id         boolean PRIMARY KEY DEFAULT true,
  tags       text[] NOT NULL DEFAULT '{}',
  version    integer NOT NULL DEFAULT 1,
  updated_by uuid REFERENCES users (id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tag_suggestions_singleton CHECK (id),
  CONSTRAINT tag_suggestions_version_positive CHECK (version >= 1),
  CONSTRAINT tag_suggestions_tags_valid CHECK (public.tag_list_valid(tags, 50))
);
CREATE TRIGGER tag_suggestions_set_updated_at BEFORE UPDATE ON tag_suggestions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
INSERT INTO tag_suggestions DEFAULT VALUES;

-- سجل الدمج وإعادة التسمية: الأصل والهدف وما مسّه كلٌّ منهما، إلحاقي لا يُعدَّل ولا يُحذف
CREATE TABLE tag_rewrites (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source            text NOT NULL,
  target            text NOT NULL,
  mode              text NOT NULL,
  materials_updated integer NOT NULL,
  created_by        uuid NOT NULL REFERENCES users (id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tag_rewrites_source_valid CHECK (public.render_text_valid(source, 40)),
  CONSTRAINT tag_rewrites_target_valid CHECK (public.render_text_valid(target, 40)),
  CONSTRAINT tag_rewrites_distinct CHECK (source <> target),
  CONSTRAINT tag_rewrites_mode_check CHECK (mode IN ('merge', 'rename')),
  CONSTRAINT tag_rewrites_materials_updated_check CHECK (materials_updated >= 0)
);
CREATE INDEX tag_rewrites_created_idx ON tag_rewrites (created_at DESC, id DESC);

CREATE FUNCTION tag_rewrites_immutable() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'tag_rewrites is append-only'
    USING ERRCODE = 'insufficient_privilege', CONSTRAINT = 'tag_rewrites_append_only';
END $$;
CREATE TRIGGER tag_rewrites_no_update BEFORE UPDATE OR DELETE ON tag_rewrites
  FOR EACH ROW EXECUTE FUNCTION tag_rewrites_immutable();

-- المواد التي حملت الأصل لحظة الدمج: منها يُستعاد ما كان لكل مادة
CREATE TABLE tag_rewrite_materials (
  tag_rewrite_id uuid NOT NULL REFERENCES tag_rewrites (id),
  material_id    uuid NOT NULL REFERENCES materials (id) ON DELETE CASCADE,
  PRIMARY KEY (tag_rewrite_id, material_id)
);
CREATE INDEX tag_rewrite_materials_material_idx ON tag_rewrite_materials (material_id);

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
    'render.requested', 'render.started', 'render.completed', 'render.failed',
    'assignment.created', 'assignment.state_changed',
    'tag.suggestions_changed', 'tag.rewritten'));

-- حمولة الحدثين أرقام ومعرّفات وحدها (ADR SEC-03، ADR 0086): لا نص وسم
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
    WHEN event_type = 'render.started'          THEN ARRAY['material_id', 'render_id']
    WHEN event_type = 'render.completed'        THEN ARRAY['material_id', 'render_id', 'file_id']
    WHEN event_type = 'render.failed'           THEN ARRAY['material_id', 'render_id', 'failure_reason']
    WHEN event_type = 'assignment.created'      THEN ARRAY['material_id', 'assignment_id', 'priority', 'assignee_id', 'assigned_by']
    WHEN event_type = 'assignment.state_changed' THEN ARRAY['material_id', 'assignment_id', 'priority', 'assignee_id', 'from', 'to']
    WHEN event_type = 'tag.suggestions_changed' THEN ARRAY['suggestions_version']
    WHEN event_type = 'tag.rewritten'           THEN ARRAY['tag_rewrite_id', 'mode', 'materials_updated']
    ELSE ARRAY[]::text[]
  END
$$;

-- التدقيق: الإصدار، ومعرّف الدمج ونوعه وعدد المواد، ولا نص وسم
CREATE OR REPLACE FUNCTION audit_details_allowed_keys() RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT ARRAY['permission', 'target_user_id', 'material_id', 'file_id', 'upload_session_id', 'field_keys', 'track',
               'from', 'to', 'recovery_request_id', 'session_id', 'installation_id', 'form_version', 'notification_id',
               'result', 'reason_code', 'role', 'scope_kind', 'scope_id', 'approved_by', 'rule_id', 'setting', 'value',
               'listing_id', 'license_template_id', 'license_version', 'organization_id', 'conflict_id',
               'payout_request_id', 'policy_id', 'assignment_id', 'suggestions_version', 'tag_rewrite_id', 'mode',
               'materials_updated']::text[]
$$;

-- Down Migration

CREATE OR REPLACE FUNCTION audit_details_allowed_keys() RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT ARRAY['permission', 'target_user_id', 'material_id', 'file_id', 'upload_session_id', 'field_keys', 'track',
               'from', 'to', 'recovery_request_id', 'session_id', 'installation_id', 'form_version', 'notification_id',
               'result', 'reason_code', 'role', 'scope_kind', 'scope_id', 'approved_by', 'rule_id', 'setting', 'value',
               'listing_id', 'license_template_id', 'license_version', 'organization_id', 'conflict_id',
               'payout_request_id', 'policy_id', 'assignment_id']::text[]
$$;

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
    WHEN event_type = 'render.started'          THEN ARRAY['material_id', 'render_id']
    WHEN event_type = 'render.completed'        THEN ARRAY['material_id', 'render_id', 'file_id']
    WHEN event_type = 'render.failed'           THEN ARRAY['material_id', 'render_id', 'failure_reason']
    WHEN event_type = 'assignment.created'      THEN ARRAY['material_id', 'assignment_id', 'priority', 'assignee_id', 'assigned_by']
    WHEN event_type = 'assignment.state_changed' THEN ARRAY['material_id', 'assignment_id', 'priority', 'assignee_id', 'from', 'to']
    ELSE ARRAY[]::text[]
  END
$$;

DELETE FROM outbox_events WHERE type IN ('tag.suggestions_changed', 'tag.rewritten');
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
    'render.requested', 'render.started', 'render.completed', 'render.failed',
    'assignment.created', 'assignment.state_changed'));

DROP TABLE tag_rewrite_materials;
DROP TABLE tag_rewrites;
DROP FUNCTION tag_rewrites_immutable();
DROP TABLE tag_suggestions;
DROP FUNCTION tag_list_valid(text[], integer);
