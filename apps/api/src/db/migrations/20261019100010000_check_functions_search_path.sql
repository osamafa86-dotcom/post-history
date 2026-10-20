-- Up Migration
-- دوال قيود CHECK تعمل مع search_path فارغ (#71): pg_restore يستعيد البيانات بـ search_path فارغ ويطبّق قيود CHECK
-- (وهي جزء من تعريف الجدول) على كل صف، فكانت الدوال الثلاث تفشل لأنها تستدعي دالة قائمة المفاتيح باسم غير مؤهل،
-- فيُرفض كل صف (0 من 20 في outbox_events في تمرين الاستعادة). الاستدعاء صار مؤهَّلًا بـ public. والدالة مثبّتة بـ
-- search_path = public, pg_temp. بقية الدوال: allowed_material_types() يُستدعى من القيد مباشرة (مرجع بالمعرّف) ولا
-- يستدعي شيئًا؛ دوال المحفّزات تُنشأ بعد البيانات في pg_restore فلا تُنفَّذ أثناءها.

CREATE OR REPLACE FUNCTION outbox_payload_is_whitelisted(event_type text, payload jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path = public, pg_temp
AS $$
  SELECT jsonb_typeof(payload) = 'object'
     AND NOT EXISTS (
       SELECT 1 FROM jsonb_object_keys(payload) AS k
       WHERE NOT (k = ANY (public.outbox_payload_allowed_keys(event_type))))
$$;

CREATE OR REPLACE FUNCTION audit_details_is_whitelisted(details jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path = public, pg_temp
AS $$
  SELECT jsonb_typeof(details) = 'object'
     AND NOT EXISTS (SELECT 1 FROM jsonb_object_keys(details) AS k WHERE NOT (k = ANY (public.audit_details_allowed_keys())))
$$;

CREATE OR REPLACE FUNCTION material_file_technical_is_whitelisted(t jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path = public, pg_temp
AS $$
  SELECT jsonb_typeof(t) = 'object'
     AND NOT EXISTS (SELECT 1 FROM jsonb_object_keys(t) AS k WHERE k <> ALL (public.material_file_technical_keys()))
$$;

-- Down Migration
CREATE OR REPLACE FUNCTION material_file_technical_is_whitelisted(t jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT jsonb_typeof(t) = 'object'
     AND NOT EXISTS (SELECT 1 FROM jsonb_object_keys(t) AS k WHERE k <> ALL (material_file_technical_keys()))
$$;
ALTER FUNCTION material_file_technical_is_whitelisted(jsonb) RESET search_path;

CREATE OR REPLACE FUNCTION audit_details_is_whitelisted(details jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT jsonb_typeof(details) = 'object'
     AND NOT EXISTS (SELECT 1 FROM jsonb_object_keys(details) AS k WHERE NOT (k = ANY (audit_details_allowed_keys())))
$$;
ALTER FUNCTION audit_details_is_whitelisted(jsonb) RESET search_path;

CREATE OR REPLACE FUNCTION outbox_payload_is_whitelisted(event_type text, payload jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT jsonb_typeof(payload) = 'object'
     AND NOT EXISTS (
       SELECT 1 FROM jsonb_object_keys(payload) AS k
       WHERE NOT (k = ANY (outbox_payload_allowed_keys(event_type))))
$$;
ALTER FUNCTION outbox_payload_is_whitelisted(text, jsonb) RESET search_path;
