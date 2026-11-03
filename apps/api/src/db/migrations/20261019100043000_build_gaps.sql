-- Up Migration
-- فجوات البناء (ADR 0104): رفع النسخة المُنتَجة نوعَ جلسة، ورفض المؤسسة المشترية بسبب مرمّز، والتسليم بملف مُنتَج، وحدثا
-- تغيير الأدوار وحالة المؤسسة بمعرّفات ورموز وحدها. لا دالة جديدة.

-- 1. النسخة المُنتَجة يرفعها المسنَد إليه المادة بمسار tus نفسه؛ نوع الملف produced قائم منذ ترحيل 028
ALTER TABLE upload_sessions DROP CONSTRAINT upload_sessions_kind_check;
ALTER TABLE upload_sessions ADD CONSTRAINT upload_sessions_kind_check
  CHECK (kind IN ('original', 'proxy', 'voice_note', 'produced'));

-- 2. رفض المؤسسة: حالة rejected بسبب من قائمة مغلقة، ولا سبب لغيرها. المرفوضة لم تُفعَّل، فلا يلزمها verified_at
ALTER TABLE buyer_organizations ADD COLUMN rejection_reason text;
ALTER TABLE buyer_organizations DROP CONSTRAINT buyer_organizations_status_check;
ALTER TABLE buyer_organizations ADD CONSTRAINT buyer_organizations_status_check
  CHECK (status IN ('pending_verification', 'active', 'suspended', 'rejected'));
ALTER TABLE buyer_organizations DROP CONSTRAINT buyer_organizations_verified_check;
ALTER TABLE buyer_organizations ADD CONSTRAINT buyer_organizations_verified_check CHECK (
  (status IN ('pending_verification', 'rejected') OR verified_at IS NOT NULL) AND ((verified_at IS NULL) = (verified_by IS NULL)));
ALTER TABLE buyer_organizations ADD CONSTRAINT buyer_organizations_rejection_reason_check CHECK (
  (status = 'rejected') = (rejection_reason IS NOT NULL)
  AND (rejection_reason IS NULL OR rejection_reason IN
       ('commercial_registry', 'institutional_email', 'license_agreement', 'duplicate_organization', 'other')));

-- 3. «سلّمت المهمة» بملف مُنتَج: من المادة نفسها (مفتاح أجنبي مركّب)، ومع done وحدها
ALTER TABLE material_files ADD CONSTRAINT material_files_id_material_key UNIQUE (id, material_id);
ALTER TABLE material_assignments ADD COLUMN produced_file_id uuid;
ALTER TABLE material_assignments ADD CONSTRAINT material_assignments_produced_file_fkey
  FOREIGN KEY (produced_file_id, material_id) REFERENCES material_files (id, material_id);
ALTER TABLE material_assignments ADD CONSTRAINT material_assignments_produced_file_done_check
  CHECK (produced_file_id IS NULL OR state = 'done');

-- 4. الحدثان والمجمّع organization
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
    'platform_settings.changed',
    'user.roles_changed', 'buyer_organization.status_changed'));
ALTER TABLE outbox_events DROP CONSTRAINT outbox_events_aggregate_type_check;
ALTER TABLE outbox_events ADD CONSTRAINT outbox_events_aggregate_type_check
  CHECK (aggregate_type IN ('material', 'upload', 'notification', 'form', 'user', 'listing', 'license', 'order', 'payout',
                            'organization'));

-- الحمولة معرّفات ورموز (ADR SEC-03): لا أدوار في حدث الأدوار، ولا اسم في حدث المؤسسة
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
    WHEN event_type = 'user.roles_changed'      THEN ARRAY['user_id']
    WHEN event_type = 'buyer_organization.status_changed' THEN ARRAY['organization_id', 'from', 'to', 'reason_code']
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

DELETE FROM outbox_events WHERE type IN ('user.roles_changed', 'buyer_organization.status_changed') OR aggregate_type = 'organization';
ALTER TABLE outbox_events DROP CONSTRAINT outbox_events_aggregate_type_check;
ALTER TABLE outbox_events ADD CONSTRAINT outbox_events_aggregate_type_check
  CHECK (aggregate_type IN ('material', 'upload', 'notification', 'form', 'user', 'listing', 'license', 'order', 'payout'));
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

ALTER TABLE material_assignments DROP CONSTRAINT material_assignments_produced_file_done_check;
ALTER TABLE material_assignments DROP CONSTRAINT material_assignments_produced_file_fkey;
ALTER TABLE material_assignments DROP COLUMN produced_file_id;
ALTER TABLE material_files DROP CONSTRAINT material_files_id_material_key;

ALTER TABLE buyer_organizations DROP CONSTRAINT buyer_organizations_rejection_reason_check;
UPDATE buyer_organizations SET status = 'pending_verification' WHERE status = 'rejected';
ALTER TABLE buyer_organizations DROP CONSTRAINT buyer_organizations_verified_check;
ALTER TABLE buyer_organizations ADD CONSTRAINT buyer_organizations_verified_check CHECK (
  (status = 'pending_verification' OR verified_at IS NOT NULL) AND ((verified_at IS NULL) = (verified_by IS NULL)));
ALTER TABLE buyer_organizations DROP CONSTRAINT buyer_organizations_status_check;
ALTER TABLE buyer_organizations ADD CONSTRAINT buyer_organizations_status_check
  CHECK (status IN ('pending_verification', 'active', 'suspended'));
ALTER TABLE buyer_organizations DROP COLUMN rejection_reason;

-- ملفات جلسات المُنتَج المرفوعة ثم الجلسات؛ مشتقات العامل من نوع produced بلا جلسة تبقى كما كانت قبل هذا الترحيل
WITH produced AS (DELETE FROM upload_sessions WHERE kind = 'produced' RETURNING id)
DELETE FROM material_files WHERE upload_session_id IN (SELECT id FROM produced);
ALTER TABLE upload_sessions DROP CONSTRAINT upload_sessions_kind_check;
ALTER TABLE upload_sessions ADD CONSTRAINT upload_sessions_kind_check
  CHECK (kind IN ('original', 'proxy', 'voice_note'));
