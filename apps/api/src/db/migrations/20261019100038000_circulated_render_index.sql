-- Up Migration
-- نسخ قالب «مواد متداولة» (ADR 0091، الطلب ب): عدة مشتقات circulated_render للأصل الواحد، نسخة لكل طلب، وفرادتها في
-- material_renders.file_id. فيُستثنى النوع من فرادة (المصدر، النوع) كما استُثني delivery (ترحيل 026). تسجيل المشتق في
-- الخادم (media.service) يستدل الفهرس الجزئي بشرطه الحرفي، فيتغيّر الشرطان معًا في هذا الطلب، واختبار الدخان يثبت أن
-- الشرط القديم لم يعد يطابقه.
DROP INDEX material_files_derived_kind_key;
CREATE UNIQUE INDEX material_files_derived_kind_key ON material_files (derived_from_id, kind)
  WHERE derived_from_id IS NOT NULL AND kind NOT IN ('delivery', 'circulated_render');

-- Down Migration
-- النسخة الثانية للأصل نفسه تخالف الفرادة القديمة: تُحذف النسخ الجاهزة ومشتقاتها كما يحذف 026 حزم التسليم، وتبقى
-- الطلبات غير الجاهزة.
DELETE FROM material_renders WHERE file_id IS NOT NULL;
DELETE FROM material_files WHERE kind = 'circulated_render';
DROP INDEX material_files_derived_kind_key;
CREATE UNIQUE INDEX material_files_derived_kind_key ON material_files (derived_from_id, kind)
  WHERE derived_from_id IS NOT NULL AND kind <> 'delivery';
