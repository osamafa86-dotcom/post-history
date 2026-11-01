-- Up Migration
-- وسوم المادة (ADR 0086، قرار المالك 2026-11-01): يكتبها المراسل وتقترحها الإدارة، وتُلزمها واجهات v2 عند الإرسال.
-- في العقد اختيارية (قاعدة v0.1 الإضافية: لا يُكسر عميل v0 لا يرسلها)، فالعمود فارغ افتراضيًا. القيد هنا هو الحدّ
-- الصلب: 12 وسمًا على الأكثر بلا تكرار ولا NULL، كلٌّ 1–40 محرفًا مشذَّبًا، بلا محارف تحكم ولا محارف اتجاه
-- (U+200E/U+200F وU+202A–U+202E وU+2066–U+2069) بنطاق صريح لا يعتمد على LC_CTYPE، فلا يُقلب عرض الوسم بجانب غيره.
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
          OR t <> btrim(t)
          OR t ~ '[\x01-\x1f\x7f‎‏‪-‮⁦-⁩]')
$$;

ALTER TABLE materials ADD COLUMN tags text[] NOT NULL DEFAULT '{}';
ALTER TABLE materials ADD CONSTRAINT materials_tags_valid CHECK (public.material_tags_valid(tags));
-- لا فهرس GIN هنا: المخطط لا يحمل GIN في أي مكان (اختبار الدخان)، وفهرسة البحث بالوسم قرار الخادم حين يبنيه.

-- Down Migration
ALTER TABLE materials DROP CONSTRAINT materials_tags_valid;
ALTER TABLE materials DROP COLUMN tags;
DROP FUNCTION material_tags_valid(text[]);
