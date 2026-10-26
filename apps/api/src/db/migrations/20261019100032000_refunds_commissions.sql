-- Up Migration
-- العقد v0.3، الجزءان 5 و6 (ADR 0025): الاسترداد ببنوده، وقواعد العمولة بإصدارات لا تُعدَّل. الثوابت في القاعدة:
-- - الاسترداد لطلب مدفوع، وبنوده من الطلب نفسه، ومبلغه مجموع أسعارها المجمّدة بعملة الطلب.
-- - البند لا يُسترد مرتين، إلا بعد استرداد فاشل.
-- - النجاح يلزمه قيد `refund` في الدفتر يعكس البيعة (ADR 0031)، والحالة لا تعود.
-- - قاعدة العمولة لا تُعدَّل ولا تُحذف؛ التغيير صف جديد بتاريخ سريان، والسارية لحظة التأكيد تُجمَّد في قيد البيعة.

-- ---------- الاسترداد ----------
CREATE TABLE refunds (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id            uuid NOT NULL REFERENCES orders (id),
  amount_minor        bigint NOT NULL,
  currency            text NOT NULL,
  reason_code         text NOT NULL,
  status              text NOT NULL DEFAULT 'pending',
  provider_refund_ref text,
  entry_id            uuid REFERENCES journal_entries (id),
  created_by          uuid NOT NULL REFERENCES users (id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  completed_at        timestamptz,
  CONSTRAINT refunds_amount_check CHECK (amount_minor BETWEEN 1 AND 2000000000000),
  CONSTRAINT refunds_currency_check CHECK (currency IN ('USD', 'ILS')),
  CONSTRAINT refunds_reason_check
    CHECK (reason_code IN ('buyer_request', 'duplicate', 'rights_withdrawn', 'dispute', 'exclusivity_lost', 'other')),
  CONSTRAINT refunds_status_check CHECK (status IN ('pending', 'succeeded', 'failed')),
  CONSTRAINT refunds_provider_ref_check CHECK (provider_refund_ref IS NULL OR char_length(provider_refund_ref) BETWEEN 1 AND 128),
  CONSTRAINT refunds_completed_check CHECK ((status = 'pending') = (completed_at IS NULL)),
  CONSTRAINT refunds_entry_check CHECK ((status = 'succeeded') = (entry_id IS NOT NULL))
);
CREATE UNIQUE INDEX refunds_provider_ref_key ON refunds (provider_refund_ref) WHERE provider_refund_ref IS NOT NULL;
CREATE INDEX refunds_order_idx ON refunds (order_id);

CREATE TABLE refund_items (
  refund_id     uuid NOT NULL REFERENCES refunds (id),
  order_item_id uuid NOT NULL REFERENCES order_items (id),
  PRIMARY KEY (refund_id, order_item_id)
);
CREATE INDEX refund_items_item_idx ON refund_items (order_item_id);

-- الاسترداد لطلب مدفوع بعملته؛ بعد الإنشاء يتغير المرجع والحالة والقيد وحدها، والحالة لا تعود. النجاح بقيد refund.
CREATE FUNCTION refund_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'refunds are kept, not deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'pending' OR NOT EXISTS (
         SELECT 1 FROM public.orders o WHERE o.id = NEW.order_id AND o.status = 'paid' AND o.currency = NEW.currency) THEN
      RAISE EXCEPTION 'a refund starts pending for a paid order in its currency' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.order_id, NEW.amount_minor, NEW.currency, NEW.reason_code, NEW.created_by, NEW.created_at) IS DISTINCT FROM
     (OLD.order_id, OLD.amount_minor, OLD.currency, OLD.reason_code, OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'a refund keeps its order, amount, reason and author' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status <> 'pending' AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'a completed refund is final' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.entry_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM public.journal_entries j WHERE j.id = NEW.entry_id AND j.kind = 'refund') THEN
    RAISE EXCEPTION 'a succeeded refund points to a refund journal entry' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER refunds_guard BEFORE INSERT OR UPDATE OR DELETE ON refunds
  FOR EACH ROW EXECUTE FUNCTION refund_guard();

