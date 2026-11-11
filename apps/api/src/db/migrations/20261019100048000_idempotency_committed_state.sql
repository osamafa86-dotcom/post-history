-- Up Migration
-- حالة ثالثة لمفتاح منع التكرار (ADR 0005، تعديل 2026-11-11): committed = كتابة الطلب التُزمت ورده لم يُحفظ بعد. الخادم يكتبها في
-- معاملة الكتابة نفسها، فالمفتاح الملتزَم لا يُحرَّر ولا يتولاه تكرار: الإعادة عليه 409 إلى أن يُحفظ الرد أو ينتهي المفتاح.
ALTER TABLE idempotency_keys DROP CONSTRAINT idempotency_keys_state_check;
ALTER TABLE idempotency_keys ADD CONSTRAINT idempotency_keys_state_check
  CHECK (state IN ('in_progress', 'committed', 'completed'));

-- Down Migration
-- المفتاح الملتزَم بلا رد يبقى مرفوض الإعادة بالتراجع (لا يعود قابلًا للتنفيذ): يُحفظ له رد 409 نفسه، ثم يعود القيد.
UPDATE idempotency_keys
   SET state = 'completed', response_status = 409,
       response_body = '{"code": "idempotency_in_progress", "message": "Request is in progress.", "request_id": ""}'
 WHERE state = 'committed';
ALTER TABLE idempotency_keys DROP CONSTRAINT idempotency_keys_state_check;
ALTER TABLE idempotency_keys ADD CONSTRAINT idempotency_keys_state_check
  CHECK (state IN ('in_progress', 'completed'));
