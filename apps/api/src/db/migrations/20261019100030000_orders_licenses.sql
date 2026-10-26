-- Up Migration
-- العقد v0.3، الجزءان 4 و9 (ADR 0025): الطلبات ببنود مجمّدة، وحجز الحصرية، والتراخيص الصادرة، وإشعارات مزوّد الدفع
-- المستلمة (ADR 0032). الثوابت في القاعدة لا في الكود وحده:
-- - البند يجمّد إصدار المادة وإصدار القالب الحالي وسعره كما في العرض، والإدراج معروض لحظة الطلب.
-- - البند لا يُعدَّل ولا يُحذف، ومجموع الطلب مجموع بنوده بعملة واحدة.
-- - حجز حصري واحد قائم أو نشط لكل مادة بفهرس فريد جزئي، ولا حصرية لمادة سبق بيعها.
-- - الترخيص يصدر لطلب مدفوع ولحقوق قابلة للبيع، وشروطه المجمّدة لا تتغير.
-- - الإشعار المستلم فريد بـ (المزوّد، معرّف الحدث)، فتكراره لا يكرر أثرًا.
-- الحجز والبند والترخيص يقفل كل منها صف المادة في محفّزه، فلا يفوت أحدها الآخر في معاملتين متزامنتين.
-- انتهاء الحجز بالزمن لا يُكتب في الفهرس: الخادم يحرر الحجوزات المنتهية للمادة تحت قفل صفها قبل حجز جديد.

-- ---------- الطلبات ----------
CREATE TABLE orders (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES buyer_organizations (id),
  created_by      uuid NOT NULL REFERENCES users (id),
  status          text NOT NULL DEFAULT 'pending_payment',
  cancel_reason   text,
  currency        text NOT NULL,
  total_minor     bigint NOT NULL,
  provider        text,
  provider_ref    text,
  expires_at      timestamptz NOT NULL,
  paid_at         timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT orders_status_check CHECK (status IN ('pending_payment', 'paid', 'cancelled', 'expired', 'refunded')),
  CONSTRAINT orders_cancel_reason_check CHECK (
    (status = 'cancelled') = (cancel_reason IS NOT NULL) AND
    (cancel_reason IS NULL OR cancel_reason IN ('buyer', 'exclusivity_lost', 'rights_changed'))),
  CONSTRAINT orders_currency_check CHECK (currency IN ('USD', 'ILS')),
  CONSTRAINT orders_total_check CHECK (total_minor BETWEEN 0 AND 2000000000000),
  CONSTRAINT orders_provider_check CHECK (
    (provider IS NULL) = (provider_ref IS NULL) AND
    (provider IS NULL OR provider ~ '^[a-z_]{1,32}$') AND
    (provider_ref IS NULL OR char_length(provider_ref) BETWEEN 1 AND 128)),
  CONSTRAINT orders_paid_check CHECK ((status IN ('paid', 'refunded')) = (paid_at IS NOT NULL)),
  CONSTRAINT orders_expiry_check CHECK (expires_at > created_at AND expires_at <= created_at + interval '24 hours')
);
CREATE TRIGGER orders_set_updated_at BEFORE UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE UNIQUE INDEX orders_provider_ref_key ON orders (provider, provider_ref) WHERE provider_ref IS NOT NULL;
CREATE INDEX orders_organization_idx ON orders (organization_id, created_at DESC, id DESC);
CREATE INDEX orders_pending_idx ON orders (expires_at) WHERE status = 'pending_payment';

-- انتقالات الطلب، وما جُمّد فيه لا يتغير. الدفع الواصل بعد الانتهاء يُقبل إن أعاد الخادم التحقق (الحجز ما زال قائمًا
-- والحقوق قابلة للبيع)، وإلا يبقى الطلب منتهيًا أو يُلغى ويُسترد المبلغ (الجزء 5).
CREATE FUNCTION orders_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF (NEW.organization_id, NEW.created_by, NEW.currency, NEW.total_minor, NEW.expires_at, NEW.created_at) IS DISTINCT FROM
     (OLD.organization_id, OLD.created_by, OLD.currency, OLD.total_minor, OLD.expires_at, OLD.created_at) THEN
    RAISE EXCEPTION 'an order keeps its organization, buyer, currency, total and expiry' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status NOT IN ('pending_payment', 'expired') AND (NEW.provider, NEW.provider_ref) IS DISTINCT FROM (OLD.provider, OLD.provider_ref) THEN
    RAISE EXCEPTION 'the payment reference is fixed once the order leaves pending_payment' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'pending_payment' AND NEW.status IN ('paid', 'cancelled', 'expired')) OR
       (OLD.status = 'expired' AND NEW.status = 'paid') OR
       (OLD.status = 'paid' AND NEW.status = 'refunded')) THEN
    RAISE EXCEPTION 'order transition % -> % is not allowed', OLD.status, NEW.status USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status = 'paid' AND NEW.provider_ref IS NULL THEN
    RAISE EXCEPTION 'a paid order carries its payment reference' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER orders_guard BEFORE UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION orders_guard();