-- البند من طلب الاسترداد نفسه، ولا يُسترد مرتين ما لم يفشل الاسترداد السابق؛ والبنود لا تُعدَّل
CREATE FUNCTION refund_item_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'refund items are frozen' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.refunds r JOIN public.order_items i ON i.order_id = r.order_id
                  WHERE r.id = NEW.refund_id AND i.id = NEW.order_item_id) THEN
    RAISE EXCEPTION 'a refund item belongs to the refunded order' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM 1 FROM public.order_items i WHERE i.id = NEW.order_item_id FOR NO KEY UPDATE;  -- يسلسل استردادين متزامنين للبند
  IF EXISTS (SELECT 1 FROM public.refund_items ri JOIN public.refunds r ON r.id = ri.refund_id
              WHERE ri.order_item_id = NEW.order_item_id AND ri.refund_id <> NEW.refund_id AND r.status <> 'failed') THEN
    RAISE EXCEPTION 'an item is refunded once' USING ERRCODE = 'unique_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER refund_items_guard BEFORE INSERT OR UPDATE OR DELETE ON refund_items
  FOR EACH ROW EXECUTE FUNCTION refund_item_guard();

-- مبلغ الاسترداد مجموع أسعار بنوده المجمّدة، وبند واحد على الأقل؛ يُفحص عند الإيداع
CREATE FUNCTION refund_amount_matches() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  rid uuid;
BEGIN
  IF TG_TABLE_NAME = 'refund_items' THEN
    rid := NEW.refund_id;
  ELSE
    rid := NEW.id;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.refunds r
                  WHERE r.id = rid
                    AND r.amount_minor = (SELECT sum(i.price_minor) FROM public.refund_items ri
                                            JOIN public.order_items i ON i.id = ri.order_item_id
                                           WHERE ri.refund_id = rid)) THEN
    RAISE EXCEPTION 'a refund amount is the sum of its items and it has at least one' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER refunds_amount AFTER INSERT ON refunds
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION refund_amount_matches();
CREATE CONSTRAINT TRIGGER refund_items_amount AFTER INSERT ON refund_items
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION refund_amount_matches();

-- ---------- قواعد العمولة ----------
-- الأكثر تحديدًا يغلب: المادة، ثم المراسل (بنوع الترخيص)، ثم نوع المادة، ثم الافتراضية؛ والسارية بأحدث effective_from
-- لا يتجاوز لحظة التأكيد. النسبة نقاط أساس من صافي الإيراد بعد رسوم المزوّد والضريبة.
CREATE TABLE commission_rules (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope                 text NOT NULL,
  scope_id              text,
  license_type          text,
  platform_basis_points integer NOT NULL,
  effective_from        timestamptz NOT NULL,
  created_by            uuid NOT NULL REFERENCES users (id),
  created_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT commission_rules_scope_check CHECK (scope IN ('material', 'reporter', 'material_type', 'default')),
  CONSTRAINT commission_rules_scope_id_check CHECK (
    (scope = 'default' AND scope_id IS NULL) OR
    (scope IN ('material', 'reporter') AND scope_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') OR
    (scope = 'material_type' AND scope_id = ANY (public.allowed_material_types()))),
  CONSTRAINT commission_rules_license_type_check CHECK (
    license_type IS NULL OR license_type IN ('editorial_single', 'editorial_term', 'exclusive_temporary', 'commercial')),
  CONSTRAINT commission_rules_points_check CHECK (platform_basis_points BETWEEN 0 AND 10000)
);
CREATE UNIQUE INDEX commission_rules_key ON commission_rules (scope, scope_id, license_type, effective_from) NULLS NOT DISTINCT;
CREATE INDEX commission_rules_lookup_idx ON commission_rules (scope, scope_id, effective_from DESC);

CREATE FUNCTION commission_rules_append_only() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'commission rules are append-only; add a row with a new effective_from' USING ERRCODE = 'restrict_violation';
END $$;
CREATE TRIGGER commission_rules_append_only BEFORE UPDATE OR DELETE ON commission_rules
  FOR EACH ROW EXECUTE FUNCTION commission_rules_append_only();

-- ---------- الأحداث ----------
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
    'order.status_changed', 'license.issued'));

DROP TABLE commission_rules;
DROP TABLE refund_items;
DROP TABLE refunds;
DROP FUNCTION commission_rules_append_only();
DROP FUNCTION refund_amount_matches();
DROP FUNCTION refund_item_guard();
DROP FUNCTION refund_guard();
