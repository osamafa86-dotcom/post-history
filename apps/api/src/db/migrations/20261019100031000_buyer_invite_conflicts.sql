-- Up Migration
-- دعوة عضو مشترٍ ببريد حساب قائم خارج المؤسسة ترد كالدعوة الناجحة تمامًا، فلا تكشف هل البريد لمراسل أو لطاقم
-- (متابعة أمنية لـ #304 بأمر المنسّق). يُكتب «عضو مدعو» بديل يظهر في قائمة الأعضاء ويُحسب في المقاعد، ويحسم مدير
-- النظام التعارض بالحالة وحدها، بلا ملاحظة نصية. معرّف الصف هو user_id الظاهر للعضو المدعو.

CREATE TABLE buyer_invite_conflicts (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid NOT NULL REFERENCES buyer_organizations (id),
  email             text NOT NULL,
  existing_user_id  uuid NOT NULL REFERENCES users (id),
  role              text NOT NULL,
  state             text NOT NULL DEFAULT 'pending',
  invited_by        uuid NOT NULL REFERENCES users (id),
  invite_expires_at timestamptz NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  resolved_at       timestamptz,
  resolved_by       uuid REFERENCES users (id),
  CONSTRAINT buyer_invite_conflicts_role_check CHECK (role IN ('buyer_admin', 'buyer_member')),
  CONSTRAINT buyer_invite_conflicts_state_check CHECK (state IN ('pending', 'suspended', 'dismissed')),
  CONSTRAINT buyer_invite_conflicts_email_check CHECK (char_length(email) BETWEEN 3 AND 254),
  CONSTRAINT buyer_invite_conflicts_expiry_check CHECK (invite_expires_at > created_at),
  CONSTRAINT buyer_invite_conflicts_resolved_check CHECK (
    (state = 'dismissed') = (resolved_at IS NOT NULL) AND (resolved_at IS NULL) = (resolved_by IS NULL))
);
CREATE TRIGGER buyer_invite_conflicts_set_updated_at BEFORE UPDATE ON buyer_invite_conflicts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
-- دعوة مفتوحة واحدة لكل بريد في المؤسسة، بلا تمييز لحالة الأحرف
CREATE UNIQUE INDEX buyer_invite_conflicts_open_email ON buyer_invite_conflicts (organization_id, lower(email))
  WHERE state <> 'dismissed';
CREATE INDEX buyer_invite_conflicts_pending ON buyer_invite_conflicts (created_at) WHERE state = 'pending';

-- conflict_id لحدثي التدقيق buyer_member.invite_conflict وbuyer_member.invite_conflict_resolved
CREATE OR REPLACE FUNCTION audit_details_allowed_keys() RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT ARRAY['permission', 'target_user_id', 'material_id', 'file_id', 'upload_session_id', 'field_keys', 'track',
               'from', 'to', 'recovery_request_id', 'session_id', 'installation_id', 'form_version', 'notification_id',
               'result', 'reason_code', 'role', 'scope_kind', 'scope_id', 'approved_by', 'rule_id', 'setting', 'value',
               'listing_id', 'license_template_id', 'license_version', 'organization_id', 'conflict_id']::text[]
$$;

-- Down Migration
CREATE OR REPLACE FUNCTION audit_details_allowed_keys() RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT ARRAY['permission', 'target_user_id', 'material_id', 'file_id', 'upload_session_id', 'field_keys', 'track',
               'from', 'to', 'recovery_request_id', 'session_id', 'installation_id', 'form_version', 'notification_id',
               'result', 'reason_code', 'role', 'scope_kind', 'scope_id', 'approved_by', 'rule_id', 'setting', 'value',
               'listing_id', 'license_template_id', 'license_version', 'organization_id']::text[]
$$;

DROP TABLE buyer_invite_conflicts;
