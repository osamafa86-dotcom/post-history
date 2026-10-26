-- Up Migration
-- محوّل الدفع قائمة مغلقة: sandbox وstripe بوضع الاختبار (ADR 0032، بأمر المنسّق). المحوّل غير المعروف لا يُكتب في طلب
-- ولا إشعار مستلم. أحداث Stripe تُترجم إلى أنواع payment_events الأربعة نفسها، فلا يتغير قيد النوع.

ALTER TABLE orders DROP CONSTRAINT orders_provider_check;
ALTER TABLE orders ADD CONSTRAINT orders_provider_check CHECK (
  (provider IS NULL) = (provider_ref IS NULL) AND
  (provider IS NULL OR provider IN ('sandbox', 'stripe')) AND
  (provider_ref IS NULL OR char_length(provider_ref) BETWEEN 1 AND 128));

ALTER TABLE payment_events DROP CONSTRAINT payment_events_provider_check;
ALTER TABLE payment_events ADD CONSTRAINT payment_events_provider_check CHECK (provider IN ('sandbox', 'stripe'));

-- Down Migration

ALTER TABLE payment_events DROP CONSTRAINT payment_events_provider_check;
ALTER TABLE payment_events ADD CONSTRAINT payment_events_provider_check CHECK (provider ~ '^[a-z_]{1,32}$');

ALTER TABLE orders DROP CONSTRAINT orders_provider_check;
ALTER TABLE orders ADD CONSTRAINT orders_provider_check CHECK (
  (provider IS NULL) = (provider_ref IS NULL) AND
  (provider IS NULL OR provider ~ '^[a-z_]{1,32}$') AND
  (provider_ref IS NULL OR char_length(provider_ref) BETWEEN 1 AND 128));
