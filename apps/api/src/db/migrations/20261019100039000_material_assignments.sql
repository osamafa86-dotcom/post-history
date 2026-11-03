-- Up Migration
-- إسناد المادة إلى المونتير (ADR 0096): مهمة لكل مادة يكتبها المشرف أو رئيس التحرير لمستخدم بدور producer، بموعد وملاحظة،
-- وحالاتها assigned ← acknowledged ← in_progress ← done، أو returned من أيٍّ منها قبل done. الحالات الثلاث للمادة لا تتغيّر
-- بالإسناد. مهمة مفتوحة واحدة لكل مادة (فهرس جزئي فريد)، وإعادة التوزيع بإعادة المفتوحة (returned) ثم إسناد جديد.
--
-- الإشعار: آلية مهام الإشعارات القائمة نفسها (assignment_state وescalate_at وسلّم التصعيد)، وعمود assignment_id يربط
-- إشعار المهمة بها فيوقف إقرارُ أحدهما تصعيدَ الآخر. الملاحظتان نص حرّ لا يدخل حدثًا ولا إشعارًا ولا سجل تدقيق، وقاعدتهما
-- قاعدة الوسوم (render_text_valid، ترحيل 037) بحدّ 500 نقطة ترميز: بلا مسافة في الطرفين ولا محارف تحكم أو اتجاه.
CREATE TABLE material_assignments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  material_id     uuid NOT NULL REFERENCES materials (id) ON DELETE CASCADE,
  assignee_id     uuid NOT NULL REFERENCES users (id),
  assigned_by     uuid NOT NULL REFERENCES users (id),
  state           text NOT NULL DEFAULT 'assigned',
  due_at          timestamptz NOT NULL,
  note            text,
  returned_by     uuid REFERENCES users (id),
  return_note     text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  acknowledged_at timestamptz,
  started_at      timestamptz,
  closed_at       timestamptz,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT material_assignments_state_check CHECK (state IN ('assigned', 'acknowledged', 'in_progress', 'done', 'returned')),
  CONSTRAINT material_assignments_due_after_created CHECK (due_at > created_at),
  CONSTRAINT material_assignments_note_valid CHECK (note IS NULL OR public.render_text_valid(note, 500)),
  -- الإقرار يسبق العمل والتسليم؛ returned قد تقع قبله أو بعده
  CONSTRAINT material_assignments_acknowledged_at_check CHECK (
    (state = 'assigned' AND acknowledged_at IS NULL)
    OR (state IN ('acknowledged', 'in_progress', 'done') AND acknowledged_at IS NOT NULL)
    OR state = 'returned'),
  CONSTRAINT material_assignments_started_at_check CHECK (
    (state IN ('assigned', 'acknowledged') AND started_at IS NULL)
    OR (state IN ('in_progress', 'done') AND started_at IS NOT NULL)
    OR state = 'returned'),
  CONSTRAINT material_assignments_closed_at_check CHECK ((state IN ('done', 'returned')) = (closed_at IS NOT NULL)),
  CONSTRAINT material_assignments_returned_by_check CHECK ((state = 'returned') = (returned_by IS NOT NULL)),
  CONSTRAINT material_assignments_return_note_check CHECK (
    return_note IS NULL OR (state = 'returned' AND public.render_text_valid(return_note, 500)))
);
-- مهمة مفتوحة واحدة لكل مادة
CREATE UNIQUE INDEX material_assignments_open_key ON material_assignments (material_id)
  WHERE state IN ('assigned', 'acknowledged', 'in_progress');
-- «مهامي»: المفتوحة بالأقرب موعدًا، والمغلقة بالأحدث إغلاقًا
CREATE INDEX material_assignments_assignee_open_idx ON material_assignments (assignee_id, due_at, id)
  WHERE state IN ('assigned', 'acknowledged', 'in_progress');
CREATE INDEX material_assignments_assignee_closed_idx ON material_assignments (assignee_id, closed_at DESC, id DESC)
  WHERE state IN ('done', 'returned');
CREATE INDEX material_assignments_material_idx ON material_assignments (material_id, created_at DESC);
CREATE TRIGGER material_assignments_set_updated_at BEFORE UPDATE ON material_assignments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- إشعار المهمة يحمل معرّفها، فيفتحها العميل منه ويوقف إقرارُ أحدهما تصعيدَ الآخر
ALTER TABLE notifications ADD COLUMN assignment_id uuid REFERENCES material_assignments (id) ON DELETE SET NULL;
CREATE INDEX notifications_assignment_idx ON notifications (assignment_id) WHERE assignment_id IS NOT NULL;

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

-- حمولة أحداث الإسناد معرّفات وحالات وحدها (ADR SEC-03): لا ملاحظة ولا موعد ولا اسم
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

-- التدقيق: معرّف المهمة (مع material_id وtarget_user_id وfrom وto القائمة)، ولا نص حرّ
CREATE OR REPLACE FUNCTION audit_details_allowed_keys() RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT ARRAY['permission', 'target_user_id', 'material_id', 'file_id', 'upload_session_id', 'field_keys', 'track',
               'from', 'to', 'recovery_request_id', 'session_id', 'installation_id', 'form_version', 'notification_id',
               'result', 'reason_code', 'role', 'scope_kind', 'scope_id', 'approved_by', 'rule_id', 'setting', 'value',
               'listing_id', 'license_template_id', 'license_version', 'organization_id', 'conflict_id',
               'payout_request_id', 'policy_id', 'assignment_id']::text[]
$$;

-- Down Migration

CREATE OR REPLACE FUNCTION audit_details_allowed_keys() RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT ARRAY['permission', 'target_user_id', 'material_id', 'file_id', 'upload_session_id', 'field_keys', 'track',
               'from', 'to', 'recovery_request_id', 'session_id', 'installation_id', 'form_version', 'notification_id',
               'result', 'reason_code', 'role', 'scope_kind', 'scope_id', 'approved_by', 'rule_id', 'setting', 'value',
               'listing_id', 'license_template_id', 'license_version', 'organization_id', 'conflict_id',
               'payout_request_id', 'policy_id']::text[]
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
    ELSE ARRAY[]::text[]
  END
$$;

-- إشعارات أحداث الإسناد تشير إلى صفوفها في Outbox (event_id)، فتُحذف قبلها. وإشعار التصعيد يشير إلى حدثه هو
-- (notification.escalated) فيبقى، ومعرّف الإشعار الأصلي في حمولته نصّ لا مفتاح أجنبي.
DELETE FROM notifications WHERE type IN ('assignment.created', 'assignment.state_changed');
DELETE FROM outbox_events WHERE type IN ('assignment.created', 'assignment.state_changed');
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
    'render.requested', 'render.started', 'render.completed', 'render.failed'));

DROP INDEX notifications_assignment_idx;
ALTER TABLE notifications DROP COLUMN assignment_id;
DROP TABLE material_assignments;
