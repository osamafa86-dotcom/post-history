-- Up Migration
-- قالب «الشاهد» خيارًا ثانيًا في طلب النسخة (ADR 0109): القيمة witness في material_renders.template وحده. الطلب نفسه والشروط
-- والحدود والأحداث وحمولاتها والمشتق circulated_render كما هي (ADR 0091)، فلا نوع ملف جديد ولا حدث ولا مفتاح حمولة.
-- القالب يُسجَّل مع النسخة كما طُلب، ويعود في GET /materials/{id}/renders وفي معاملات العامل.
ALTER TABLE material_renders DROP CONSTRAINT material_renders_template_check;
ALTER TABLE material_renders ADD CONSTRAINT material_renders_template_check CHECK (template IN ('circulated', 'witness'));

-- Down Migration
-- نسخ «الشاهد» تُحذف مع ملفاتها المشتقة قبل إعادة القيد (لا يحمل الجدول بعدها قالبًا لا يعرفه)؛ والأصل لا يُمس. النسخ
-- وملفاتها في عبارة واحدة: حذف الملف وحده يجعل file_id للنسخة الجاهزة NULL (ON DELETE SET NULL) فيكسر قيد الجاهزة.
WITH gone AS (DELETE FROM material_renders WHERE template = 'witness' RETURNING file_id)
DELETE FROM material_files WHERE id IN (SELECT file_id FROM gone WHERE file_id IS NOT NULL);
ALTER TABLE material_renders DROP CONSTRAINT material_renders_template_check;
ALTER TABLE material_renders ADD CONSTRAINT material_renders_template_check CHECK (template IN ('circulated'));