-- ---------- بنود الطلب: ما وافق عليه المشتري مجمّدًا ----------
CREATE TABLE order_items (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id            uuid NOT NULL REFERENCES orders (id),
  listing_id          uuid NOT NULL REFERENCES catalog_listings (id),
  material_id         uuid NOT NULL REFERENCES materials (id),
  material_version    integer NOT NULL,
  license_template_id uuid NOT NULL,
  license_version     integer NOT NULL,
  license_type        text NOT NULL,
  price_minor         bigint NOT NULL,
  currency            text NOT NULL,
  title_ar            text NOT NULL,
  title_en            text NOT NULL,
  FOREIGN KEY (license_template_id, license_version) REFERENCES license_template_versions (template_id, version),
  CONSTRAINT order_items_listing_key UNIQUE (order_id, listing_id),
  CONSTRAINT order_items_version_positive CHECK (material_version >= 1),
  CONSTRAINT order_items_license_type_check
    CHECK (license_type IN ('editorial_single', 'editorial_term', 'exclusive_temporary', 'commercial')),
  CONSTRAINT order_items_price_check CHECK (price_minor BETWEEN 0 AND 100000000000),
  CONSTRAINT order_items_currency_check CHECK (currency IN ('USD', 'ILS')),
  CONSTRAINT order_items_text_len CHECK (char_length(title_ar) BETWEEN 1 AND 4000 AND char_length(title_en) BETWEEN 1 AND 4000)
);
CREATE INDEX order_items_order_idx ON order_items (order_id);
CREATE INDEX order_items_material_idx ON order_items (material_id);

-- البند يطابق العرض الحي لحظة الطلب: إدراج معروض بإصداره، وعرض قائم بالقالب، والإصدار الحالي المفعَّل بنوعه،
-- والسعر الخاص أو الأساسي، وعملة الطلب، وطلب ما زال ينتظر الدفع. ولا بند غير حصري لمادة عليها حجز حصري ساري.
CREATE FUNCTION order_item_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  l record;
  v record;
  o record;
  override_minor bigint;
  override_currency text;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'order items are frozen' USING ERRCODE = 'restrict_violation';
  END IF;
  SELECT status, currency INTO o FROM public.orders WHERE id = NEW.order_id;
  IF o.status IS DISTINCT FROM 'pending_payment' OR o.currency IS DISTINCT FROM NEW.currency THEN
    RAISE EXCEPTION 'items join a pending order in its currency' USING ERRCODE = 'check_violation';
  END IF;
  SELECT material_id, material_version, state INTO l FROM public.catalog_listings WHERE id = NEW.listing_id;
  IF l.state IS DISTINCT FROM 'listed' OR l.material_id IS DISTINCT FROM NEW.material_id
     OR l.material_version IS DISTINCT FROM NEW.material_version THEN
    RAISE EXCEPTION 'an item freezes a listed listing at its material version' USING ERRCODE = 'check_violation';
  END IF;
  SELECT lo.price_override_minor, lo.price_override_currency INTO override_minor, override_currency
    FROM public.listing_offers lo WHERE lo.listing_id = NEW.listing_id AND lo.license_template_id = NEW.license_template_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'an item needs a live offer for its license template' USING ERRCODE = 'check_violation';
  END IF;
  SELECT tv.type, tv.enabled, tv.base_price_minor, tv.currency INTO v
    FROM public.license_template_versions tv
   WHERE tv.template_id = NEW.license_template_id
   ORDER BY tv.version DESC LIMIT 1;
  IF EXISTS (SELECT 1 FROM public.license_template_versions tv
              WHERE tv.template_id = NEW.license_template_id AND tv.version > NEW.license_version)
     OR v.enabled IS NOT TRUE OR v.type IS DISTINCT FROM NEW.license_type THEN
    RAISE EXCEPTION 'an item freezes the current enabled template version and its type' USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW.price_minor, NEW.currency) IS DISTINCT FROM
     (COALESCE(override_minor, v.base_price_minor), COALESCE(override_currency, v.currency)) THEN
    RAISE EXCEPTION 'an item freezes the offer price' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM 1 FROM public.materials m WHERE m.id = NEW.material_id FOR NO KEY UPDATE;  -- يسلسل الحجز والبيع للمادة
  IF NEW.license_type <> 'exclusive_temporary' AND EXISTS (
       SELECT 1 FROM public.exclusive_holds h
        WHERE h.material_id = NEW.material_id
          AND ((h.state = 'held' AND h.held_until > now()) OR (h.state = 'active' AND h.active_until > now()))) THEN
    RAISE EXCEPTION 'the material is under an exclusive hold' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

