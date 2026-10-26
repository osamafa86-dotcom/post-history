-- Up Migration
-- التصدير النهائي مشتقًا (v0.3، ADR 0025 الجزء 9؛ طلب وكيل الوسائط وموافقة المنسّق): نوع produced يكتبه عامل الوسائط
-- وحده من render (cut-export)، فيملأ بند produced في حزمة التسليم. القائمة تراكمية حتى delivery (ترحيل 026).

ALTER TABLE material_files DROP CONSTRAINT material_files_kind_check;
ALTER TABLE material_files ADD CONSTRAINT material_files_kind_check
  CHECK (kind IN ('original', 'proxy', 'hls', 'audio', 'thumbnail', 'voice_note', 'export', 'transcript', 'captions',
                  'watermarked_preview', 'shot_list', 'delivery', 'produced'));

-- Down Migration

ALTER TABLE material_files DROP CONSTRAINT material_files_kind_check;
ALTER TABLE material_files ADD CONSTRAINT material_files_kind_check
  CHECK (kind IN ('original', 'proxy', 'hls', 'audio', 'thumbnail', 'voice_note', 'export', 'transcript', 'captions',
                  'watermarked_preview', 'shot_list', 'delivery'));
