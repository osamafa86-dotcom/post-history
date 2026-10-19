-- Up Migration
-- الهوية: المكاتب، المستخدمون، الأدوار بنطاقاتها، رموز التحديث، الاسترداد، أجهزة الدفع، مفاتيح منع التكرار.
-- الأسرار (كلمات المرور، TOTP، رموز الدفع) لا تُخزَّن إلا مُجزَّأة أو مشفرة على مستوى الحقل بمفتاح التطبيق.

CREATE TABLE offices (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name_ar     text NOT NULL,
  name_en     text NOT NULL,
  governorate text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email            text NOT NULL,
  password_hash    text NOT NULL,                 -- argon2id؛ لا كلمة مرور خامًا أبدًا
  totp_secret_enc  bytea,                         -- مشفر على مستوى الحقل؛ NULL قبل التفعيل
  totp_enabled     boolean NOT NULL DEFAULT false,
  status           text NOT NULL DEFAULT 'active',
  office_id        uuid REFERENCES offices (id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  last_login_at    timestamptz,
  CONSTRAINT users_status_check CHECK (status IN ('active', 'suspended', 'recovery')),
  CONSTRAINT users_totp_consistent CHECK (NOT totp_enabled OR totp_secret_enc IS NOT NULL)
);
CREATE UNIQUE INDEX users_email_lower_key ON users (lower(email));
CREATE INDEX users_office_idx ON users (office_id) WHERE office_id IS NOT NULL;
CREATE TRIGGER users_set_updated_at BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- دور واحد قد يُمنح لأكثر من نطاق (مشرف على مكتبين). scope_kind = 'all' لمدير النظام ورئيس التحرير.
CREATE TABLE user_roles (
  user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role       text NOT NULL,
  scope_kind text NOT NULL DEFAULT 'all',
  scope_id   text NOT NULL DEFAULT '',
  granted_at timestamptz NOT NULL DEFAULT now(),
  granted_by uuid REFERENCES users (id),
  PRIMARY KEY (user_id, role, scope_kind, scope_id),
  CONSTRAINT user_roles_role_check CHECK (role IN (
    'system_admin', 'editor_in_chief', 'supervisor', 'producer', 'finance', 'reporter', 'rights_officer')),
  CONSTRAINT user_roles_scope_kind_check CHECK (scope_kind IN ('all', 'office', 'governorate')),
  CONSTRAINT user_roles_scope_id_check CHECK ((scope_kind = 'all') = (scope_id = ''))
);
CREATE INDEX user_roles_scope_idx ON user_roles (role, scope_kind, scope_id);

-- رموز التحديث تُدوَّر: كل تحديث يبطل الرمز ويشير إلى بديله. إبطال كل الجلسات = revoked_at لكل رموز المستخدم.
CREATE TABLE refresh_tokens (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash      bytea NOT NULL UNIQUE,          -- sha256 للرمز؛ الرمز نفسه لا يُخزَّن
  installation_id uuid,                           -- معرّف التثبيت الذي ولّده التطبيق؛ ليس معرّف جهاز
  platform        text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  last_seen_at    timestamptz,
  expires_at      timestamptz NOT NULL,
  revoked_at      timestamptz,
  replaced_by     uuid REFERENCES refresh_tokens (id),
  CONSTRAINT refresh_tokens_hash_len CHECK (octet_length(token_hash) = 32),
  CONSTRAINT refresh_tokens_platform_check CHECK (platform IS NULL OR platform IN ('ios', 'android', 'web'))
);
CREATE INDEX refresh_tokens_user_active_idx ON refresh_tokens (user_id) WHERE revoked_at IS NULL;

CREATE TABLE recovery_codes (
  user_id   uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  code_hash bytea NOT NULL,
  used_at   timestamptz,
  PRIMARY KEY (user_id, code_hash),
  CONSTRAINT recovery_codes_hash_len CHECK (octet_length(code_hash) = 32)
);

CREATE TABLE recovery_requests (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  state             text NOT NULL DEFAULT 'pending_approval',
  approved_by       uuid REFERENCES users (id),
  verification_note text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  decided_at        timestamptz,
  expires_at        timestamptz NOT NULL,
  CONSTRAINT recovery_requests_state_check CHECK (state IN ('pending_approval', 'approved', 'rejected', 'expired')),
  CONSTRAINT recovery_requests_decision_consistent CHECK (
    (state = 'pending_approval' AND decided_at IS NULL) OR (state <> 'pending_approval' AND decided_at IS NOT NULL)),
  CONSTRAINT recovery_requests_approved_by_note CHECK (state <> 'approved' OR (approved_by IS NOT NULL AND verification_note IS NOT NULL))
);
CREATE INDEX recovery_requests_pending_idx ON recovery_requests (user_id, created_at DESC) WHERE state = 'pending_approval';

-- installation_id يولّده التطبيق؛ ليس معرّف جهاز. رمز الدفع مشفر ولا يُقرأ إلا من المُرسل.
CREATE TABLE push_devices (
  installation_id uuid PRIMARY KEY,
  user_id         uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  platform        text NOT NULL,
  token_enc       bytea NOT NULL,
  app_version     text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  revoked_at      timestamptz,
  CONSTRAINT push_devices_platform_check CHECK (platform IN ('ios', 'android', 'web'))
);
CREATE INDEX push_devices_user_active_idx ON push_devices (user_id) WHERE revoked_at IS NULL;
CREATE TRIGGER push_devices_set_updated_at BEFORE UPDATE ON push_devices
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- مفتاح منع التكرار مقيّد بالمستخدم. التكرار بالجسم نفسه يعيد response_*؛ بجسم مختلف يُرفض (422)؛
-- وما زال in_progress يُرفض (409). تُحذف المفاتيح بعد expires_at (24 ساعة).
CREATE TABLE idempotency_keys (
  user_id             uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  key                 text NOT NULL,
  request_fingerprint bytea NOT NULL,            -- sha256(method || path || body)
  state               text NOT NULL DEFAULT 'in_progress',
  response_status     smallint,
  response_body       jsonb,
  created_at          timestamptz NOT NULL DEFAULT now(),
  expires_at          timestamptz NOT NULL DEFAULT now() + interval '24 hours',
  PRIMARY KEY (user_id, key),
  CONSTRAINT idempotency_keys_key_len CHECK (char_length(key) BETWEEN 8 AND 128),
  CONSTRAINT idempotency_keys_state_check CHECK (state IN ('in_progress', 'completed')),
  CONSTRAINT idempotency_keys_completed_has_response CHECK (state <> 'completed' OR response_status IS NOT NULL)
);
CREATE INDEX idempotency_keys_expires_idx ON idempotency_keys (expires_at);
COMMENT ON COLUMN idempotency_keys.response_body IS
  'جسم الاستجابة المحفوظ للتكرار. لا يُحفظ لأي مسار يعيد رمزًا (مسارات /auth/* لا تقبل Idempotency-Key أصلًا).';

-- Down Migration
DROP TABLE idempotency_keys;
DROP TABLE push_devices;
DROP TABLE recovery_requests;
DROP TABLE recovery_codes;
DROP TABLE refresh_tokens;
DROP TABLE user_roles;
DROP TABLE users;
DROP TABLE offices;
