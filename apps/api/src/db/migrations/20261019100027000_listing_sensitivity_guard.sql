-- Up Migration
-- المادة الموسومة بالحساسية (قاصرون، مصابون، مشاهد صادمة) لا تُعرض في الكتالوج، من جهتي الإدراج والمادة.
-- الخادم يعلّق الإدراج أولًا (`sensitive_flagged`) في معاملة الوسم نفسها، ويرد 422 قبل القاعدة.

ALTER TABLE catalog_listings DROP CONSTRAINT catalog_listings_suspended_reason_check;
ALTER TABLE catalog_listings ADD CONSTRAINT catalog_listings_suspended_reason_check CHECK (
  (state = 'suspended') = (suspended_reason IS NOT NULL) AND
  (suspended_reason IS NULL OR suspended_reason IN ('manual', 'rights_changed', 'sensitive_flagged')));

CREATE FUNCTION catalog_listing_sensitivity_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_TABLE_NAME = 'catalog_listings' THEN
    IF NEW.state = 'listed' AND EXISTS (
         SELECT 1 FROM public.materials m WHERE m.id = NEW.material_id
            AND (m.sensitivity_minors OR m.sensitivity_injured OR m.sensitivity_graphic)) THEN
      RAISE EXCEPTION 'a listed material must carry no sensitivity flag' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF (NEW.sensitivity_minors OR NEW.sensitivity_injured OR NEW.sensitivity_graphic) AND EXISTS (
         SELECT 1 FROM public.catalog_listings l WHERE l.material_id = NEW.id AND l.state = 'listed') THEN
    RAISE EXCEPTION 'suspend the listing before flagging the material sensitive' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER catalog_listings_sensitivity_guard BEFORE INSERT OR UPDATE OF state, material_id ON catalog_listings
  FOR EACH ROW EXECUTE FUNCTION catalog_listing_sensitivity_guard();
CREATE TRIGGER materials_listing_sensitivity_guard
  BEFORE UPDATE OF sensitivity_minors, sensitivity_injured, sensitivity_graphic ON materials
  FOR EACH ROW EXECUTE FUNCTION catalog_listing_sensitivity_guard();

-- Down Migration

DROP TRIGGER materials_listing_sensitivity_guard ON materials;
DROP TRIGGER catalog_listings_sensitivity_guard ON catalog_listings;
DROP FUNCTION catalog_listing_sensitivity_guard();

ALTER TABLE catalog_listings DROP CONSTRAINT catalog_listings_suspended_reason_check;
ALTER TABLE catalog_listings ADD CONSTRAINT catalog_listings_suspended_reason_check CHECK (
  (state = 'suspended') = (suspended_reason IS NOT NULL) AND
  (suspended_reason IS NULL OR suspended_reason IN ('manual', 'rights_changed')));
