-- Up Migration
-- وارد المشرف (ADR 0002): مواد المكتب بحالتها التحريرية مرتبةً بالأحدث. materials_board_idx يضع priority قبل created_at فلا يحمل
-- ترتيب المؤشر (created_at DESC, id DESC)، فصفحة الوارد كانت تمسح الجدول. الخادم يقرأ فرع المكتب بشرط مساواة على office_id.
CREATE INDEX materials_office_state_created_idx ON materials (office_id, editorial_state, created_at DESC, id DESC);

-- Down Migration
DROP INDEX materials_office_state_created_idx;
