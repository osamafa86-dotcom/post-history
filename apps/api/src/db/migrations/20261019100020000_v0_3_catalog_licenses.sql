-- Up Migration
-- العقد v0.3 التجاري، الجزء الأول (ADR 0025): قوالب التراخيص بإصدارات لا تُعدَّل، وإدراج المادة في الكتالوج وعروضه،
-- ومعاينة المشتري المائية مشتقًا جديدًا، وحدث catalog.listing_changed. الحالات الثلاث للمادة لا تتغير بالإدراج.

-- ---------- قوالب التراخيص ----------
CREATE TABLE license_templates (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL REFERENCES users (id),
  CONSTRAINT license_templates_type_check
    CHECK (type IN ('editorial_single', 'editorial_term', 'exclusive_temporary', 'commercial'))
);

-- كل إصدار سجل لا يُعدَّل ولا يُحذف: البيعة تجمّد الإصدار الذي وافق عليه المشتري.
CREATE TABLE license_template_versions (
  template_id         uuid NOT NULL REFERENCES license_templates (id),
  version             integer NOT NULL,
  type                text NOT NULL,
  name_ar             text NOT NULL,
  name_en             text NOT NULL,
  terms_ar            text NOT NULL,
  terms_en            text NOT NULL,
  usage_media         text[] NOT NULL,
  territory_kind      text NOT NULL,
  territory_countries text[],
  term_days           integer,
  exclusivity_hours   integer,
  deliverables        text[] NOT NULL,
  attribution_ar      text NOT NULL,
  attribution_en      text NOT NULL,
  prohibitions        text[] NOT NULL DEFAULT '{}',
  base_price_minor    bigint NOT NULL,
  currency            text NOT NULL,
  enabled             boolean NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  created_by          uuid NOT NULL REFERENCES users (id),
  PRIMARY KEY (template_id, version),
  CONSTRAINT license_template_versions_version_positive CHECK (version >= 1),
  CONSTRAINT license_template_versions_text_len CHECK (
    char_length(name_ar) BETWEEN 1 AND 4000 AND char_length(name_en) BETWEEN 1 AND 4000 AND
    char_length(terms_ar) BETWEEN 1 AND 4000 AND char_length(terms_en) BETWEEN 1 AND 4000 AND
    char_length(attribution_ar) BETWEEN 1 AND 4000 AND char_length(attribution_en) BETWEEN 1 AND 4000),
  CONSTRAINT license_template_versions_usage_media_check CHECK (
    cardinality(usage_media) >= 1 AND usage_media <@ ARRAY['tv', 'web', 'social', 'documentary', 'advertising']),
  CONSTRAINT license_template_versions_deliverables_check CHECK (
    cardinality(deliverables) >= 1 AND deliverables <@ ARRAY['original', 'produced', 'audio', 'stills', 'transcript']),
  CONSTRAINT license_template_versions_prohibitions_check CHECK (
    prohibitions <@ ARRAY['resale', 'advertising', 'ai_training', 're_editing']),
  CONSTRAINT license_template_versions_territory_check CHECK (
    (territory_kind = 'worldwide' AND territory_countries IS NULL) OR
    (territory_kind = 'countries' AND cardinality(territory_countries) BETWEEN 1 AND 250)),
  CONSTRAINT license_template_versions_term_check CHECK (
    (term_days IS NULL OR term_days BETWEEN 1 AND 3650) AND
    (type NOT IN ('editorial_term', 'exclusive_temporary') OR term_days IS NOT NULL)),
  CONSTRAINT license_template_versions_exclusivity_check CHECK (
    (type = 'exclusive_temporary') = (exclusivity_hours IS NOT NULL) AND
    (exclusivity_hours IS NULL OR exclusivity_hours BETWEEN 24 AND 168)),
  CONSTRAINT license_template_versions_price_check CHECK (base_price_minor BETWEEN 0 AND 100000000000),
  CONSTRAINT license_template_versions_currency_check CHECK (currency IN ('USD', 'ILS'))
);

