-- Up Migration
-- واجهة عامل الوسائط (ADR 0006، موافقة المنسّق في التذكرة 9):
-- 1) material_files.technical: البيانات الفنية التي لا أعمدة لها (الترميز، المعدل، الفجوات...). قائمة بيضاء مغلقة
--    من المفاتيح يفرضها قيد هنا وفي الخادم: وسوم الملف (الإحداثيات وطراز الجهاز) لا تُخزَّن أبدًا. غير مكشوفة في /v1.
-- 2) head_sha256/tail_sha256: البصمة الرخيصة (أول وآخر MiB) لترشيح المكررات مسبقًا بفهرس (size_bytes, head_sha256).
-- 3) فهرس فريد جزئي على (derived_from_id, kind): مشتق واحد من كل نوع لكل مصدر، فتكرار طلب العامل لا ينشئ ثانيًا.

ALTER TABLE material_files
  ADD COLUMN technical   jsonb,
  ADD COLUMN head_sha256 bytea,
  ADD COLUMN tail_sha256 bytea;

CREATE FUNCTION material_file_technical_keys() RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT ARRAY['container', 'video_codec', 'audio_codec', 'frame_rate', 'avg_frame_rate', 'vfr', 'frame_count',
               'max_frame_gap_ms', 'has_gaps', 'rotation', 'hdr', 'bit_depth', 'audio_sample_rate',
               'audio_channels']::text[]
$$;

CREATE FUNCTION material_file_technical_is_whitelisted(t jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT jsonb_typeof(t) = 'object'
     AND NOT EXISTS (SELECT 1 FROM jsonb_object_keys(t) AS k WHERE k <> ALL (material_file_technical_keys()))
$$;

ALTER TABLE material_files
  ADD CONSTRAINT material_files_technical_whitelisted CHECK (technical IS NULL OR material_file_technical_is_whitelisted(technical)),
  ADD CONSTRAINT material_files_head_sha256_len CHECK (head_sha256 IS NULL OR octet_length(head_sha256) = 32),
  ADD CONSTRAINT material_files_tail_sha256_len CHECK (tail_sha256 IS NULL OR octet_length(tail_sha256) = 32);

CREATE INDEX material_files_size_head_idx ON material_files (size_bytes, head_sha256) WHERE head_sha256 IS NOT NULL;
CREATE UNIQUE INDEX material_files_derived_kind_key ON material_files (derived_from_id, kind) WHERE derived_from_id IS NOT NULL;

-- Down Migration
DROP INDEX material_files_derived_kind_key;
DROP INDEX material_files_size_head_idx;
ALTER TABLE material_files
  DROP CONSTRAINT material_files_tail_sha256_len,
  DROP CONSTRAINT material_files_head_sha256_len,
  DROP CONSTRAINT material_files_technical_whitelisted;
DROP FUNCTION material_file_technical_is_whitelisted(jsonb);
DROP FUNCTION material_file_technical_keys();
ALTER TABLE material_files
  DROP COLUMN tail_sha256,
  DROP COLUMN head_sha256,
  DROP COLUMN technical;
