-- Up Migration
-- مشتق shot_list من عامل الذكاء الاصطناعي (application/json، زمني كالتفريغ)، حساس كالتفريغ (threat-model §9.1):
-- يقرؤه من يعدّل المادة وحده، ولا يدخل تصديرًا ولا إشعارًا ولا فهرسًا. القائمة تضم watermarked_preview (ADR 0025)
-- فيبقى الترتيب 020 ثم 021 متسقًا.
ALTER TABLE material_files DROP CONSTRAINT material_files_kind_check;
ALTER TABLE material_files ADD CONSTRAINT material_files_kind_check
  CHECK (kind IN ('original', 'proxy', 'hls', 'audio', 'thumbnail', 'voice_note', 'export', 'transcript', 'captions',
                  'watermarked_preview', 'shot_list'));

-- Down Migration
DELETE FROM material_files WHERE kind = 'shot_list';
ALTER TABLE material_files DROP CONSTRAINT material_files_kind_check;
ALTER TABLE material_files ADD CONSTRAINT material_files_kind_check
  CHECK (kind IN ('original', 'proxy', 'hls', 'audio', 'thumbnail', 'voice_note', 'export', 'transcript', 'captions',
                  'watermarked_preview'));
