-- Up Migration
-- وسوم المادة (ADR 0086، قرار المالك 2026-11-01): يكتبها المراسل وتقترحها الإدارة، وتُلزمها واجهات v2 عند الإرسال.
-- في العقد اختيارية (قاعدة v0.1 الإضافية: لا يُكسر عميل v0 لا يرسلها)، فالعمود فارغ افتراضيًا. القيد هنا هو الحدّ
-- الصلب: 12 وسمًا على الأكثر بلا تكرار ولا NULL، كلٌّ 1–40 محرفًا، بلا مسافة من أي نوع في أوله ولا في آخره، وبلا محارف تحكم
-- ولا محارف اتجاه. المجموعات نفسها في نمط MaterialTag بـ openapi.yaml، وتغيير إحداهما يوجب تغيير الأخرى في الطلب نفسه:
--   مسافات الطرفين (صنف \s في JSON Schema): U+0009–U+000D وU+0020 وU+00A0 وU+1680 وU+2000–U+200A وU+2028 وU+2029
--   وU+202F وU+205F وU+3000 وU+FEFF؛ التحكم: U+0001–U+001F وU+007F–U+009F؛ الاتجاه: U+061C وU+200E/U+200F
--   وU+202A–U+202E وU+2066–U+2069.
-- كلها تُكتب بتهريبات \uXXXX من صيغة ARE في Postgres لا بمحارف حرفية، فلا يحمل الملف محارف غير مرئية. ولا يُستعمل \s ولا
-- [[:space:]] لأن مجموعتهما تتبع LC_CTYPE، ولا btrim لأنه يقصّ U+0020 وحدها.
-- الدالة مثبّتة بـ search_path (#71) فتعمل أثناء الاستعادة.
CREATE FUNCTION material_tags_valid(tags text[]) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path = public, pg_temp
AS $$
  SELECT cardinality(tags) <= 12
     AND array_position(tags, NULL) IS NULL
     AND cardinality(tags) = (SELECT count(DISTINCT t) FROM unnest(tags) AS t)
     AND NOT EXISTS (
       SELECT 1 FROM unnest(tags) AS t
       WHERE char_length(t) NOT BETWEEN 1 AND 40
          OR t ~ '^[\u0009-\u000d\u0020\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]|[\u0009-\u000d\u0020\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]$'
          OR t ~ '[\x01-\x1f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]')
$$;

ALTER TABLE materials ADD COLUMN tags text[] NOT NULL DEFAULT '{}';
ALTER TABLE materials ADD CONSTRAINT materials_tags_valid CHECK (public.material_tags_valid(tags));
-- لا فهرس GIN هنا: المخطط لا يحمل GIN في أي مكان (اختبار الدخان)، وفهرسة البحث بالوسم قرار الخادم حين يبنيه.

-- Down Migration
ALTER TABLE materials DROP CONSTRAINT materials_tags_valid;
ALTER TABLE materials DROP COLUMN tags;
DROP FUNCTION material_tags_valid(text[]);
