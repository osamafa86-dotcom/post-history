-- Up Migration
-- ثلاثة أحداث دلالية للمادة (قرار المنسّق 2026-11-15): الرفض والقبول يصلان المراسل، وإعادة الإرسال بعد طلب التعديل تصل مشرفي مكتبها.
-- الحمولة حمولة أحداث المادة القائمة: معرّفات وحالات وحدها، بلا عنوان ولا سبب (ADR SEC-03). لا جدول ولا عمود جديد. يلي 050.
ALTER TABLE outbox_events DROP CONSTRAINT outbox_events_type_check;
ALTER TABLE outbox_events ADD CONSTRAINT outbox_events_type_check CHECK (type IN (
    'material.created', 'material.urgent_received', 'material.updated', 'material.version_created',
    'material.technical_transition', 'material.editorial_transition', 'material.rights_transition',
    'material.acknowledged', 'material.change_requested', 'material.accepted_for_production',
    'material.reserved', 'material.released', 'material.contributors_set', 'material.published',
    'material.rejected', 'material.accepted', 'material.resubmitted',
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
    'user.roles_changed', 'buyer_organization.status_changed',
    'auth.passkey_added', 'auth.passkey_revoked', 'auth.recovery_codes_generated'));

CREATE OR REPLACE FUNCTION outbox_payload_allowed_keys(event_type text) RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE
    WHEN event_type IN ('material.created', 'material.urgent_received', 'material.updated', 'material.version_created',
                        'material.acknowledged', 'material.change_requested', 'material.accepted_for_production',
                        'material.reserved', 'material.released', 'material.contributors_set', 'material.published',
                        'material.rejected', 'material.accepted', 'material.resubmitted')
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
    WHEN event_type IN ('auth.passkey_added', 'auth.passkey_revoked') THEN ARRAY['passkey_id']
    WHEN event_type = 'auth.recovery_codes_generated' THEN ARRAY['codes_count']
    ELSE ARRAY[]::text[]
  END
$$;

-- Down Migration

DELETE FROM notifications WHERE type IN ('material.rejected', 'material.accepted', 'material.resubmitted');
DELETE FROM outbox_events WHERE type IN ('material.rejected', 'material.accepted', 'material.resubmitted');
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
    'user.roles_changed', 'buyer_organization.status_changed',
    'auth.passkey_added', 'auth.passkey_revoked', 'auth.recovery_codes_generated'));

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
    WHEN event_type IN ('auth.passkey_added', 'auth.passkey_revoked') THEN ARRAY['passkey_id']
    WHEN event_type = 'auth.recovery_codes_generated' THEN ARRAY['codes_count']
    ELSE ARRAY[]::text[]
  END
$$;
