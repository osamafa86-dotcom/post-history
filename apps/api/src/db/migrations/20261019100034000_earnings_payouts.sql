-- Up Migration
-- الأرباح وطلبات الصرف التجريبية (ADR 0033، ADR 0025 الجزء 8، ADR 0031). الثوابت في القاعدة:
-- - المستحق «المتاح» و«قيد الصرف» لا يصير مدينًا عند الإيداع، فلا صرف فوق المتاح ولو تزامن طلبان.
-- - لكل حالة طلب قيدها في الدفتر من نوع payout، والانتقالات صريحة، وما جُمّد لا يتغير.
-- - الاعتماد لغير صاحب الطلب، ومرة لكل معتمد، وعدد المعتمدين المطلوب مجمّد في الطلب.
-- - سياسة الصرف (الحد الأدنى، وحد الاعتماد الثنائي، والاحتياطي) صفوف لا تُعدَّل بتاريخ سريان.
-- القناة الوحيدة sandbox: لا مال ولا بيانات حساب بنكي.

-- ---------- المستحق لا يصير مدينًا ----------
CREATE FUNCTION contributor_payable_not_debit() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.ledger_accounts a
              WHERE a.id = NEW.account_id AND a.kind = 'contributor_payable' AND a.payable_state IN ('available', 'in_payout'))
     AND (SELECT sum(p.amount_minor) FROM public.postings p WHERE p.account_id = NEW.account_id) > 0 THEN
    RAISE EXCEPTION 'a contributor payable cannot go below zero' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER postings_payable_not_debit AFTER INSERT ON postings
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION contributor_payable_not_debit();

-- ---------- سياسة الصرف ----------
CREATE TABLE payout_policies (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  currency                  text NOT NULL,
  minimum_minor             bigint NOT NULL,
  dual_approval_above_minor bigint NOT NULL,
  reserve_bps               integer NOT NULL,
  effective_from            timestamptz NOT NULL,
  created_by                uuid NOT NULL REFERENCES users (id),
  created_at                timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payout_policies_currency_check CHECK (currency IN ('USD', 'ILS')),
  CONSTRAINT payout_policies_minimum_check CHECK (minimum_minor BETWEEN 1 AND 100000000000),
  CONSTRAINT payout_policies_dual_check CHECK (dual_approval_above_minor BETWEEN 0 AND 100000000000),
  CONSTRAINT payout_policies_reserve_check CHECK (reserve_bps BETWEEN 0 AND 5000),
  CONSTRAINT payout_policies_key UNIQUE (currency, effective_from)
);

CREATE FUNCTION payout_append_only() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
END $$;
CREATE TRIGGER payout_policies_append_only BEFORE UPDATE OR DELETE ON payout_policies
  FOR EACH ROW EXECUTE FUNCTION payout_append_only();

-- ---------- طلبات الصرف ----------
CREATE TABLE payout_requests (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid NOT NULL REFERENCES users (id),
  amount_minor       bigint NOT NULL,
  currency           text NOT NULL,
  channel            text NOT NULL,
  approvals_required smallint NOT NULL,
  state              text NOT NULL DEFAULT 'requested',
  reason_code        text,
  hold_entry_id      uuid NOT NULL UNIQUE REFERENCES journal_entries (id),
  settle_entry_id    uuid UNIQUE REFERENCES journal_entries (id),
  release_entry_id   uuid UNIQUE REFERENCES journal_entries (id),
  channel_ref        text,
  requested_at       timestamptz NOT NULL DEFAULT now(),
  decided_at         timestamptz,
  completed_at       timestamptz,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payout_requests_amount_check CHECK (amount_minor BETWEEN 1 AND 100000000000),
  CONSTRAINT payout_requests_currency_check CHECK (currency IN ('USD', 'ILS')),
  CONSTRAINT payout_requests_channel_check CHECK (channel IN ('sandbox')),
  CONSTRAINT payout_requests_approvals_check CHECK (approvals_required IN (1, 2)),
  CONSTRAINT payout_requests_state_check
    CHECK (state IN ('requested', 'approved', 'processing', 'paid', 'failed', 'rejected', 'cancelled')),
  CONSTRAINT payout_requests_reason_check CHECK (
    (state IN ('failed', 'rejected')) = (reason_code IS NOT NULL) AND
    (reason_code IS NULL OR reason_code IN ('documents_missing', 'suspected_fraud', 'policy', 'channel_failed', 'other'))),
  CONSTRAINT payout_requests_settle_check CHECK ((state = 'paid') = (settle_entry_id IS NOT NULL)),
  CONSTRAINT payout_requests_release_check CHECK ((state IN ('failed', 'rejected', 'cancelled')) = (release_entry_id IS NOT NULL)),
  CONSTRAINT payout_requests_decided_check CHECK ((state IN ('requested', 'cancelled')) = (decided_at IS NULL)),
  CONSTRAINT payout_requests_completed_check
    CHECK ((state IN ('paid', 'failed', 'rejected', 'cancelled')) = (completed_at IS NOT NULL)),
  -- كل قيد لمرحلته: الحجز والصرف والإعادة ثلاثة قيود مختلفة (القيد مرجعه الطلب، فلا يعبر إلى طلب آخر)
  CONSTRAINT payout_requests_entries_distinct CHECK (
    settle_entry_id IS DISTINCT FROM hold_entry_id AND release_entry_id IS DISTINCT FROM hold_entry_id AND
    (settle_entry_id IS NULL OR release_entry_id IS NULL)),
  CONSTRAINT payout_requests_channel_ref_check CHECK (channel_ref IS NULL OR char_length(channel_ref) BETWEEN 1 AND 128)
);
CREATE TRIGGER payout_requests_set_updated_at BEFORE UPDATE ON payout_requests
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX payout_requests_user_idx ON payout_requests (user_id, requested_at DESC, id DESC);
CREATE INDEX payout_requests_open_idx ON payout_requests (requested_at) WHERE state IN ('requested', 'approved', 'processing');

