-- Up Migration
-- سبب تعليق آلي رابع للإدراج (ADR 0114): editorial_changed حين يسقط الاعتماد التحريري للإصدار المعروض. القيمة وحدها هنا مع العقد
-- (قاعدة العقود 9)؛ شروط العرض في محفّزات القاعدة وتعليق الخادم في الترحيل التالي مع الخادم.
ALTER TABLE catalog_listings DROP CONSTRAINT catalog_listings_suspended_reason_check;
ALTER TABLE catalog_listings ADD CONSTRAINT catalog_listings_suspended_reason_check CHECK (
  (state = 'suspended') = (suspended_reason IS NOT NULL) AND
  (suspended_reason IS NULL OR suspended_reason IN ('manual', 'rights_changed', 'sensitive_flagged', 'editorial_changed')));

-- Down Migration
-- الإدراج المعلّق بالسبب الجديد يبقى معلّقًا بسبب «manual» (لا يعود معروضًا بالتراجع)، ثم يعود القيد.
UPDATE catalog_listings SET suspended_reason = 'manual' WHERE suspended_reason = 'editorial_changed';
ALTER TABLE catalog_listings DROP CONSTRAINT catalog_listings_suspended_reason_check;
ALTER TABLE catalog_listings ADD CONSTRAINT catalog_listings_suspended_reason_check CHECK (
  (state = 'suspended') = (suspended_reason IS NOT NULL) AND
  (suspended_reason IS NULL OR suspended_reason IN ('manual', 'rights_changed', 'sensitive_flagged')));