-- مجموع الطلب مجموع بنوده، وبند واحد على الأقل؛ يُفحص عند الإيداع
CREATE FUNCTION order_total_matches() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  oid uuid;
BEGIN
  IF TG_TABLE_NAME = 'order_items' THEN
    oid := NEW.order_id;
  ELSE
    oid := NEW.id;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.orders o
                  WHERE o.id = oid
                    AND o.total_minor = (SELECT sum(i.price_minor) FROM public.order_items i WHERE i.order_id = oid)) THEN
    RAISE EXCEPTION 'an order total is the sum of its items and it has at least one' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;

-- ---------- حجز الحصرية ----------
-- قائم (held) حتى held_until ≤ 15 دقيقة من إنشائه، ونشط (active) مع الترخيص حتى نهاية الحصرية، ثم محرَّر (released).
CREATE TABLE exclusive_holds (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  material_id   uuid NOT NULL REFERENCES materials (id),
  order_item_id uuid NOT NULL UNIQUE REFERENCES order_items (id),
  state         text NOT NULL DEFAULT 'held',
  held_until    timestamptz NOT NULL,
  active_until  timestamptz,
  released_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT exclusive_holds_state_check CHECK (state IN ('held', 'active', 'released')),
  CONSTRAINT exclusive_holds_window_check CHECK (held_until > created_at AND held_until <= created_at + interval '15 minutes'),
  CONSTRAINT exclusive_holds_active_check CHECK (state <> 'active' OR active_until IS NOT NULL),
  CONSTRAINT exclusive_holds_released_check CHECK ((state = 'released') = (released_at IS NOT NULL))
);
-- قفل الحصرية (ملحق القرارات 19): حجز واحد قائم أو نشط لكل مادة، فإصدار جديد لا يفتح حصرية ثانية
CREATE UNIQUE INDEX exclusive_holds_material_key ON exclusive_holds (material_id) WHERE state IN ('held', 'active');

CREATE FUNCTION exclusive_hold_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'exclusive holds are released, not deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'held' OR NOT EXISTS (
         SELECT 1 FROM public.order_items i
          WHERE i.id = NEW.order_item_id AND i.material_id = NEW.material_id AND i.license_type = 'exclusive_temporary') THEN
      RAISE EXCEPTION 'a hold starts held for an exclusive item of the same material' USING ERRCODE = 'check_violation';
    END IF;
    PERFORM 1 FROM public.materials m WHERE m.id = NEW.material_id FOR NO KEY UPDATE;  -- يسلسل الحجز والبيع للمادة
    -- لا حصرية لمادة سبق بيعها (ترخيص لم يُبطَل)
    IF EXISTS (SELECT 1 FROM public.licenses x WHERE x.material_id = NEW.material_id AND x.status <> 'revoked') THEN
      RAISE EXCEPTION 'a material already licensed cannot be held exclusively' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.material_id, NEW.order_item_id, NEW.held_until, NEW.created_at) IS DISTINCT FROM
     (OLD.material_id, OLD.order_item_id, OLD.held_until, OLD.created_at) THEN
    RAISE EXCEPTION 'a hold keeps its material, item and window' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.state IS DISTINCT FROM OLD.state AND NOT (
       (OLD.state = 'held' AND NEW.state IN ('active', 'released')) OR (OLD.state = 'active' AND NEW.state = 'released')) THEN
    RAISE EXCEPTION 'hold transition % -> % is not allowed', OLD.state, NEW.state USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER exclusive_holds_guard BEFORE INSERT OR UPDATE OR DELETE ON exclusive_holds
  FOR EACH ROW EXECUTE FUNCTION exclusive_hold_guard();

