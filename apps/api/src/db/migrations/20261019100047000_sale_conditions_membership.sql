-- Up Migration
-- شروط البيع الثلاثة وعضوية المشتري (ADR 0114)، وفهارس الكنس الدوري (ADR 0116).

-- ---------- عضوية المشتري مستقلة عن حالة الحساب على المنصة ----------
-- users.status حالة المنصة يغيّرها مدير النظام وحده (PUT /users/{id}/status والأمر)، وmembership_suspended عضوية المؤسسة يغيّرها
-- مدير المؤسسة. الدخول يلزمه الاثنان معًا؛ وتعليق العضوية يبطل كل الوصول كالتعليق على المنصة.
ALTER TABLE users ADD COLUMN membership_suspended boolean NOT NULL DEFAULT false;
ALTER TABLE users ADD CONSTRAINT users_membership_needs_organization CHECK (NOT membership_suspended OR organization_id IS NOT NULL);
-- ما علّقه مدير المؤسسة قبل الفصل (آخر قرار في التدقيق له) يصير تعليق عضوية، وما سواه يبقى تعليقًا على المنصة
UPDATE users u SET membership_suspended = true, status = 'active'
 WHERE u.organization_id IS NOT NULL AND u.status = 'suspended'
   AND (SELECT a.action || ':' || COALESCE(a.details->>'to', '') FROM audit_log a
         WHERE a.target_type = 'user' AND a.target_id = u.id::text
           AND a.action IN ('buyer_member.status_changed', 'user.suspended', 'user.reactivated')
         ORDER BY a.id DESC LIMIT 1) = 'buyer_member.status_changed:suspended';

-- ---------- الإدراج المعروض: اعتماد تحريري للإصدار المعروض وأصل متحقق ----------
-- مع حارسي الحقوق (020) والحساسية (027): لا يصير الإدراج listed إلا ومادته published بالإصدار المثبّت نفسه وفنيًّا verified، ولا
-- تخرج المادة من ذلك وإدراجها listed (إصدار جديد أو خروج من published أو من verified)؛ الخادم يعلّقه أولًا بـ editorial_changed.
CREATE FUNCTION catalog_listing_editorial_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_TABLE_NAME = 'catalog_listings' THEN
    IF NEW.state = 'listed' AND NOT EXISTS (
         SELECT 1 FROM public.materials m
          WHERE m.id = NEW.material_id AND m.editorial_state = 'published' AND m.version = NEW.material_version
            AND m.technical_state = 'verified') THEN
      RAISE EXCEPTION 'a listed material needs editorial approval of the listed version and a verified original'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF EXISTS (
         SELECT 1 FROM public.catalog_listings l
          WHERE l.material_id = NEW.id AND l.state = 'listed'
            AND NOT (NEW.editorial_state = 'published' AND NEW.version = l.material_version AND NEW.technical_state = 'verified')) THEN
    RAISE EXCEPTION 'suspend the listing before its version loses editorial approval' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER catalog_listings_editorial_guard BEFORE INSERT OR UPDATE OF state, material_id, material_version ON catalog_listings
  FOR EACH ROW EXECUTE FUNCTION catalog_listing_editorial_guard();
CREATE TRIGGER materials_listing_editorial_guard BEFORE UPDATE OF editorial_state, version, technical_state ON materials
  FOR EACH ROW EXECUTE FUNCTION catalog_listing_editorial_guard();

-- الإدراجات المعروضة اليوم بلا الشرطين تُعلَّق بالسبب الجديد، وحدثها في المعاملة نفسها كما يكتبه الخادم
WITH stale AS (
  UPDATE catalog_listings l SET state = 'suspended', suspended_reason = 'editorial_changed'
   WHERE l.state = 'listed' AND NOT EXISTS (
         SELECT 1 FROM materials m
          WHERE m.id = l.material_id AND m.editorial_state = 'published' AND m.version = l.material_version
            AND m.technical_state = 'verified')
  RETURNING l.id, l.material_id, l.material_version, l.updated_at
)
INSERT INTO outbox_events (type, aggregate_type, aggregate_id, idempotency_key, payload)
SELECT 'catalog.listing_changed', 'listing', s.id,
       'catalog.listing_changed:' || s.id || ':' || (extract(epoch FROM s.updated_at) * 1000000)::bigint::text || ':migration-047',
       jsonb_build_object('listing_id', s.id, 'material_id', s.material_id, 'material_version', s.material_version,
                          'source_file_id', (SELECT f.id FROM material_files f
                                              WHERE f.material_id = s.material_id AND f.kind = 'original' AND f.state = 'verified'
                                              ORDER BY f.verified_at DESC LIMIT 1),
                          'state', 'suspended', 'suspended_reason', 'editorial_changed')
  FROM stale s;

-- ---------- الترخيص: الشروط نفسها لحظة التأكيد ----------
-- مع license_guard (030) الذي يعيد فحص الحقوق: الإصدار المعتمد هو إصدار البند، والأصل متحقق، والمادة غير موسومة بالحساسية.
CREATE FUNCTION license_sale_conditions_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (
       SELECT 1 FROM public.order_items i JOIN public.materials m ON m.id = i.material_id
        WHERE i.id = NEW.order_item_id AND m.editorial_state = 'published' AND m.version = i.material_version
          AND m.technical_state = 'verified'
          AND NOT (m.sensitivity_minors OR m.sensitivity_injured OR m.sensitivity_graphic)) THEN
    RAISE EXCEPTION 'a license needs editorial approval of the sold version, a verified original and no sensitivity flag'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER licenses_sale_conditions_guard BEFORE INSERT ON licenses
  FOR EACH ROW EXECUTE FUNCTION license_sale_conditions_guard();

-- ---------- فهارس الكنس الدوري (ADR 0116) ----------
CREATE INDEX refresh_tokens_dead_idx ON refresh_tokens (LEAST(expires_at, COALESCE(revoked_at, expires_at)));
CREATE INDEX notifications_read_idx ON notifications (read_at) WHERE read_at IS NOT NULL;
CREATE INDEX upload_sessions_scrub_idx ON upload_sessions (updated_at)
  WHERE state IN ('verified', 'failed', 'deduplicated') AND filename <> '-';

-- Down Migration
DROP INDEX upload_sessions_scrub_idx;
DROP INDEX notifications_read_idx;
DROP INDEX refresh_tokens_dead_idx;
DROP TRIGGER licenses_sale_conditions_guard ON licenses;
DROP FUNCTION license_sale_conditions_guard();
DROP TRIGGER materials_listing_editorial_guard ON materials;
DROP TRIGGER catalog_listings_editorial_guard ON catalog_listings;
DROP FUNCTION catalog_listing_editorial_guard();
-- تعليق العضوية يعود تعليقًا للحساب (لا يدخل صاحبه بالتراجع)
UPDATE users SET status = 'suspended' WHERE membership_suspended AND status = 'active';
ALTER TABLE users DROP CONSTRAINT users_membership_needs_organization;
ALTER TABLE users DROP COLUMN membership_suspended;