-- النوع ثابت عبر الإصدارات، والإصدار التالي يلي آخر إصدار بلا فجوة.
CREATE FUNCTION license_template_versions_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  t text;
  last_version integer;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'license template versions are immutable' USING ERRCODE = 'restrict_violation';
  END IF;
  SELECT type INTO t FROM public.license_templates WHERE id = NEW.template_id;
  IF t IS DISTINCT FROM NEW.type THEN
    RAISE EXCEPTION 'license template type cannot change' USING ERRCODE = 'check_violation';
  END IF;
  SELECT max(version) INTO last_version FROM public.license_template_versions WHERE template_id = NEW.template_id;
  IF NEW.version <> COALESCE(last_version, 0) + 1 THEN
    RAISE EXCEPTION 'license template version must follow the last one' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER license_template_versions_guard BEFORE INSERT OR UPDATE OR DELETE ON license_template_versions
  FOR EACH ROW EXECUTE FUNCTION license_template_versions_guard();

-- ---------- الإدراج ----------
CREATE TABLE catalog_listings (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  material_id        uuid NOT NULL UNIQUE REFERENCES materials (id),
  material_version   integer NOT NULL,
  state              text NOT NULL,
  suspended_reason   text,
  title_ar           text NOT NULL,
  title_en           text NOT NULL,
  description_ar     text NOT NULL,
  description_en     text NOT NULL,
  shot_list          jsonb NOT NULL DEFAULT '[]',
  commercial_allowed boolean NOT NULL DEFAULT false,
  listed_at          timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  updated_by         uuid NOT NULL REFERENCES users (id),
  CONSTRAINT catalog_listings_state_check CHECK (state IN ('draft', 'listed', 'suspended')),
  CONSTRAINT catalog_listings_suspended_reason_check CHECK (
    (state = 'suspended') = (suspended_reason IS NOT NULL) AND
    (suspended_reason IS NULL OR suspended_reason IN ('manual', 'rights_changed'))),
  CONSTRAINT catalog_listings_listed_at_check CHECK (state <> 'listed' OR listed_at IS NOT NULL),
  CONSTRAINT catalog_listings_version_positive CHECK (material_version >= 1),
  CONSTRAINT catalog_listings_text_len CHECK (
    char_length(title_ar) BETWEEN 1 AND 4000 AND char_length(title_en) BETWEEN 1 AND 4000 AND
    char_length(description_ar) BETWEEN 1 AND 4000 AND char_length(description_en) BETWEEN 1 AND 4000),
  CONSTRAINT catalog_listings_shot_list_check CHECK (
    jsonb_typeof(shot_list) = 'array' AND jsonb_array_length(shot_list) <= 200)
);
CREATE TRIGGER catalog_listings_set_updated_at BEFORE UPDATE ON catalog_listings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
-- الكتالوج: الإدراجات المعروضة، الأحدث أولًا بالمؤشر.
CREATE INDEX catalog_listings_listed_idx ON catalog_listings (listed_at DESC, id DESC) WHERE state = 'listed';

CREATE TABLE listing_offers (
  listing_id              uuid NOT NULL REFERENCES catalog_listings (id) ON DELETE CASCADE,
  license_template_id     uuid NOT NULL REFERENCES license_templates (id),
  price_override_minor    bigint,
  price_override_currency text,
  PRIMARY KEY (listing_id, license_template_id),
  CONSTRAINT listing_offers_price_override_check CHECK (
    (price_override_minor IS NULL) = (price_override_currency IS NULL) AND
    (price_override_minor IS NULL OR price_override_minor BETWEEN 0 AND 100000000000) AND
    (price_override_currency IS NULL OR price_override_currency IN ('USD', 'ILS')))
);
CREATE INDEX listing_offers_template_idx ON listing_offers (license_template_id);

-- «معروض» يلزمه حقوق قابلة للبيع، من جهتي الإدراج والمادة: الخادم يعلّق الإدراج قبل نقل الحقوق في المعاملة نفسها.
CREATE FUNCTION catalog_listing_rights_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_TABLE_NAME = 'catalog_listings' THEN
    IF NEW.state = 'listed' AND NOT EXISTS (
         SELECT 1 FROM public.materials m WHERE m.id = NEW.material_id AND m.rights_state = 'sellable') THEN
      RAISE EXCEPTION 'a listed material must have sellable rights' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW.rights_state <> 'sellable' AND EXISTS (
         SELECT 1 FROM public.catalog_listings l WHERE l.material_id = NEW.id AND l.state = 'listed') THEN
    RAISE EXCEPTION 'suspend the listing before rights leave sellable' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER catalog_listings_rights_guard BEFORE INSERT OR UPDATE OF state, material_id ON catalog_listings
  FOR EACH ROW EXECUTE FUNCTION catalog_listing_rights_guard();
