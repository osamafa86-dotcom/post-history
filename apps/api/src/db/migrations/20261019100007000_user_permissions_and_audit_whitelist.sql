-- Up Migration
-- الصلاحيتان المستقلتان (قرار المالك 2026-10-19، ADR SEC-03): تُمنحان لمستخدم بعينه لا لدور، بلا منح افتراضي.
-- كل منح وسحب يُسجَّل في audit_log بمحفّز. وقائمة بيضاء لمفاتيح audit_log.details (ملاحظة وكيل الأمن 15 على الطلب 4).

CREATE TABLE user_permissions (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  permission text NOT NULL,
  granted_by uuid NOT NULL REFERENCES users (id),
  granted_at timestamptz NOT NULL DEFAULT now(),
  reason     text NOT NULL,
  revoked_by uuid REFERENCES users (id),
  revoked_at timestamptz,
  CONSTRAINT user_permissions_permission_check CHECK (permission IN ('sensitive_location:read', 'protected_source:read')),
  CONSTRAINT user_permissions_reason_len CHECK (char_length(reason) BETWEEN 1 AND 500),
  CONSTRAINT user_permissions_revoke_consistent CHECK ((revoked_by IS NULL) = (revoked_at IS NULL)),
  CONSTRAINT user_permissions_revoked_after_granted CHECK (revoked_at IS NULL OR revoked_at >= granted_at)
);
-- منحة نشطة واحدة لكل (مستخدم، صلاحية)؛ السجل التاريخي يبقى بعد السحب
CREATE UNIQUE INDEX user_permissions_active_key ON user_permissions (user_id, permission) WHERE revoked_at IS NULL;
CREATE INDEX user_permissions_user_idx ON user_permissions (user_id) WHERE revoked_at IS NULL;

-- قائمة بيضاء لمفاتيح تفاصيل التدقيق: معرّفات وأسماء ثابتة فقط، لا نص حر ولا أسرار ولا بيانات كاشفة
CREATE FUNCTION audit_details_allowed_keys() RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT ARRAY['permission', 'target_user_id', 'material_id', 'file_id', 'upload_session_id', 'field_keys', 'track',
               'from', 'to', 'recovery_request_id', 'session_id', 'installation_id', 'form_version', 'notification_id',
               'result', 'reason_code', 'role', 'scope_kind', 'scope_id']::text[]
$$;

CREATE FUNCTION audit_details_is_whitelisted(details jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT jsonb_typeof(details) = 'object'
     AND NOT EXISTS (SELECT 1 FROM jsonb_object_keys(details) AS k WHERE NOT (k = ANY (audit_details_allowed_keys())))
$$;

ALTER TABLE audit_log
  ADD CONSTRAINT audit_log_details_whitelisted CHECK (audit_details_is_whitelisted(details));

-- المنح والسحب يكتبان سجل تدقيق داخل المعاملة نفسها
CREATE FUNCTION user_permissions_audit() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO audit_log (actor_id, action, target_type, target_id, details)
    VALUES (NEW.granted_by, 'permission.granted', 'user', NEW.user_id::text,
            jsonb_build_object('permission', NEW.permission, 'target_user_id', NEW.user_id));
    RETURN NEW;
  END IF;
  -- UPDATE: السماح فقط بتحويل منحة نشطة إلى مسحوبة؛ لا تعديل آخر
  IF OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL
     OR NEW.user_id <> OLD.user_id OR NEW.permission <> OLD.permission
     OR NEW.granted_by <> OLD.granted_by OR NEW.granted_at <> OLD.granted_at OR NEW.reason <> OLD.reason THEN
    RAISE EXCEPTION 'user_permissions rows may only be revoked, not edited'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'user_permissions_revoke_only';
  END IF;
  INSERT INTO audit_log (actor_id, action, target_type, target_id, details)
  VALUES (NEW.revoked_by, 'permission.revoked', 'user', NEW.user_id::text,
          jsonb_build_object('permission', NEW.permission, 'target_user_id', NEW.user_id));
  RETURN NEW;
END $$;

CREATE TRIGGER user_permissions_audit AFTER INSERT OR UPDATE ON user_permissions
  FOR EACH ROW EXECUTE FUNCTION user_permissions_audit();

CREATE FUNCTION user_permissions_no_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'user_permissions is append-only; revoke instead of delete'
    USING ERRCODE = 'insufficient_privilege', CONSTRAINT = 'user_permissions_no_delete';
END $$;

CREATE TRIGGER user_permissions_no_delete BEFORE DELETE ON user_permissions
  FOR EACH ROW EXECUTE FUNCTION user_permissions_no_delete();

-- Down Migration
DROP TRIGGER user_permissions_no_delete ON user_permissions;
DROP FUNCTION user_permissions_no_delete();
DROP TRIGGER user_permissions_audit ON user_permissions;
DROP FUNCTION user_permissions_audit();
ALTER TABLE audit_log DROP CONSTRAINT audit_log_details_whitelisted;
DROP FUNCTION audit_details_is_whitelisted(jsonb);
DROP FUNCTION audit_details_allowed_keys();
DROP TABLE user_permissions;
