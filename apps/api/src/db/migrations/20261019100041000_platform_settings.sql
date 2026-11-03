-- Up Migration
-- هوية المنصة (ADR 0099، A6): اسم المنصة واسم تطبيق المراسل ونص العلامة المائية في المعاينات، صف واحد بإصدار يرتفع مع كل
-- تغيير (ETag). كل نص بقاعدة MaterialTag (render_text_valid، ترحيل 037): بلا مسافة في الطرفين ولا محارف تحكم أو اتجاه، فلا
-- يقلب نص الاتجاه في واجهة أو صورة. القيم المبذورة هي الأسماء المعروضة اليوم. الحدث والتدقيق بالإصدار وأسماء الحقول وحدها،
-- بلا نص.
CREATE TABLE platform_settings (
  id             boolean PRIMARY KEY DEFAULT true,
  platform_name  text NOT NULL,
  app_name       text NOT NULL,
  watermark_text text NOT NULL,
  version        integer NOT NULL DEFAULT 1,
  updated_by     uuid REFERENCES users (id),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT platform_settings_singleton CHECK (id),
  CONSTRAINT platform_settings_version_positive CHECK (version >= 1),
  CONSTRAINT platform_settings_platform_name_valid CHECK (public.render_text_valid(platform_name, 60)),
  CONSTRAINT platform_settings_app_name_valid CHECK (public.render_text_valid(app_name, 40)),
  CONSTRAINT platform_settings_watermark_text_valid CHECK (public.render_text_valid(watermark_text, 60))
);
CREATE TRIGGER platform_settings_set_updated_at BEFORE UPDATE ON platform_settings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
INSERT INTO platform_settings (platform_name, app_name, watermark_text)
VALUES ('المكتبة المرئية', 'ميدان بوست', 'معاينة · المكتبة المرئية');

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
    'tag.suggestions_changed', 'tag.rewritten',
    'platform_settings.changed'));

-- حمولة الحدث الإصدار وأسماء الحقول التي تغيّرت (ADR SEC-03): لا نص
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
    WHEN event_type = 'platform_settings.changed' THEN ARRAY['settings_version', 'changed_fields']
    ELSE ARRAY[]::text[]
  END
$$;

CREATE OR REPLACE FUNCTION audit_details_allowed_keys() RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT ARRAY['permission', 'target_user_id', 'material_id', 'file_id', 'upload_session_id', 'field_keys', 'track',
               'from', 'to', 'recovery_request_id', 'session_id', 'installation_id', 'form_version', 'notification_id',
               'result', 'reason_code', 'role', 'scope_kind', 'scope_id', 'approved_by', 'rule_id', 'setting', 'value',
               'listing_id', 'license_template_id', 'license_version', 'organization_id', 'conflict_id',
               'payout_request_id', 'policy_id', 'assignment_id', 'suggestions_version', 'tag_rewrite_id', 'mode',
               'materials_updated', 'settings_version']::text[]
$$;

-- Down Migration

CREATE OR REPLACE FUNCTION audit_details_allowed_keys() RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT ARRAY['permission', 'target_user_id', 'material_id', 'file_id', 'upload_session_id', 'field_keys', 'track',
               'from', 'to', 'recovery_request_id', 'session_id', 'installation_id', 'form_version', 'notification_id',
               'result', 'reason_code', 'role', 'scope_kind', 'scope_id', 'approved_by', 'rule_id', 'setting', 'value',
               'listing_id', 'license_template_id', 'license_version', 'organization_id', 'conflict_id',
               'payout_request_id', 'policy_id', 'assignment_id', 'suggestions_version', 'tag_rewrite_id', 'mode',
               'materials_updated']::text[]
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
    WHEN event_type = 'tag.suggestions_changed' THEN ARRAY['suggestions_version']
    WHEN event_type = 'tag.rewritten'           THEN ARRAY['tag_rewrite_id', 'mode', 'materials_updated']
    ELSE ARRAY[]::text[]
  END
$$;

DELETE FROM outbox_events WHERE type = 'platform_settings.changed';
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

DROP TABLE platform_settings;