CREATE TRIGGER materials_listing_rights_guard BEFORE UPDATE OF rights_state ON materials
  FOR EACH ROW EXECUTE FUNCTION catalog_listing_rights_guard();

-- عرض الترخيص التجاري يلزمه إذن صريح على الإدراج.
CREATE FUNCTION listing_offer_commercial_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_TABLE_NAME = 'listing_offers' THEN
    IF EXISTS (SELECT 1 FROM public.license_templates t WHERE t.id = NEW.license_template_id AND t.type = 'commercial')
       AND NOT EXISTS (SELECT 1 FROM public.catalog_listings l WHERE l.id = NEW.listing_id AND l.commercial_allowed) THEN
      RAISE EXCEPTION 'a commercial offer needs commercial_allowed on the listing' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NOT NEW.commercial_allowed AND EXISTS (
         SELECT 1 FROM public.listing_offers o JOIN public.license_templates t ON t.id = o.license_template_id
          WHERE o.listing_id = NEW.id AND t.type = 'commercial') THEN
    RAISE EXCEPTION 'remove the commercial offer before revoking commercial_allowed' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER listing_offers_commercial_guard BEFORE INSERT OR UPDATE ON listing_offers
  FOR EACH ROW EXECUTE FUNCTION listing_offer_commercial_guard();
CREATE TRIGGER catalog_listings_commercial_guard BEFORE UPDATE OF commercial_allowed ON catalog_listings
  FOR EACH ROW EXECUTE FUNCTION listing_offer_commercial_guard();

-- ---------- معاينة المشتري ----------
ALTER TABLE material_files DROP CONSTRAINT material_files_kind_check;
ALTER TABLE material_files ADD CONSTRAINT material_files_kind_check
  CHECK (kind IN ('original', 'proxy', 'hls', 'audio', 'thumbnail', 'voice_note', 'export', 'transcript', 'captions',
                  'watermarked_preview'));

-- ---------- الأحداث والتدقيق ----------
ALTER TABLE outbox_events DROP CONSTRAINT outbox_events_aggregate_type_check;
ALTER TABLE outbox_events ADD CONSTRAINT outbox_events_aggregate_type_check
  CHECK (aggregate_type IN ('material', 'upload', 'notification', 'form', 'user', 'listing'));

ALTER TABLE outbox_events DROP CONSTRAINT outbox_events_type_check;
ALTER TABLE outbox_events ADD CONSTRAINT outbox_events_type_check CHECK (type IN (
    'material.created', 'material.urgent_received', 'material.updated', 'material.version_created',
    'material.technical_transition', 'material.editorial_transition', 'material.rights_transition',
    'material.acknowledged', 'material.change_requested', 'material.accepted_for_production',
    'material.reserved', 'material.released', 'material.contributors_set', 'material.published',
    'upload.started', 'upload.proxy_received', 'upload.original_received', 'upload.verified',
    'upload.deduplicated', 'upload.failed',
    'form.published', 'ai.draft_ready', 'notification.escalated',
    'auth.recovery_requested', 'auth.recovery_approved', 'user.status_changed', 'auth.recovery_completed',
    'export.requested', 'setting.changed',
    'catalog.listing_changed'));

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
    WHEN event_type = 'form.published'          THEN ARRAY['version']
    WHEN event_type = 'ai.draft_ready'          THEN ARRAY['material_id', 'job_id', 'route']
    WHEN event_type = 'notification.escalated'  THEN ARRAY['notification_id', 'material_id', 'priority', 'escalation_level', 'escalated_to']
    WHEN event_type IN ('auth.recovery_requested', 'auth.recovery_approved') THEN ARRAY['recovery_request_id', 'office_id']
    WHEN event_type = 'user.status_changed'     THEN ARRAY['user_id', 'status', 'reason_code', 'actor_id', 'occurred_at']
    WHEN event_type = 'auth.recovery_completed' THEN ARRAY['recovery_request_id', 'office_id']
    WHEN event_type = 'export.requested'        THEN ARRAY['material_id', 'source_file_id', 'requested_by']
    WHEN event_type = 'setting.changed'         THEN ARRAY['setting', 'value', 'actor_id', 'reason_code', 'occurred_at']
    WHEN event_type = 'catalog.listing_changed' THEN ARRAY['listing_id', 'material_id', 'material_version', 'source_file_id', 'state', 'suspended_reason']
    ELSE ARRAY[]::text[]
  END