-- ---------- التراخيص الصادرة ----------
CREATE TABLE licenses (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  license_number  text NOT NULL,
  order_item_id   uuid NOT NULL UNIQUE REFERENCES order_items (id),
  organization_id uuid NOT NULL REFERENCES buyer_organizations (id),
  material_id     uuid NOT NULL REFERENCES materials (id),
  license_type    text NOT NULL,
  status          text NOT NULL DEFAULT 'active',
  revoked_reason  text,
  valid_from      timestamptz NOT NULL,
  valid_until     timestamptz,
  exclusive_until timestamptz,
  issued_at       timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  -- رقم عشوائي غير متسلسل لصفحة التحقق العامة، فلا يُعدَّد
  CONSTRAINT licenses_number_check CHECK (license_number ~ '^PH-[0-9]{4}-[0-9A-HJKMNP-TV-Z]{10}$'),
  CONSTRAINT licenses_number_key UNIQUE (license_number),
  CONSTRAINT licenses_license_type_check
    CHECK (license_type IN ('editorial_single', 'editorial_term', 'exclusive_temporary', 'commercial')),
  CONSTRAINT licenses_status_check CHECK (status IN ('active', 'expired', 'revoked')),
  CONSTRAINT licenses_revoked_check CHECK (
    (status = 'revoked') = (revoked_reason IS NOT NULL) AND
    (revoked_reason IS NULL OR revoked_reason IN ('refunded', 'rights_withdrawn', 'manual'))),
  CONSTRAINT licenses_validity_check CHECK (valid_until IS NULL OR valid_until > valid_from),
  CONSTRAINT licenses_exclusive_check CHECK (
    (license_type = 'exclusive_temporary') = (exclusive_until IS NOT NULL) AND
    (exclusive_until IS NULL OR exclusive_until > valid_from))
);
CREATE TRIGGER licenses_set_updated_at BEFORE UPDATE ON licenses
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX licenses_organization_idx ON licenses (organization_id, issued_at DESC, id DESC);
CREATE INDEX licenses_material_idx ON licenses (material_id);

-- يصدر لبند طلب مدفوع بمؤسسته ومادته ونوعه، ولحقوق قابلة للبيع لحظة التأكيد. الحصري يلزمه حجز بنده القائم أو النشط،
-- وغير الحصري لا يصدر والمادة تحت حجز حصري ساري لغيره. بعد الصدور تتغير الحالة وحدها.
CREATE FUNCTION license_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'licenses are revoked, not deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'active' OR NOT EXISTS (
         SELECT 1 FROM public.order_items i JOIN public.orders o ON o.id = i.order_id
          WHERE i.id = NEW.order_item_id AND o.status = 'paid' AND o.organization_id = NEW.organization_id
            AND i.material_id = NEW.material_id AND i.license_type = NEW.license_type) THEN
      RAISE EXCEPTION 'a license is issued active for an item of a paid order' USING ERRCODE = 'check_violation';
    END IF;
    PERFORM 1 FROM public.materials m WHERE m.id = NEW.material_id FOR NO KEY UPDATE;  -- يسلسل الحجز والبيع للمادة
    IF NOT EXISTS (SELECT 1 FROM public.materials m WHERE m.id = NEW.material_id AND m.rights_state = 'sellable') THEN
      RAISE EXCEPTION 'a license needs sellable rights at confirmation' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.license_type = 'exclusive_temporary' THEN
      IF NOT EXISTS (SELECT 1 FROM public.exclusive_holds h
                      WHERE h.order_item_id = NEW.order_item_id AND h.state IN ('held', 'active')) THEN
        RAISE EXCEPTION 'an exclusive license needs its live hold' USING ERRCODE = 'check_violation';
      END IF;
    ELSIF EXISTS (SELECT 1 FROM public.exclusive_holds h
                   WHERE h.material_id = NEW.material_id
                     AND ((h.state = 'held' AND h.held_until > now()) OR (h.state = 'active' AND h.active_until > now()))) THEN
      RAISE EXCEPTION 'the material is under an exclusive hold' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.license_number, NEW.order_item_id, NEW.organization_id, NEW.material_id, NEW.license_type, NEW.valid_from,
      NEW.valid_until, NEW.exclusive_until, NEW.issued_at) IS DISTINCT FROM
     (OLD.license_number, OLD.order_item_id, OLD.organization_id, OLD.material_id, OLD.license_type, OLD.valid_from,
      OLD.valid_until, OLD.exclusive_until, OLD.issued_at) THEN
    RAISE EXCEPTION 'license terms are frozen; only the status changes' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'active' AND NEW.status IN ('expired', 'revoked')) OR (OLD.status = 'expired' AND NEW.status = 'revoked')) THEN
    RAISE EXCEPTION 'license transition % -> % is not allowed', OLD.status, NEW.status USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER licenses_guard BEFORE INSERT OR UPDATE OR DELETE ON licenses
  FOR EACH ROW EXECUTE FUNCTION license_guard();

