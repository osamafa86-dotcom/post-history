-- Up Migration
-- مفاتيح App Attest لكل تثبيت (SEC-07، ADR 0011 و0012). key_id معرّف تثبيت = بيانات كاشفة: يُخزَّن ببصمته فقط
-- (sha256) ولا يُسجَّل. العدّاد يجب أن يتزايد مع كل تأكيد؛ غير المتزايد = إعادة تشغيل (409 assertion_replay).

CREATE TABLE device_attestation_keys (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),   -- key_ref في العقد
  user_id       uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  platform      text NOT NULL DEFAULT 'ios',
  key_id_hash   bytea NOT NULL,
  public_key    bytea NOT NULL,                               -- المفتاح العام من الشهادة (ليس سرًا)
  sign_count    bigint NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz,
  revoked_at    timestamptz,
  CONSTRAINT device_attestation_keys_platform_check CHECK (platform IN ('ios')),
  CONSTRAINT device_attestation_keys_key_id_hash_len CHECK (octet_length(key_id_hash) = 32),
  CONSTRAINT device_attestation_keys_sign_count_nonneg CHECK (sign_count >= 0),
  -- المفتاح الواحد لمستخدم واحد؛ تسجيله لآخر = 409 attestation_key_conflict
  CONSTRAINT device_attestation_keys_key_id_hash_key UNIQUE (key_id_hash)
);
CREATE INDEX device_attestation_keys_user_active_idx ON device_attestation_keys (user_id) WHERE revoked_at IS NULL;

-- العدّاد لا يتراجع ولا يثبت على التحديث (حماية من إعادة التشغيل حتى لو أخطأ الكود)
CREATE FUNCTION device_attestation_keys_counter_monotonic() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.sign_count < OLD.sign_count OR (NEW.sign_count = OLD.sign_count AND NEW.last_used_at IS DISTINCT FROM OLD.last_used_at) THEN
    RAISE EXCEPTION 'App Attest counter must increase (key %)', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'device_attestation_keys_counter_monotonic';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER device_attestation_keys_counter_monotonic BEFORE UPDATE OF sign_count, last_used_at ON device_attestation_keys
  FOR EACH ROW EXECUTE FUNCTION device_attestation_keys_counter_monotonic();

-- Down Migration
DROP TABLE device_attestation_keys;
DROP FUNCTION device_attestation_keys_counter_monotonic();
