-- Up Migration
-- المحاذاة الصوتية بين النسخة الخفيفة والأصل (v0.3، طلب وكيل الوسائط): يكتبها العامل على ملف proxy وحده، ويقرؤها
-- المحرر لتصحيح نقاط القص. أرقام فقط: الأصل المرجعي، والإزاحة، والثقة، والهامش، وحكم الموثوقية.
ALTER TABLE material_files
  ADD COLUMN alignment_original_file_id uuid REFERENCES material_files (id),
  ADD COLUMN alignment_offset_ms        integer,
  ADD COLUMN alignment_confidence       real,
  ADD COLUMN alignment_margin           real,
  ADD COLUMN alignment_reliable         boolean,
  ADD COLUMN aligned_at                 timestamptz;
ALTER TABLE material_files ADD CONSTRAINT material_files_alignment_check CHECK (
  (alignment_original_file_id IS NULL AND alignment_offset_ms IS NULL AND alignment_confidence IS NULL AND
   alignment_margin IS NULL AND alignment_reliable IS NULL AND aligned_at IS NULL)
  OR
  (kind = 'proxy' AND alignment_original_file_id IS NOT NULL AND alignment_reliable IS NOT NULL AND aligned_at IS NOT NULL AND
   alignment_offset_ms BETWEEN -3600000 AND 3600000 AND
   alignment_confidence BETWEEN 0 AND 1 AND alignment_margin BETWEEN 0 AND 1));

-- Down Migration
ALTER TABLE material_files DROP CONSTRAINT material_files_alignment_check;
ALTER TABLE material_files
  DROP COLUMN aligned_at,
  DROP COLUMN alignment_reliable,
  DROP COLUMN alignment_margin,
  DROP COLUMN alignment_confidence,
  DROP COLUMN alignment_offset_ms,
  DROP COLUMN alignment_original_file_id;
