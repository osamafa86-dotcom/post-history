-- Up Migration
-- حقول مواصفات التصميم (ADR 0035، بأمر المنسّق). اسم العمل اسم داخلي لحساب طاقم يظهر للطاقم وحده بجانب المعرّف
-- (منفّذ الانتقال، حاجز المادة)؛ ليس الاسم الحقيقي (legal_name_enc، ADR 0021) ولا يُشتق منه. لا يُعيَّن لحساب مشترٍ
-- (قيد هنا)، ولا لمراسل (يرفضه الخادم 422، والعقد لا يعيده لمنفّذ مراسل). لا يدخل حدثًا ولا تدقيقًا ولا إشعارًا.
ALTER TABLE users ADD COLUMN work_name text;
ALTER TABLE users ADD CONSTRAINT users_work_name_format CHECK (
  work_name IS NULL OR (
    char_length(work_name) BETWEEN 1 AND 80 AND
    work_name = btrim(work_name) AND
    work_name !~ '[[:cntrl:]]'));
ALTER TABLE users ADD CONSTRAINT users_work_name_staff_only CHECK (work_name IS NULL OR organization_id IS NULL);

-- موعد الإقرار لكل مادة (Material.acknowledgement_due_at): أقرب escalate_at لمهمة غير مُقرّة عن المادة، لقوائم المواد
-- بلا مسح الإشعارات.
CREATE INDEX notifications_material_ack_due_idx ON notifications (material_id, escalate_at)
  WHERE assignment_state = 'assigned' AND acknowledged_at IS NULL AND material_id IS NOT NULL;

-- Down Migration
DROP INDEX notifications_material_ack_due_idx;
ALTER TABLE users DROP CONSTRAINT users_work_name_staff_only;
ALTER TABLE users DROP CONSTRAINT users_work_name_format;
ALTER TABLE users DROP COLUMN work_name;
