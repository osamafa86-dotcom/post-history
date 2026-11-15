-- Up Migration
-- نتيجة فحص عامل الوسائط لمحتوى أصل تحقّق الخادم من بصمته (ملحق (ب) على ADR 0092، قرار المنسّق 2026-11-15): `invalid` حين لا
-- يقرؤه العامل، وNULL لما لم يُفحص بعد أو قُرئ أو لا ينطبق. حقيقة مستقلة على الملف: لا تمس state ولا الإيصال ولا الحالة الفنية
-- للمادة. للأصل وحده. عمود قابل للفراغ بلا قيمة افتراضية: إضافته لا تعيد كتابة الجدول.
ALTER TABLE material_files ADD COLUMN media_check text;
ALTER TABLE material_files ADD CONSTRAINT material_files_media_check_check CHECK (media_check IS NULL OR media_check IN ('invalid'));
ALTER TABLE material_files ADD CONSTRAINT material_files_media_check_only_original CHECK (media_check IS NULL OR kind = 'original');

-- Down Migration
ALTER TABLE material_files DROP CONSTRAINT material_files_media_check_only_original;
ALTER TABLE material_files DROP CONSTRAINT material_files_media_check_check;
ALTER TABLE material_files DROP COLUMN media_check;
