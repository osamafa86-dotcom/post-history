-- Up Migration
-- أدوات مشتركة: دالة updated_at، وقائمة أنواع المواد المعتمدة (تطابق contracts/openapi.yaml).
-- لا أنواع ENUM في Postgres: القيم نصوص بقيود CHECK مسماة حتى يكون توسيعها ترحيلًا صريحًا لا تغييرًا للنوع.

CREATE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

CREATE FUNCTION allowed_material_types() RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT ARRAY['breaking','report','interview','raw_footage','aerial','press_conference','eyewitness','photos']::text[]
$$;

-- Down Migration
DROP FUNCTION allowed_material_types();
DROP FUNCTION set_updated_at();