CREATE TABLE payout_approvals (
  payout_request_id uuid NOT NULL REFERENCES payout_requests (id),
  approver_id       uuid NOT NULL REFERENCES users (id),
  approved_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (payout_request_id, approver_id)
);

-- القيد المشار إليه من نوع payout ومرجعه الطلب نفسه
CREATE FUNCTION payout_entry_matches(entry uuid, request uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM public.journal_entries j
                  WHERE j.id = entry AND j.kind = 'payout' AND j.reference_type = 'payout_request' AND j.reference_id = request)
$$;

CREATE FUNCTION payout_request_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'payout requests are kept, not deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'requested' OR NOT public.payout_entry_matches(NEW.hold_entry_id, NEW.id) THEN
      RAISE EXCEPTION 'a payout request starts requested with its hold entry' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.user_id, NEW.amount_minor, NEW.currency, NEW.channel, NEW.approvals_required, NEW.hold_entry_id, NEW.requested_at)
     IS DISTINCT FROM
     (OLD.user_id, OLD.amount_minor, OLD.currency, OLD.channel, OLD.approvals_required, OLD.hold_entry_id, OLD.requested_at) THEN
    RAISE EXCEPTION 'a payout request keeps its owner, amount, channel and hold' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.state IS DISTINCT FROM OLD.state AND NOT (
       (OLD.state = 'requested' AND NEW.state IN ('approved', 'rejected', 'cancelled')) OR
       (OLD.state = 'approved' AND NEW.state IN ('processing', 'rejected')) OR
       (OLD.state = 'processing' AND NEW.state IN ('paid', 'failed'))) THEN
    RAISE EXCEPTION 'payout transition % -> % is not allowed', OLD.state, NEW.state USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.state IN ('paid', 'failed', 'rejected', 'cancelled') AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'a completed payout request is final' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.state = 'approved' AND OLD.state = 'requested'
     AND (SELECT count(*) FROM public.payout_approvals pa WHERE pa.payout_request_id = NEW.id) < NEW.approvals_required THEN
    RAISE EXCEPTION 'a payout request needs % approvals', NEW.approvals_required USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW.settle_entry_id IS NOT NULL AND NOT public.payout_entry_matches(NEW.settle_entry_id, NEW.id)) OR
     (NEW.release_entry_id IS NOT NULL AND NOT public.payout_entry_matches(NEW.release_entry_id, NEW.id)) THEN
    RAISE EXCEPTION 'payout entries are payout journal entries of this request' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER payout_requests_guard BEFORE INSERT OR UPDATE OR DELETE ON payout_requests
  FOR EACH ROW EXECUTE FUNCTION payout_request_guard();

CREATE FUNCTION payout_approval_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'payout approvals are append-only' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.payout_requests r
                  WHERE r.id = NEW.payout_request_id AND r.state = 'requested' AND r.user_id <> NEW.approver_id) THEN
    RAISE EXCEPTION 'an approval is for a requested payout and not by its owner' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER payout_approvals_guard BEFORE INSERT OR UPDATE OR DELETE ON payout_approvals
  FOR EACH ROW EXECUTE FUNCTION payout_approval_guard();

-- ---------- الأحداث والتدقيق ----------
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
    'payout.status_changed'));

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

CREATE OR REPLACE FUNCTION audit_details_allowed_keys() RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT ARRAY['permission', 'target_user_id', 'material_id', 'file_id', 'upload_session_id', 'field_keys', 'track',
               'from', 'to', 'recovery_request_id', 'session_id', 'installation_id', 'form_version', 'notification_id',
               'result', 'reason_code', 'role', 'scope_kind', 'scope_id', 'approved_by', 'rule_id', 'setting', 'value',
               'listing_id', 'license_template_id', 'license_version', 'organization_id', 'conflict_id',
               'payout_request_id', 'policy_id']::text[]
$$;

-- Down Migration

CREATE OR REPLACE FUNCTION audit_details_allowed_keys() RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT ARRAY['permission', 'target_user_id', 'material_id', 'file_id', 'upload_session_id', 'field_keys', 'track',
               'from', 'to', 'recovery_request_id', 'session_id', 'installation_id', 'form_version', 'notification_id',
               'result', 'reason_code', 'role', 'scope_kind', 'scope_id', 'approved_by', 'rule_id', 'setting', 'value',
               'listing_id', 'license_template_id', 'license_version', 'organization_id', 'conflict_id']::text[]
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
    ELSE ARRAY[]::text[]
  END
$$;

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
    'order.status_changed', 'license.issued', 'license.revoked'));
ALTER TABLE outbox_events DROP CONSTRAINT outbox_events_aggregate_type_check;
ALTER TABLE outbox_events ADD CONSTRAINT outbox_events_aggregate_type_check
  CHECK (aggregate_type IN ('material', 'upload', 'notification', 'form', 'user', 'listing', 'license', 'order'));

DROP TABLE payout_approvals;
DROP TABLE payout_requests;
DROP TABLE payout_policies;
DROP TRIGGER postings_payable_not_debit ON postings;
DROP FUNCTION payout_approval_guard();
DROP FUNCTION payout_request_guard();
DROP FUNCTION payout_entry_matches(uuid, uuid);
DROP FUNCTION payout_append_only();
DROP FUNCTION contributor_payable_not_debit();
