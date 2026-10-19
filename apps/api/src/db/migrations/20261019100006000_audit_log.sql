-- Up Migration
-- سجل تدقيق إلحاقي بسلسلة تجزئة: كل صف يحمل تجزئة الصف السابق، ولا تحديث ولا حذف.
-- النسخة الدورية إلى تخزين بقفل كائنات مسؤولية البنية (خارج هذا المخطط).

CREATE TABLE audit_log (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at     timestamptz NOT NULL DEFAULT now(),
  actor_id        uuid,                               -- لا FK: يبقى السجل بعد حذف الحساب
  action          text NOT NULL,
  target_type     text,
  target_id       text,
  installation_id uuid,
  details         jsonb NOT NULL DEFAULT '{}'::jsonb,  -- لا أسرار ولا بيانات كاشفة
  prev_hash       bytea,
  hash            bytea NOT NULL,
  CONSTRAINT audit_log_action_nonempty CHECK (char_length(action) BETWEEN 1 AND 128),
  CONSTRAINT audit_log_details_is_object CHECK (jsonb_typeof(details) = 'object'),
  CONSTRAINT audit_log_hash_len CHECK (octet_length(hash) = 32),
  CONSTRAINT audit_log_prev_hash_len CHECK (prev_hash IS NULL OR octet_length(prev_hash) = 32)
);
CREATE INDEX audit_log_actor_idx ON audit_log (actor_id, id) WHERE actor_id IS NOT NULL;
CREATE INDEX audit_log_target_idx ON audit_log (target_type, target_id, id);

CREATE FUNCTION audit_log_chain() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  last_hash bytea;
BEGIN
  -- تسلسل الكتابة حتى لا يتفرع التسلسل بين معاملتين متزامنتين
  PERFORM pg_advisory_xact_lock(hashtext('audit_log_chain'));
  SELECT hash INTO last_hash FROM audit_log ORDER BY id DESC LIMIT 1;
  NEW.prev_hash := last_hash;
  NEW.occurred_at := COALESCE(NEW.occurred_at, now());
  NEW.hash := sha256(
    COALESCE(last_hash, '\x00'::bytea)
    || convert_to(
         to_char(NEW.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') || '|'
         || COALESCE(NEW.actor_id::text, '') || '|' || NEW.action || '|'
         || COALESCE(NEW.target_type, '') || '|' || COALESCE(NEW.target_id, '') || '|'
         || COALESCE(NEW.installation_id::text, '') || '|' || NEW.details::text,
         'UTF8'));
  RETURN NEW;
END $$;

CREATE TRIGGER audit_log_chain BEFORE INSERT ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_chain();

CREATE FUNCTION audit_log_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only'
    USING ERRCODE = 'insufficient_privilege', CONSTRAINT = 'audit_log_append_only';
END $$;

CREATE TRIGGER audit_log_no_update BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION audit_log_immutable();

-- Down Migration
DROP TABLE audit_log;
DROP FUNCTION audit_log_immutable();
DROP FUNCTION audit_log_chain();
