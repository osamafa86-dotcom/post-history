-- Up Migration
-- العقد v0.3، الجزء 3 (ADR 0025): مؤسسات المشترين وأعضاؤها. دورا buyer_admin وbuyer_member نطاقهما مؤسستهم وحدها
-- (scope_kind = 'organization')، ولا يجمع حساب دور طاقم ودور مشترٍ. حد المقاعد يفرضه الخادم عند الدعوة.

CREATE TABLE buyer_organizations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legal_name      text NOT NULL,
  display_name_ar text NOT NULL,
  display_name_en text NOT NULL,
  country         text NOT NULL,
  billing_email   text NOT NULL,
  seats           integer NOT NULL DEFAULT 5,
  status          text NOT NULL DEFAULT 'pending_verification',
  verified_at     timestamptz,
  verified_by     uuid,                                   -- من فعّلها (بلا مفتاح أجنبي يدور مع users.organization_id؛ التدقيق يثبته)
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT buyer_organizations_status_check CHECK (status IN ('pending_verification', 'active', 'suspended')),
  CONSTRAINT buyer_organizations_verified_check CHECK (
    (status = 'pending_verification' OR verified_at IS NOT NULL) AND ((verified_at IS NULL) = (verified_by IS NULL))),
  CONSTRAINT buyer_organizations_country_check CHECK (country ~ '^[A-Z]{2}$'),
  CONSTRAINT buyer_organizations_seats_check CHECK (seats BETWEEN 1 AND 1000),
  CONSTRAINT buyer_organizations_text_len CHECK (
    char_length(legal_name) BETWEEN 1 AND 200 AND char_length(display_name_ar) BETWEEN 1 AND 4000 AND
    char_length(display_name_en) BETWEEN 1 AND 4000 AND char_length(billing_email) BETWEEN 3 AND 254)
);
CREATE TRIGGER buyer_organizations_set_updated_at BEFORE UPDATE ON buyer_organizations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX buyer_organizations_list_idx ON buyer_organizations (created_at DESC, id DESC);

-- حساب المشتري مرتبط بمؤسسته ولا مكتب له، والارتباط لا يتغير بعد إنشائه.
ALTER TABLE users ADD COLUMN organization_id uuid REFERENCES buyer_organizations (id);
ALTER TABLE users ADD CONSTRAINT users_buyer_no_office CHECK (organization_id IS NULL OR office_id IS NULL);
CREATE INDEX users_organization_idx ON users (organization_id) WHERE organization_id IS NOT NULL;

ALTER TABLE user_roles DROP CONSTRAINT user_roles_role_check;
ALTER TABLE user_roles ADD CONSTRAINT user_roles_role_check CHECK (role IN (
  'system_admin', 'editor_in_chief', 'supervisor', 'producer', 'finance', 'reporter', 'rights_officer',
  'buyer_admin', 'buyer_member'));
ALTER TABLE user_roles DROP CONSTRAINT user_roles_scope_kind_check;
ALTER TABLE user_roles ADD CONSTRAINT user_roles_scope_kind_check
  CHECK (scope_kind IN ('all', 'office', 'governorate', 'organization'));
ALTER TABLE user_roles ADD CONSTRAINT user_roles_buyer_scope_check
  CHECK ((role IN ('buyer_admin', 'buyer_member')) = (scope_kind = 'organization'));

-- دور المشتري لحساب مؤسسته وبنطاقها وحده، ودور الطاقم لحساب بلا مؤسسة.
CREATE FUNCTION user_roles_buyer_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  org uuid;
BEGIN
  IF TG_TABLE_NAME = 'users' THEN
    IF OLD.organization_id IS DISTINCT FROM NEW.organization_id
       AND (OLD.organization_id IS NOT NULL OR EXISTS (SELECT 1 FROM public.user_roles r WHERE r.user_id = NEW.id)) THEN
      RAISE EXCEPTION 'a user''s organization cannot change once set or once roles exist' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  SELECT u.organization_id INTO org FROM public.users u WHERE u.id = NEW.user_id;
  IF NEW.scope_kind = 'organization' THEN
    IF org IS NULL OR NEW.scope_id <> org::text THEN
      RAISE EXCEPTION 'a buyer role is scoped to the user''s own organization' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF org IS NOT NULL THEN
    RAISE EXCEPTION 'a buyer account cannot hold a staff role' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER user_roles_buyer_guard BEFORE INSERT OR UPDATE ON user_roles
  FOR EACH ROW EXECUTE FUNCTION user_roles_buyer_guard();
CREATE TRIGGER users_organization_guard BEFORE UPDATE OF organization_id ON users
  FOR EACH ROW EXECUTE FUNCTION user_roles_buyer_guard();

CREATE OR REPLACE FUNCTION audit_details_allowed_keys() RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT ARRAY['permission', 'target_user_id', 'material_id', 'file_id', 'upload_session_id', 'field_keys', 'track',
               'from', 'to', 'recovery_request_id', 'session_id', 'installation_id', 'form_version', 'notification_id',
               'result', 'reason_code', 'role', 'scope_kind', 'scope_id', 'approved_by', 'rule_id', 'setting', 'value',
               'listing_id', 'license_template_id', 'license_version', 'organization_id']::text[]
$$;

-- Down Migration
CREATE OR REPLACE FUNCTION audit_details_allowed_keys() RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT ARRAY['permission', 'target_user_id', 'material_id', 'file_id', 'upload_session_id', 'field_keys', 'track',
               'from', 'to', 'recovery_request_id', 'session_id', 'installation_id', 'form_version', 'notification_id',
               'result', 'reason_code', 'role', 'scope_kind', 'scope_id', 'approved_by', 'rule_id', 'setting', 'value',
               'listing_id', 'license_template_id', 'license_version']::text[]
$$;

DROP TRIGGER users_organization_guard ON users;
DROP TRIGGER user_roles_buyer_guard ON user_roles;
DROP FUNCTION user_roles_buyer_guard();

DELETE FROM user_roles WHERE scope_kind = 'organization';
ALTER TABLE user_roles DROP CONSTRAINT user_roles_buyer_scope_check;
ALTER TABLE user_roles DROP CONSTRAINT user_roles_scope_kind_check;
ALTER TABLE user_roles ADD CONSTRAINT user_roles_scope_kind_check CHECK (scope_kind IN ('all', 'office', 'governorate'));
ALTER TABLE user_roles DROP CONSTRAINT user_roles_role_check;
ALTER TABLE user_roles ADD CONSTRAINT user_roles_role_check CHECK (role IN (
  'system_admin', 'editor_in_chief', 'supervisor', 'producer', 'finance', 'reporter', 'rights_officer'));

DROP INDEX users_organization_idx;
ALTER TABLE users DROP CONSTRAINT users_buyer_no_office;
ALTER TABLE users DROP COLUMN organization_id;
DROP TABLE buyer_organizations;