$$;

CREATE OR REPLACE FUNCTION audit_details_allowed_keys() RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT ARRAY['permission', 'target_user_id', 'material_id', 'file_id', 'upload_session_id', 'field_keys', 'track',
               'from', 'to', 'recovery_request_id', 'session_id', 'installation_id', 'form_version', 'notification_id',
               'result', 'reason_code', 'role', 'scope_kind', 'scope_id', 'approved_by', 'rule_id', 'setting', 'value',
               'listing_id', 'license_template_id', 'license_version']::text[]
$$;

-- Down Migration
CREATE OR REPLACE FUNCTION audit_details_allowed_keys() RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT ARRAY['permission', 'target_user_id', 'material_id', 'file_id', 'upload_session_id', 'field_keys', 'track',
               'from', 'to', 'recovery_request_id', 'session_id', 'installation_id', 'form_version', 'notification_id',
               'result', 'reason_code', 'role', 'scope_kind', 'scope_id', 'approved_by', 'rule_id', 'setting', 'value']::text[]
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
    WHEN event_type = 'form.published'          THEN ARRAY['version']
    WHEN event_type = 'ai.draft_ready'          THEN ARRAY['material_id', 'job_id', 'route']
    WHEN event_type = 'notification.escalated'  THEN ARRAY['notification_id', 'material_id', 'priority', 'escalation_level', 'escalated_to']
    WHEN event_type IN ('auth.recovery_requested', 'auth.recovery_approved') THEN ARRAY['recovery_request_id', 'office_id']
    WHEN event_type = 'user.status_changed'     THEN ARRAY['user_id', 'status', 'reason_code', 'actor_id', 'occurred_at']
    WHEN event_type = 'auth.recovery_completed' THEN ARRAY['recovery_request_id', 'office_id']
    WHEN event_type = 'export.requested'        THEN ARRAY['material_id', 'source_file_id', 'requested_by']
    WHEN event_type = 'setting.changed'         THEN ARRAY['setting', 'value', 'actor_id', 'reason_code', 'occurred_at']
    ELSE ARRAY[]::text[]
  END
$$;

DELETE FROM outbox_events WHERE type = 'catalog.listing_changed';
ALTER TABLE outbox_events DROP CONSTRAINT outbox_events_type_check;
ALTER TABLE outbox_events ADD CONSTRAINT outbox_events_type_check CHECK (type IN (
    'material.created', 'material.urgent_received', 'material.updated', 'material.version_created',
    'material.technical_transition', 'material.editorial_transition', 'material.rights_transition',
    'material.acknowledged', 'material.change_requested', 'material.accepted_for_production',
    'material.reserved', 'material.released', 'material.contributors_set', 'material.published',
    'upload.started', 'upload.proxy_received', 'upload.original_received', 'upload.verified',
    'upload.deduplicated', 'upload.failed',
    'form.published', 'ai.draft_ready', 'notification.escalated',
    'auth.recovery_requested', 'auth.recovery_approved', 'user.status_changed', 'auth.recovery_completed',
    'export.requested', 'setting.changed'));

ALTER TABLE outbox_events DROP CONSTRAINT outbox_events_aggregate_type_check;
ALTER TABLE outbox_events ADD CONSTRAINT outbox_events_aggregate_type_check
  CHECK (aggregate_type IN ('material', 'upload', 'notification', 'form', 'user'));

DELETE FROM material_files WHERE kind = 'watermarked_preview';
ALTER TABLE material_files DROP CONSTRAINT material_files_kind_check;
ALTER TABLE material_files ADD CONSTRAINT material_files_kind_check
  CHECK (kind IN ('original', 'proxy', 'hls', 'audio', 'thumbnail', 'voice_note', 'export', 'transcript', 'captions'));

DROP TRIGGER materials_listing_rights_guard ON materials;
DROP TABLE listing_offers;
DROP TABLE catalog_listings;
DROP FUNCTION listing_offer_commercial_guard();
DROP FUNCTION catalog_listing_rights_guard();
DROP TABLE license_template_versions;
DROP TABLE license_templates;
DROP FUNCTION license_template_versions_guard();