-- منح التنزيل: يُحصى لكل ترخيص (الحد يفرضه الخادم بقفل صف الترخيص)، والرابط نفسه لا يُخزَّن
CREATE TABLE license_download_grants (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  license_id uuid NOT NULL REFERENCES licenses (id),
  issued_to  uuid NOT NULL REFERENCES users (id),
  issued_at  timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  CONSTRAINT license_download_grants_window_check
    CHECK (expires_at > issued_at AND expires_at <= issued_at + interval '24 hours')
);
CREATE INDEX license_download_grants_license_idx ON license_download_grants (license_id);

-- ---------- إشعارات مزوّد الدفع المستلمة ----------
-- الحقول المتحقق منها وحدها، لا الجسم الخام (قد يحمل بيانات المشتري لدى المزوّد).
CREATE TABLE payment_events (
  provider     text NOT NULL,
  event_id     text NOT NULL,
  type         text NOT NULL,
  provider_ref text NOT NULL,
  amount_minor bigint NOT NULL,
  currency     text NOT NULL,
  occurred_at  timestamptz NOT NULL,
  received_at  timestamptz NOT NULL DEFAULT now(),
  order_id     uuid REFERENCES orders (id),
  outcome      text NOT NULL,
  PRIMARY KEY (provider, event_id),
  CONSTRAINT payment_events_provider_check CHECK (provider ~ '^[a-z_]{1,32}$'),
  CONSTRAINT payment_events_event_id_check CHECK (event_id ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  CONSTRAINT payment_events_type_check
    CHECK (type IN ('payment.succeeded', 'payment.failed', 'refund.succeeded', 'dispute.opened')),
  CONSTRAINT payment_events_provider_ref_check CHECK (char_length(provider_ref) BETWEEN 1 AND 128),
  CONSTRAINT payment_events_amount_check CHECK (amount_minor BETWEEN 0 AND 2000000000000),
  CONSTRAINT payment_events_currency_check CHECK (currency IN ('USD', 'ILS')),
  -- applied: غيّر حالة الطلب؛ ignored: لا أثر (مرجع مجهول أو حالة محسومة)؛ review: للمراجعة (مبلغ لا يطابق مثلًا)
  CONSTRAINT payment_events_outcome_check CHECK (outcome IN ('applied', 'ignored', 'review'))
);
CREATE INDEX payment_events_order_idx ON payment_events (order_id) WHERE order_id IS NOT NULL;
CREATE INDEX payment_events_review_idx ON payment_events (received_at) WHERE outcome = 'review';

-- البند والإشعار المستلم لا يُعدَّلان ولا يُحذفان
CREATE FUNCTION commerce_append_only() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
END $$;
CREATE TRIGGER order_items_guard BEFORE INSERT OR UPDATE OR DELETE ON order_items
  FOR EACH ROW EXECUTE FUNCTION order_item_guard();
CREATE CONSTRAINT TRIGGER order_items_total AFTER INSERT ON order_items
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION order_total_matches();
CREATE CONSTRAINT TRIGGER orders_total AFTER INSERT ON orders
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION order_total_matches();
CREATE TRIGGER payment_events_append_only BEFORE UPDATE OR DELETE ON payment_events
  FOR EACH ROW EXECUTE FUNCTION commerce_append_only();

-- ---------- الأحداث ----------
ALTER TABLE outbox_events DROP CONSTRAINT outbox_events_aggregate_type_check;
ALTER TABLE outbox_events ADD CONSTRAINT outbox_events_aggregate_type_check
  CHECK (aggregate_type IN ('material', 'upload', 'notification', 'form', 'user', 'listing', 'license', 'order'));

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
    'catalog.listing_changed', 'license.delivery_requested'));
ALTER TABLE outbox_events DROP CONSTRAINT outbox_events_aggregate_type_check;
ALTER TABLE outbox_events ADD CONSTRAINT outbox_events_aggregate_type_check
  CHECK (aggregate_type IN ('material', 'upload', 'notification', 'form', 'user', 'listing', 'license'));

DROP TABLE payment_events;
DROP TABLE license_download_grants;
DROP TABLE licenses;
DROP TABLE exclusive_holds;
DROP TABLE order_items;
DROP TABLE orders;
DROP FUNCTION commerce_append_only();
DROP FUNCTION license_guard();
DROP FUNCTION exclusive_hold_guard();
DROP FUNCTION order_total_matches();
DROP FUNCTION order_item_guard();
DROP FUNCTION orders_guard();
