-- Up Migration
-- استعادة الحساب بلا مزوّد بريد ومفاتيح المرور (ADR 0107): وقت توليد الرموز الاحتياطية، ومفاتيح المرور (WebAuthn) بمفتاحها العام
-- وعدّادها، وتحدياتها لمرة واحدة ببصمتها وحدها، وثلاثة أحداث بمعرّفات وأعداد وحدها. رابط إعادة التعيين من مدير النظام طلبُ استعادة
-- معتمد في recovery_requests القائم، فلا جدول له. لا دالة جديدة. يلي 043 (ADR 0104): القائمتان هنا قائمتاه وإضافات هذا الترحيل.

-- 1. الرموز الاحتياطية: متى وُلّدت المجموعة الحالية (GET /auth/recovery-codes)
ALTER TABLE recovery_codes ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();

-- 2. مفاتيح المرور. معرّف الاعتماد خام لاستثنائه عند التسجيل وللبحث عند الدخول؛ لا يخرج في رد ولا تدقيق ولا حدث. الاسم يكتبه
-- صاحبه بقاعدة MaterialTag (render_text_valid، ترحيل 037). الإبطال بسبب من قائمة مغلقة: صاحبه، أو إعادة تعيين الحساب.
CREATE TABLE passkeys (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  credential_id  bytea NOT NULL,
  public_key     bytea NOT NULL,
  sign_count     bigint NOT NULL DEFAULT 0,
  transports     text[] NOT NULL DEFAULT '{}',
  multi_device   boolean NOT NULL,
  backed_up      boolean NOT NULL,
  name           text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_used_at   timestamptz,
  revoked_at     timestamptz,
  revoked_reason text,
  CONSTRAINT passkeys_credential_id_len CHECK (octet_length(credential_id) BETWEEN 1 AND 1023),
  CONSTRAINT passkeys_public_key_len CHECK (octet_length(public_key) BETWEEN 1 AND 8192),
  CONSTRAINT passkeys_sign_count_range CHECK (sign_count BETWEEN 0 AND 4294967295),
  CONSTRAINT passkeys_transports_valid CHECK (cardinality(transports) <= 8),
  CONSTRAINT passkeys_backed_up_multi_device CHECK (NOT backed_up OR multi_device),
  CONSTRAINT passkeys_name_valid CHECK (name IS NULL OR public.render_text_valid(name, 40)),
  CONSTRAINT passkeys_revoked_consistent CHECK ((revoked_at IS NULL) = (revoked_reason IS NULL)),
  CONSTRAINT passkeys_revoked_reason_check CHECK (revoked_reason IS NULL OR revoked_reason IN ('owner', 'credential_reset'))
);
CREATE UNIQUE INDEX passkeys_credential_id_key ON passkeys (credential_id);
CREATE INDEX passkeys_user_active_idx ON passkeys (user_id, created_at DESC) WHERE revoked_at IS NULL;

-- 3. تحديات WebAuthn: بصمة SHA-256 للتحدي وحدها (يُقارن بها ما وقّعه المصادِق)، لمرة واحدة (تُحذف عند الاستهلاك)، وعمرها لا يتجاوز
-- عشر دقائق. تحدي التسجيل لمستخدمه، وتحدي الدخول بلا مستخدم (المفتاح يُكتشف على الجهاز).
CREATE TABLE webauthn_challenges (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purpose        text NOT NULL,
  user_id        uuid REFERENCES users (id) ON DELETE CASCADE,
  challenge_hash bytea NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL,
  CONSTRAINT webauthn_challenges_purpose_check CHECK (purpose IN ('registration', 'authentication')),
  CONSTRAINT webauthn_challenges_user_check CHECK ((purpose = 'registration') = (user_id IS NOT NULL)),
  CONSTRAINT webauthn_challenges_hash_len CHECK (octet_length(challenge_hash) = 32),
  CONSTRAINT webauthn_challenges_lifetime CHECK (expires_at > created_at AND expires_at <= created_at + interval '10 minutes')
);
CREATE INDEX webauthn_challenges_expires_idx ON webauthn_challenges (expires_at);

-- 4. الأحداث الثلاثة
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

-- الحمولة معرّفات وأعداد (ADR SEC-03): لا معرّف اعتماد ولا اسم مفتاح ولا رمز
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

-- التدقيق: المرجع الداخلي للمفتاح، وعدد المفاتيح المبطَلة بإعادة التعيين، وعدد الرموز الاحتياطية
CREATE OR REPLACE FUNCTION audit_details_allowed_keys() RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT ARRAY['permission', 'target_user_id', 'material_id', 'file_id', 'upload_session_id', 'field_keys', 'track',
               'from', 'to', 'recovery_request_id', 'session_id', 'installation_id', 'form_version', 'notification_id',
               'result', 'reason_code', 'role', 'scope_kind', 'scope_id', 'approved_by', 'rule_id', 'setting', 'value',
               'listing_id', 'license_template_id', 'license_version', 'organization_id', 'conflict_id',
               'payout_request_id', 'policy_id', 'assignment_id', 'suggestions_version', 'tag_rewrite_id', 'mode',
               'materials_updated', 'settings_version', 'passkey_id', 'passkeys_revoked', 'codes_count']::text[]
$$;

-- Down Migration

CREATE OR REPLACE FUNCTION audit_details_allowed_keys() RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT ARRAY['permission', 'target_user_id', 'material_id', 'file_id', 'upload_session_id', 'field_keys', 'track',
               'from', 'to', 'recovery_request_id', 'session_id', 'installation_id', 'form_version', 'notification_id',
               'result', 'reason_code', 'role', 'scope_kind', 'scope_id', 'approved_by', 'rule_id', 'setting', 'value',
               'listing_id', 'license_template_id', 'license_version', 'organization_id', 'conflict_id',
               'payout_request_id', 'policy_id', 'assignment_id', 'suggestions_version', 'tag_rewrite_id', 'mode',
               'materials_updated', 'settings_version']::text[]
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
    WHEN event_type = 'platform_settings.changed' THEN ARRAY['settings_version', 'changed_fields']
    WHEN event_type = 'user.roles_changed'      THEN ARRAY['user_id']
    WHEN event_type = 'buyer_organization.status_changed' THEN ARRAY['organization_id', 'from', 'to', 'reason_code']
    ELSE ARRAY[]::text[]
  END
$$;

DELETE FROM notifications WHERE type IN ('auth.passkey_added', 'auth.passkey_revoked', 'auth.recovery_codes_generated');
DELETE FROM outbox_events WHERE type IN ('auth.passkey_added', 'auth.passkey_revoked', 'auth.recovery_codes_generated');
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

DROP TABLE webauthn_challenges;
DROP TABLE passkeys;
ALTER TABLE recovery_codes DROP COLUMN created_at;
