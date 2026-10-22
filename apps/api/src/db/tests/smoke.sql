-- اختبار دخاني للمخطط: يثبت أن القيود والمحفزات تعمل كما يصفها العقد وADRs.
-- يعمل داخل معاملة واحدة تُرجَع في النهاية فلا يترك أثرًا. التشغيل: psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f tests/smoke.sql
\set ON_ERROR_STOP on
\o /dev/null
BEGIN;

CREATE FUNCTION pg_temp.expect_error(stmt text, expected_sqlstate text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    EXECUTE stmt;
    SET CONSTRAINTS ALL IMMEDIATE;   -- يُطلق القيود المؤجلة الآن بدل نهاية المعاملة
  EXCEPTION WHEN OTHERS THEN
    IF SQLSTATE = expected_sqlstate THEN
      RETURN;
    END IF;
    RAISE EXCEPTION 'expected SQLSTATE % but got % (%) for: %', expected_sqlstate, SQLSTATE, SQLERRM, stmt
      USING ERRCODE = 'assert_failure';
  END;
  RAISE EXCEPTION 'expected failure % but statement succeeded: %', expected_sqlstate, stmt
    USING ERRCODE = 'assert_failure';
END $$;

CREATE FUNCTION pg_temp.assert(cond boolean, msg text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT COALESCE(cond, false) THEN
    RAISE EXCEPTION 'assertion failed: %', msg USING ERRCODE = 'assert_failure';
  END IF;
END $$;

-- ---------- seed ----------
INSERT INTO offices (id, name_ar, name_en, governorate)
VALUES ('00000000-0000-4000-8000-000000000001', 'مكتب غزة', 'Gaza office', 'غزة');

INSERT INTO users (id, email, password_hash, office_id) VALUES
  ('00000000-0000-4000-8000-000000000011', 'reporter@example.invalid',   'argon2id$test', '00000000-0000-4000-8000-000000000001'),
  ('00000000-0000-4000-8000-000000000012', 'supervisor@example.invalid', 'argon2id$test', '00000000-0000-4000-8000-000000000001'),
  ('00000000-0000-4000-8000-000000000013', 'producer@example.invalid',   'argon2id$test', NULL),
  ('00000000-0000-4000-8000-000000000014', 'rights@example.invalid',     'argon2id$test', NULL);

INSERT INTO user_roles (user_id, role, scope_kind, scope_id) VALUES
  ('00000000-0000-4000-8000-000000000011', 'reporter',   'all', ''),
  ('00000000-0000-4000-8000-000000000012', 'supervisor', 'office', '00000000-0000-4000-8000-000000000001'),
  ('00000000-0000-4000-8000-000000000013', 'producer',   'all', ''),
  ('00000000-0000-4000-8000-000000000014', 'rights_officer', 'all', '');

SELECT pg_temp.expect_error($q$
  INSERT INTO user_roles (user_id, role, scope_kind, scope_id)
  VALUES ('00000000-0000-4000-8000-000000000012', 'supervisor', 'all', 'office-1') $q$, '23514');
SELECT pg_temp.expect_error($q$ UPDATE users SET email = 'REPORTER@example.invalid' WHERE id = '00000000-0000-4000-8000-000000000012' $q$, '23505');

-- ---------- forms ----------
INSERT INTO upload_forms (version, material_types, schema, published_by)
VALUES (1, '{}', '{"version": 1, "fields": [{"key": "notes", "type": "long_text", "label": {"ar": "ملاحظات", "en": "Notes"}, "required": false}]}',
        '00000000-0000-4000-8000-000000000012');
SELECT pg_temp.expect_error($q$ INSERT INTO upload_forms (version, schema) VALUES (2, '{"version": 3, "fields": []}') $q$, '23514');
SELECT pg_temp.expect_error($q$ INSERT INTO upload_forms (version, schema) VALUES (2, '{"version": 2}') $q$, '23514');
SELECT pg_temp.expect_error($q$ INSERT INTO upload_forms (version, material_types, schema) VALUES (2, '{podcast}', '{"version": 2, "fields": []}') $q$, '23514');
-- بوابة v0: لا حقل حساس ولا حقل موقع
SELECT pg_temp.expect_error($q$ INSERT INTO upload_forms (version, schema) VALUES (2, '{"version": 2, "fields": [{"key": "source_name", "type": "short_text", "label": {"ar": "م", "en": "s"}, "required": false, "sensitive": true}]}') $q$, '23514');
SELECT pg_temp.expect_error($q$ INSERT INTO upload_forms (version, schema) VALUES (2, '{"version": 2, "fields": [{"key": "loc", "type": "location", "label": {"ar": "م", "en": "l"}, "required": false}]}') $q$, '23514');

-- ---------- materials ----------
INSERT INTO materials (id, reporter_id, office_id, title, material_types, governorate, city, priority,
                       sensitivity_minors, sensitivity_injured, sensitivity_graphic, display_name_mode, form_version, dynamic_fields)
VALUES ('00000000-0000-4000-8000-000000000101', '00000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-000000000001',
        'مؤتمر صحفي للدفاع المدني', '{press_conference}', 'غزة', 'غزة', 'important', false, false, false, 'network', 1, '{"notes": "x"}');

SELECT pg_temp.assert(
  (SELECT technical_state = 'pending' AND editorial_state = 'inbox' AND rights_state = 'unknown' AND version = 1
     FROM materials WHERE id = '00000000-0000-4000-8000-000000000101'),
  'new material starts in pending/inbox/unknown');

SELECT pg_temp.expect_error($q$ UPDATE materials SET priority = 'critical' WHERE id = '00000000-0000-4000-8000-000000000101' $q$, '23514');
SELECT pg_temp.expect_error($q$ UPDATE materials SET editorial_state = 'approved' WHERE id = '00000000-0000-4000-8000-000000000101' $q$, '23514');
SELECT pg_temp.expect_error($q$ UPDATE materials SET display_name_mode = 'pseudonym' WHERE id = '00000000-0000-4000-8000-000000000101' $q$, '23514');
SELECT pg_temp.expect_error($q$ UPDATE materials SET material_types = '{podcast}' WHERE id = '00000000-0000-4000-8000-000000000101' $q$, '23514');
SELECT pg_temp.expect_error($q$ UPDATE materials SET material_types = '{}' WHERE id = '00000000-0000-4000-8000-000000000101' $q$, '23514');
SELECT pg_temp.expect_error($q$ UPDATE materials SET reserved_by = '00000000-0000-4000-8000-000000000013' WHERE id = '00000000-0000-4000-8000-000000000101' $q$, '23514');
SELECT pg_temp.expect_error($q$ UPDATE materials SET dynamic_fields = '[]' WHERE id = '00000000-0000-4000-8000-000000000101' $q$, '23514');
SELECT pg_temp.expect_error($q$ UPDATE materials SET form_version = 99 WHERE id = '00000000-0000-4000-8000-000000000101' $q$, '23503');

-- updated_at يتغير مع التحديث
UPDATE materials SET city = 'خان يونس' WHERE id = '00000000-0000-4000-8000-000000000101';
SELECT pg_temp.assert((SELECT updated_at >= created_at FROM materials WHERE id = '00000000-0000-4000-8000-000000000101'), 'updated_at maintained');

-- ---------- contributors: sum must be exactly 100.00 ----------
SET CONSTRAINTS ALL DEFERRED;
INSERT INTO material_contributors (material_id, user_id, role, share_percent) VALUES
  ('00000000-0000-4000-8000-000000000101', '00000000-0000-4000-8000-000000000011', 'photographer', 60.00),
  ('00000000-0000-4000-8000-000000000101', '00000000-0000-4000-8000-000000000013', 'editor', 40.00);
SET CONSTRAINTS ALL IMMEDIATE;   -- 60 + 40 = 100 → يمر

SET CONSTRAINTS ALL DEFERRED;
SELECT pg_temp.expect_error($q$
  UPDATE material_contributors SET share_percent = 30.00
  WHERE material_id = '00000000-0000-4000-8000-000000000101' AND user_id = '00000000-0000-4000-8000-000000000013' $q$, '23514');
SET CONSTRAINTS ALL DEFERRED;
SELECT pg_temp.expect_error($q$
  DELETE FROM material_contributors
  WHERE material_id = '00000000-0000-4000-8000-000000000101' AND user_id = '00000000-0000-4000-8000-000000000013' $q$, '23514');
SET CONSTRAINTS ALL DEFERRED;
SELECT pg_temp.expect_error($q$
  INSERT INTO material_contributors (material_id, user_id, role, share_percent)
  VALUES ('00000000-0000-4000-8000-000000000101', '00000000-0000-4000-8000-000000000014', 'fixer', 0.01) $q$, '23514');
SELECT pg_temp.expect_error($q$
  INSERT INTO material_contributors (material_id, user_id, role, share_percent)
  VALUES ('00000000-0000-4000-8000-000000000101', '00000000-0000-4000-8000-000000000014', 'fixer', 100.001) $q$, '23514');
-- الاستبدال الكامل داخل معاملة (PUT /materials/{id}/contributors) يمر لأن القيد مؤجل
SET CONSTRAINTS ALL DEFERRED;
DELETE FROM material_contributors WHERE material_id = '00000000-0000-4000-8000-000000000101';
INSERT INTO material_contributors (material_id, user_id, role, share_percent) VALUES
  ('00000000-0000-4000-8000-000000000101', '00000000-0000-4000-8000-000000000011', 'photographer', 33.33),
  ('00000000-0000-4000-8000-000000000101', '00000000-0000-4000-8000-000000000013', 'editor', 33.33),
  ('00000000-0000-4000-8000-000000000101', '00000000-0000-4000-8000-000000000014', 'fixer', 33.34);
SET CONSTRAINTS ALL IMMEDIATE;
SELECT pg_temp.assert((SELECT sum(share_percent) = 100.00 FROM material_contributors WHERE material_id = '00000000-0000-4000-8000-000000000101'), 'shares sum to 100');

-- ---------- transitions ----------
INSERT INTO material_transitions (material_id, track, from_state, to_state, reason, actor_id)
VALUES ('00000000-0000-4000-8000-000000000101', 'editorial', 'inbox', 'acknowledged', 'اطّلعت', '00000000-0000-4000-8000-000000000012');
SELECT pg_temp.expect_error($q$
  INSERT INTO material_transitions (material_id, track, from_state, to_state, reason)
  VALUES ('00000000-0000-4000-8000-000000000101', 'editorial', 'inbox', 'inbox', 'no-op') $q$, '23514');
SELECT pg_temp.expect_error($q$
  INSERT INTO material_transitions (material_id, track, from_state, to_state, reason)
  VALUES ('00000000-0000-4000-8000-000000000101', 'legal', 'a', 'b', 'x') $q$, '23514');

-- ---------- uploads & files & receipt ----------
INSERT INTO upload_sessions (id, material_id, created_by, kind, size_bytes, filename, part_size_bytes, expires_at)
VALUES ('00000000-0000-4000-8000-000000000201', '00000000-0000-4000-8000-000000000101', '00000000-0000-4000-8000-000000000011',
        'original', 2147483648, 'IMG_0421.MOV', 16777216, now() + interval '7 days');
SELECT pg_temp.expect_error($q$ UPDATE upload_sessions SET bytes_received = 2147483649 WHERE id = '00000000-0000-4000-8000-000000000201' $q$, '23514');
SELECT pg_temp.expect_error($q$ UPDATE upload_sessions SET state = 'failed' WHERE id = '00000000-0000-4000-8000-000000000201' $q$, '23514');
SELECT pg_temp.expect_error($q$ UPDATE upload_sessions SET part_size_bytes = 1024 WHERE id = '00000000-0000-4000-8000-000000000201' $q$, '23514');
SELECT pg_temp.expect_error($q$ UPDATE upload_sessions SET proxy_mode = 'urgent' WHERE id = '00000000-0000-4000-8000-000000000201' $q$, '23514');
SELECT pg_temp.expect_error($q$ UPDATE upload_sessions SET state = 'deduplicated' WHERE id = '00000000-0000-4000-8000-000000000201' $q$, '23514');
-- حجز pre-create لا يبقى بعد خروج الجلسة من created
UPDATE upload_sessions SET hook_reserved_until = now() + interval '60 seconds' WHERE id = '00000000-0000-4000-8000-000000000201';
SELECT pg_temp.expect_error($q$ UPDATE upload_sessions SET state = 'in_progress' WHERE id = '00000000-0000-4000-8000-000000000201' $q$, '23514');
UPDATE upload_sessions SET hook_reserved_until = NULL WHERE id = '00000000-0000-4000-8000-000000000201';

INSERT INTO material_files (id, material_id, kind, state, upload_session_id, storage_key, size_bytes)
VALUES ('00000000-0000-4000-8000-000000000301', '00000000-0000-4000-8000-000000000101', 'original', 'received',
        '00000000-0000-4000-8000-000000000201', 'uploads/abc', 2147483648);
UPDATE upload_sessions SET state = 'completed', bytes_received = size_bytes, file_id = '00000000-0000-4000-8000-000000000301'
WHERE id = '00000000-0000-4000-8000-000000000201';

-- التحقق دون بصمة مرفوض؛ ومعها يصدر رقم إيصال
SELECT pg_temp.expect_error($q$ UPDATE material_files SET state = 'verified', verified_at = now() WHERE id = '00000000-0000-4000-8000-000000000301' $q$, '23514');
UPDATE material_files SET state = 'verified', verified_at = now(), sha256 = sha256('abc'::bytea)
WHERE id = '00000000-0000-4000-8000-000000000301';
SELECT pg_temp.assert((SELECT receipt_number ~ '^R-[0-9]{6}-[0-9]{6}$' FROM material_files WHERE id = '00000000-0000-4000-8000-000000000301'),
  'receipt number assigned on verified original');
SELECT pg_temp.expect_error($q$ UPDATE material_files SET receipt_number = 'R-202610-999999' WHERE id = '00000000-0000-4000-8000-000000000301' $q$, '23514');
SELECT pg_temp.expect_error($q$ UPDATE material_files SET receipt_number = NULL WHERE id = '00000000-0000-4000-8000-000000000301' $q$, '23514');
-- لا إيصال لغير الأصل
INSERT INTO material_files (id, material_id, kind, state, proxy_mode, sha256, verified_at)
VALUES ('00000000-0000-4000-8000-000000000302', '00000000-0000-4000-8000-000000000101', 'proxy', 'verified', 'normal', sha256('p'::bytea), now());
SELECT pg_temp.assert((SELECT receipt_number IS NULL FROM material_files WHERE id = '00000000-0000-4000-8000-000000000302'), 'no receipt for proxy');
SELECT pg_temp.expect_error($q$ UPDATE material_files SET receipt_number = 'R-202610-000001' WHERE id = '00000000-0000-4000-8000-000000000302' $q$, '23514');
-- البيانات الفنية قائمة بيضاء مغلقة (لا وسوم ملف)، والبصمة الرخيصة 32 بايتًا، ومشتق واحد من كل نوع لكل مصدر
UPDATE material_files SET technical = '{"video_codec": "h264", "vfr": true, "frame_rate": 29.97}', head_sha256 = sha256('h'::bytea),
  tail_sha256 = sha256('t'::bytea) WHERE id = '00000000-0000-4000-8000-000000000301';
SELECT pg_temp.expect_error($q$ UPDATE material_files SET technical = '{"video_codec": "h264", "location": "+31.77+035.23/"}' WHERE id = '00000000-0000-4000-8000-000000000301' $q$, '23514');
SELECT pg_temp.expect_error($q$ UPDATE material_files SET technical = '[]' WHERE id = '00000000-0000-4000-8000-000000000301' $q$, '23514');
SELECT pg_temp.expect_error($q$ UPDATE material_files SET head_sha256 = 'short'::bytea WHERE id = '00000000-0000-4000-8000-000000000301' $q$, '23514');
INSERT INTO material_files (material_id, kind, state, derived_from_id, proxy_mode)
VALUES ('00000000-0000-4000-8000-000000000101', 'proxy', 'received', '00000000-0000-4000-8000-000000000301', 'normal');
SELECT pg_temp.expect_error($q$
  INSERT INTO material_files (material_id, kind, state, derived_from_id, proxy_mode)
  VALUES ('00000000-0000-4000-8000-000000000101', 'proxy', 'received', '00000000-0000-4000-8000-000000000301', 'normal') $q$, '23505');
SELECT pg_temp.expect_error($q$
  INSERT INTO material_files (material_id, kind, proxy_mode) VALUES ('00000000-0000-4000-8000-000000000101', 'original', 'urgent') $q$, '23514');
-- قائمة اللقطات مشتق من الأصل (threat-model §9.1)، ونوع خارج القائمة يُرفض
INSERT INTO material_files (material_id, kind, state, derived_from_id)
VALUES ('00000000-0000-4000-8000-000000000101', 'shot_list', 'received', '00000000-0000-4000-8000-000000000301');
SELECT pg_temp.expect_error($q$
  INSERT INTO material_files (material_id, kind, state, derived_from_id)
  VALUES ('00000000-0000-4000-8000-000000000101', 'storyboard', 'received', '00000000-0000-4000-8000-000000000301') $q$, '23514');

-- ---------- outbox & notifications ----------
INSERT INTO outbox_events (type, aggregate_type, aggregate_id, idempotency_key, actor_id, payload)
VALUES ('material.created', 'material', '00000000-0000-4000-8000-000000000101',
        'material.created:00000000-0000-4000-8000-000000000101', '00000000-0000-4000-8000-000000000011',
        '{"material_id": "00000000-0000-4000-8000-000000000101", "priority": "important"}');
SELECT pg_temp.expect_error($q$
  INSERT INTO outbox_events (type, aggregate_type, aggregate_id, idempotency_key, payload)
  VALUES ('material.created', 'material', '00000000-0000-4000-8000-000000000101', 'material.created:00000000-0000-4000-8000-000000000101', '{}') $q$, '23505');
SELECT pg_temp.expect_error($q$
  INSERT INTO outbox_events (type, aggregate_type, aggregate_id, idempotency_key, payload)
  VALUES ('upload.verified', 'upload', '00000000-0000-4000-8000-000000000201', 'upload.verified:x', '{"gps": {"lat": 1, "lng": 2}}') $q$, '23514');
SELECT pg_temp.expect_error($q$
  INSERT INTO outbox_events (type, aggregate_type, aggregate_id, idempotency_key, payload)
  VALUES ('material.deleted', 'material', '00000000-0000-4000-8000-000000000101', 'material.deleted:x', '{}') $q$, '23514');
-- القائمة البيضاء: مفتاح خارجها (عنوان المادة) مرفوض حتى لو لم يكن في قائمة الممنوعات الصريحة
SELECT pg_temp.expect_error($q$
  INSERT INTO outbox_events (type, aggregate_type, aggregate_id, idempotency_key, payload)
  VALUES ('material.created', 'material', '00000000-0000-4000-8000-000000000101', 'material.created:wl-test',
          '{"material_id": "00000000-0000-4000-8000-000000000101", "priority": "normal", "title": "اسم يكشف الحدث"}') $q$, '23514');
SELECT pg_temp.expect_error($q$
  INSERT INTO outbox_events (type, aggregate_type, aggregate_id, idempotency_key, payload)
  VALUES ('notification.escalated', 'notification', '00000000-0000-4000-8000-000000000101', 'notification.escalated:wl-test',
          '{"notification_id": "00000000-0000-4000-8000-000000000101", "escalation_level": 1, "source_name": "x"}') $q$, '23514');
INSERT INTO outbox_events (type, aggregate_type, aggregate_id, idempotency_key, payload)
VALUES ('upload.verified', 'upload', '00000000-0000-4000-8000-000000000201', 'upload.verified:00000000-0000-4000-8000-000000000201',
        '{"material_id": "00000000-0000-4000-8000-000000000101", "upload_session_id": "00000000-0000-4000-8000-000000000201", "kind": "original", "receipt_number": "R-202610-000001"}');
SELECT pg_temp.expect_error($q$
  INSERT INTO outbox_events (type, aggregate_type, aggregate_id, idempotency_key, payload)
  VALUES ('material.created', 'material', '00000000-0000-4000-8000-000000000101', 'short', '{}') $q$, '23514');
SELECT pg_temp.assert((SELECT published_at IS NULL AND attempts = 0 FROM outbox_events WHERE idempotency_key = 'material.created:00000000-0000-4000-8000-000000000101'),
  'new outbox event is pending');

INSERT INTO notifications (user_id, event_id, type, material_id, title, priority, assignment_state, escalate_at)
SELECT '00000000-0000-4000-8000-000000000012', id, type, '00000000-0000-4000-8000-000000000101', 'مادة واردة #00000000', 'important', 'assigned', now() + interval '5 minutes'
FROM outbox_events WHERE idempotency_key = 'material.created:00000000-0000-4000-8000-000000000101';
SELECT pg_temp.expect_error($q$
  INSERT INTO notifications (user_id, event_id, type, title)
  SELECT '00000000-0000-4000-8000-000000000012', id, type, 'dup' FROM outbox_events LIMIT 1 $q$, '23505');
SELECT pg_temp.expect_error($q$ UPDATE notifications SET state = 'read' $q$, '23514');
UPDATE notifications SET state = 'acknowledged', read_at = now(), acknowledged_at = now(), assignment_state = 'acknowledged';
INSERT INTO notification_deliveries (notification_id, channel, status) SELECT id, 'apns', 'failed' FROM notifications;
INSERT INTO notification_deliveries (notification_id, channel, status) SELECT id, 'in_app', 'delivered' FROM notifications;
SELECT pg_temp.expect_error($q$ INSERT INTO notification_deliveries (notification_id, channel) SELECT id, 'pigeon' FROM notifications $q$, '23514');

-- ---------- sessions (refresh tokens) ----------
INSERT INTO refresh_tokens (user_id, token_hash, installation_id, platform, expires_at, last_seen_at)
VALUES ('00000000-0000-4000-8000-000000000011', sha256('rt1'::bytea), gen_random_uuid(), 'ios', now() + interval '30 days', now());
SELECT pg_temp.expect_error($q$
  INSERT INTO refresh_tokens (user_id, token_hash, platform, expires_at)
  VALUES ('00000000-0000-4000-8000-000000000011', sha256('rt2'::bytea), 'blackberry', now() + interval '1 day') $q$, '23514');
SELECT pg_temp.expect_error($q$
  INSERT INTO refresh_tokens (user_id, token_hash, expires_at)
  VALUES ('00000000-0000-4000-8000-000000000011', sha256('rt1'::bytea), now() + interval '1 day') $q$, '23505');

-- ---------- idempotency keys ----------
INSERT INTO idempotency_keys (user_id, key, request_fingerprint, state, response_status, response_body)
VALUES ('00000000-0000-4000-8000-000000000011', 'c9f1e0d2-7a4b-4c3d-9e8f-0a1b2c3d4e5f', sha256('POST/v1/materials{}'::bytea), 'completed', 201, '{"id": "x"}');
SELECT pg_temp.expect_error($q$
  INSERT INTO idempotency_keys (user_id, key, request_fingerprint)
  VALUES ('00000000-0000-4000-8000-000000000011', 'c9f1e0d2-7a4b-4c3d-9e8f-0a1b2c3d4e5f', sha256('x'::bytea)) $q$, '23505');
SELECT pg_temp.expect_error($q$
  INSERT INTO idempotency_keys (user_id, key, request_fingerprint) VALUES ('00000000-0000-4000-8000-000000000011', 'short', sha256('x'::bytea)) $q$, '23514');
SELECT pg_temp.expect_error($q$
  INSERT INTO idempotency_keys (user_id, key, request_fingerprint, state)
  VALUES ('00000000-0000-4000-8000-000000000011', 'another-key-0001', sha256('x'::bytea), 'completed') $q$, '23514');

-- ---------- audit log: hash chain + append-only ----------
INSERT INTO audit_log (actor_id, action, target_type, target_id, details)
VALUES ('00000000-0000-4000-8000-000000000012', 'recovery.approved', 'user', '00000000-0000-4000-8000-000000000011', '{"recovery_request_id": "00000000-0000-4000-8000-000000000901"}');
-- قائمة بيضاء لتفاصيل التدقيق: لا نص حر
SELECT pg_temp.expect_error($q$
  INSERT INTO audit_log (actor_id, action, details)
  VALUES ('00000000-0000-4000-8000-000000000012', 'recovery.approved', '{"note": "verified by phone call with the source"}') $q$, '23514');
INSERT INTO audit_log (actor_id, action, target_type, target_id)
VALUES ('00000000-0000-4000-8000-000000000012', 'material.transition', 'material', '00000000-0000-4000-8000-000000000101');
SELECT pg_temp.assert(
  (SELECT a2.prev_hash = a1.hash AND a1.prev_hash IS NULL
     FROM audit_log a1 JOIN audit_log a2 ON a2.id = (SELECT min(id) FROM audit_log WHERE id > a1.id)
    WHERE a1.id = (SELECT min(id) FROM audit_log)),
  'audit log rows are hash-chained');
SELECT pg_temp.expect_error($q$ UPDATE audit_log SET action = 'tampered' $q$, '42501');
SELECT pg_temp.expect_error($q$ DELETE FROM audit_log $q$, '42501');
SELECT pg_temp.expect_error($q$ TRUNCATE audit_log $q$, '42501');

-- ---------- user permissions (SEC-03) ----------
INSERT INTO user_permissions (user_id, permission, granted_by, reason)
VALUES ('00000000-0000-4000-8000-000000000012', 'sensitive_location:read', '00000000-0000-4000-8000-000000000012', 'field supervisor for the Gaza office');
SELECT pg_temp.assert(
  (SELECT count(*) = 1 FROM audit_log WHERE action = 'permission.granted' AND details ->> 'permission' = 'sensitive_location:read'),
  'grant writes an audit row');
SELECT pg_temp.expect_error($q$
  INSERT INTO user_permissions (user_id, permission, granted_by, reason)
  VALUES ('00000000-0000-4000-8000-000000000012', 'sensitive_location:read', '00000000-0000-4000-8000-000000000012', 'dup') $q$, '23505');
SELECT pg_temp.expect_error($q$
  INSERT INTO user_permissions (user_id, permission, granted_by, reason)
  VALUES ('00000000-0000-4000-8000-000000000012', 'materials:delete', '00000000-0000-4000-8000-000000000012', 'x') $q$, '23514');
SELECT pg_temp.expect_error($q$ UPDATE user_permissions SET reason = 'edited' WHERE revoked_at IS NULL $q$, '23514');
SELECT pg_temp.expect_error($q$ DELETE FROM user_permissions $q$, '42501');
UPDATE user_permissions SET revoked_by = '00000000-0000-4000-8000-000000000012', revoked_at = now() WHERE revoked_at IS NULL;
SELECT pg_temp.assert((SELECT count(*) = 1 FROM audit_log WHERE action = 'permission.revoked'), 'revoke writes an audit row');
-- بعد السحب يمكن المنح من جديد (سجل تاريخي + منحة نشطة واحدة)
INSERT INTO user_permissions (user_id, permission, granted_by, reason)
VALUES ('00000000-0000-4000-8000-000000000012', 'sensitive_location:read', '00000000-0000-4000-8000-000000000012', 're-granted');
SELECT pg_temp.assert((SELECT count(*) = 2 FROM user_permissions), 'history kept across revoke and re-grant');

-- ---------- v0.1 (ADR 0012) ----------
SELECT pg_temp.assert(
  (SELECT row_version >= 2 FROM materials WHERE id = '00000000-0000-4000-8000-000000000101'),
  'row_version bumps on every material write');
SELECT pg_temp.expect_error($q$
  UPDATE upload_sessions SET upload_token_expires_at = expires_at + interval '1 day' WHERE id = '00000000-0000-4000-8000-000000000201' $q$, '23514');
SELECT pg_temp.expect_error($q$
  UPDATE users SET totp_pending_secret_enc = '\x01' WHERE id = '00000000-0000-4000-8000-000000000011' $q$, '23514');
UPDATE users SET credential_reset_required = true, totp_pending_secret_enc = '\x01' WHERE id = '00000000-0000-4000-8000-000000000011';
INSERT INTO recovery_requests (id, user_id, state, expires_at)
VALUES ('00000000-0000-4000-8000-000000000901', '00000000-0000-4000-8000-000000000011', 'pending_approval', now() + interval '1 day');
SELECT pg_temp.expect_error($q$
  UPDATE recovery_requests SET reset_token_hash = sha256('t'::bytea), reset_token_expires_at = now() + interval '15 minutes'
  WHERE id = '00000000-0000-4000-8000-000000000901' $q$, '23514');
UPDATE recovery_requests SET state = 'approved', decided_at = now(), approved_by = '00000000-0000-4000-8000-000000000012',
  verification_note = 'phone', reset_token_hash = sha256('t'::bytea), reset_token_expires_at = now() + interval '15 minutes'
WHERE id = '00000000-0000-4000-8000-000000000901';
UPDATE notifications SET recovery_request_id = '00000000-0000-4000-8000-000000000901';

-- ---------- device attestation keys (SEC-07) ----------
INSERT INTO device_attestation_keys (id, user_id, key_id_hash, public_key)
VALUES ('00000000-0000-4000-8000-000000000a01', '00000000-0000-4000-8000-000000000011', sha256('key-1'::bytea), '\x04');
UPDATE device_attestation_keys SET sign_count = 1, last_used_at = now() WHERE id = '00000000-0000-4000-8000-000000000a01';
SELECT pg_temp.expect_error($q$
  UPDATE device_attestation_keys SET last_used_at = now() + interval '1 second' WHERE id = '00000000-0000-4000-8000-000000000a01' $q$, '23514');
SELECT pg_temp.expect_error($q$
  UPDATE device_attestation_keys SET sign_count = 0 WHERE id = '00000000-0000-4000-8000-000000000a01' $q$, '23514');
SELECT pg_temp.expect_error($q$
  INSERT INTO device_attestation_keys (user_id, key_id_hash, public_key)
  VALUES ('00000000-0000-4000-8000-000000000012', sha256('key-1'::bytea), '\x04') $q$, '23505');
SELECT pg_temp.expect_error($q$
  INSERT INTO device_attestation_keys (user_id, key_id_hash, public_key) VALUES ('00000000-0000-4000-8000-000000000012', '\x01', '\x04') $q$, '23514');

-- ---------- admin quorum guard ----------
INSERT INTO users (id, email, password_hash) VALUES
  ('00000000-0000-4000-8000-000000000021', 'admin1@example.invalid', 'argon2id$test'),
  ('00000000-0000-4000-8000-000000000022', 'admin2@example.invalid', 'argon2id$test'),
  ('00000000-0000-4000-8000-000000000023', 'admin3@example.invalid', 'argon2id$test');
INSERT INTO user_roles (user_id, role) VALUES
  ('00000000-0000-4000-8000-000000000021', 'system_admin'),
  ('00000000-0000-4000-8000-000000000022', 'system_admin'),
  ('00000000-0000-4000-8000-000000000023', 'system_admin');
SET CONSTRAINTS ALL IMMEDIATE;
UPDATE users SET status = 'suspended' WHERE id = '00000000-0000-4000-8000-000000000023';   -- 3 → 2: allowed
SET CONSTRAINTS ALL DEFERRED;
SELECT pg_temp.expect_error($q$ UPDATE users SET status = 'suspended' WHERE id = '00000000-0000-4000-8000-000000000022' $q$, '23514');
SET CONSTRAINTS ALL DEFERRED;
SELECT pg_temp.expect_error($q$ DELETE FROM user_roles WHERE user_id = '00000000-0000-4000-8000-000000000021' AND role = 'system_admin' $q$, '23514');
-- تبديل مدير بآخر داخل معاملة واحدة مسموح (الفحص مؤجل)
SET CONSTRAINTS ALL DEFERRED;
UPDATE users SET status = 'active' WHERE id = '00000000-0000-4000-8000-000000000023';
DELETE FROM user_roles WHERE user_id = '00000000-0000-4000-8000-000000000022' AND role = 'system_admin';
SET CONSTRAINTS ALL IMMEDIATE;
-- ثغرتا التجاوز في معاملة واحدة (مراجعة الأمن): تعليق ثم حذف الدور، وحذف المستخدم (CASCADE للدور)
SET CONSTRAINTS ALL DEFERRED;
SELECT pg_temp.expect_error($q$
  WITH s AS (UPDATE users SET status = 'suspended' WHERE id = '00000000-0000-4000-8000-000000000021' RETURNING id)
  DELETE FROM user_roles WHERE user_id IN (SELECT id FROM s) AND role = 'system_admin' $q$, '23514');
SET CONSTRAINTS ALL DEFERRED;
SELECT pg_temp.expect_error($q$ DELETE FROM users WHERE id = '00000000-0000-4000-8000-000000000021' $q$, '23514');
SET CONSTRAINTS ALL IMMEDIATE;
SELECT pg_temp.expect_error($q$
  UPDATE recovery_requests SET reset_token_expires_at = decided_at + interval '25 hours' WHERE id = '00000000-0000-4000-8000-000000000901' $q$, '23514');

-- ---------- auth.recovery_completed + audit approved_by ----------
INSERT INTO outbox_events (type, aggregate_type, aggregate_id, idempotency_key, payload)
VALUES ('auth.recovery_completed', 'user', '00000000-0000-4000-8000-000000000011', 'auth.recovery_completed:smoke:1',
        '{"recovery_request_id": "00000000-0000-4000-8000-000000000901"}');
INSERT INTO audit_log (actor_id, action, target_type, target_id, details)
VALUES ('00000000-0000-4000-8000-000000000011', 'auth.recovery_completed', 'user', '00000000-0000-4000-8000-000000000011',
        '{"recovery_request_id": "00000000-0000-4000-8000-000000000901", "approved_by": "00000000-0000-4000-8000-000000000012"}');

-- ---------- user.status_changed (whitelisted payload) ----------
INSERT INTO outbox_events (type, aggregate_type, aggregate_id, idempotency_key, payload)
VALUES ('user.status_changed', 'user', '00000000-0000-4000-8000-000000000011', 'user.status_changed:smoke:1',
        '{"user_id": "00000000-0000-4000-8000-000000000011", "status": "suspended", "reason_code": "suspended"}');
SELECT pg_temp.expect_error($q$
  INSERT INTO outbox_events (type, aggregate_type, aggregate_id, idempotency_key, payload)
  VALUES ('user.status_changed', 'user', '00000000-0000-4000-8000-000000000011', 'user.status_changed:smoke:2',
          '{"user_id": "00000000-0000-4000-8000-000000000011", "status": "suspended", "reason": "free text"}') $q$, '23514');

-- ---------- restore with an empty search_path (pg_restore) ----------
-- pg_restore يعمل بـ search_path فارغ ويطبّق قيود CHECK على كل صف يُستعاد؛ دوال القيود يجب أن تعمل هكذا (#71).
SET LOCAL search_path = '';
SELECT pg_temp.assert(public.outbox_payload_is_whitelisted('material.created', '{"material_id": "00000000-0000-4000-8000-000000000101", "priority": "normal"}'::jsonb),
  'outbox whitelist works with an empty search_path');
SELECT pg_temp.assert(NOT public.outbox_payload_is_whitelisted('material.created', '{"gps": {}}'::jsonb),
  'outbox whitelist still rejects with an empty search_path');
SELECT pg_temp.assert(public.audit_details_is_whitelisted('{"result": "ok"}'::jsonb), 'audit whitelist works with an empty search_path');
SELECT pg_temp.assert(public.material_file_technical_is_whitelisted('{"vfr": true}'::jsonb), 'technical whitelist works with an empty search_path');
INSERT INTO public.outbox_events (type, aggregate_type, aggregate_id, idempotency_key, payload)
VALUES ('material.created', 'material', '00000000-0000-4000-8000-000000000101', 'material.created:restore-sim',
        '{"material_id": "00000000-0000-4000-8000-000000000101", "priority": "normal"}');
SET LOCAL search_path TO DEFAULT;

-- ---------- v0.2 (ADR 0018) ----------
-- البصمة الإدراكية: للأصل وحده، 1–32 عنصرًا بلا NULL
UPDATE material_files SET perceptual_hash = ARRAY[1, -2, 3]::bigint[] WHERE id = '00000000-0000-4000-8000-000000000301';
SELECT pg_temp.expect_error($q$
  UPDATE material_files SET perceptual_hash = ARRAY[1]::bigint[] WHERE id = '00000000-0000-4000-8000-000000000302' $q$, '23514');
SELECT pg_temp.expect_error($q$
  UPDATE material_files SET perceptual_hash = '{}'::bigint[] WHERE id = '00000000-0000-4000-8000-000000000301' $q$, '23514');
SELECT pg_temp.expect_error($q$
  UPDATE material_files SET perceptual_hash = ARRAY[1, NULL]::bigint[] WHERE id = '00000000-0000-4000-8000-000000000301' $q$, '23514');
SELECT pg_temp.expect_error($q$
  UPDATE material_files SET perceptual_hash = (SELECT array_agg(g)::bigint[] FROM generate_series(1, 33) g)
  WHERE id = '00000000-0000-4000-8000-000000000301' $q$, '23514');
-- «اطّلعت»: المستخدم والوقت معًا أو لا شيء
UPDATE materials SET acknowledged_by = '00000000-0000-4000-8000-000000000012', acknowledged_at = now()
WHERE id = '00000000-0000-4000-8000-000000000101';
SELECT pg_temp.expect_error($q$
  UPDATE materials SET acknowledged_at = NULL WHERE id = '00000000-0000-4000-8000-000000000101' $q$, '23514');
-- قواعد التنبيه
INSERT INTO notification_rules (id, name, event_type, priorities, scope_kind, scope_id, recipient_roles, channels, assignment,
                                quiet_hours_start, quiet_hours_end, quiet_hours_tz, created_by)
VALUES ('00000000-0000-4000-8000-000000000b01', 'urgent to supervisors', 'material.urgent_received', ARRAY['urgent'],
        'office', '00000000-0000-4000-8000-000000000001', ARRAY['supervisor'], ARRAY['apns', 'fcm', 'telegram'], true,
        '23:00', '06:00', 'Asia/Gaza', '00000000-0000-4000-8000-000000000012');
SELECT pg_temp.expect_error($q$
  INSERT INTO notification_rules (name, event_type, scope_kind, recipient_roles, channels)
  VALUES ('office without id', 'material.created', 'office', ARRAY['supervisor'], ARRAY['in_app']) $q$, '23514');
INSERT INTO notification_rule_escalations (rule_id, level, after_seconds, recipient_roles, channels)
VALUES ('00000000-0000-4000-8000-000000000b01', 1, 300, ARRAY['editor_in_chief'], ARRAY['apns', 'sms']);
SELECT pg_temp.expect_error($q$
  INSERT INTO notification_rules (name, event_type, channels) VALUES ('no recipient', 'material.created', ARRAY['in_app']) $q$, '23514');
SELECT pg_temp.expect_error($q$
  INSERT INTO notification_rules (name, event_type, recipient_roles, channels)
  VALUES ('bad channel', 'material.created', ARRAY['supervisor'], ARRAY['pigeon']) $q$, '23514');
SELECT pg_temp.expect_error($q$
  INSERT INTO notification_rules (name, event_type, recipient_roles, channels)
  VALUES ('auth event', 'auth.recovery_requested', ARRAY['supervisor'], ARRAY['in_app']) $q$, '23514');
SELECT pg_temp.expect_error($q$
  INSERT INTO notification_rules (name, event_type, recipient_roles, channels, quiet_hours_start)
  VALUES ('half quiet', 'material.created', ARRAY['supervisor'], ARRAY['in_app'], '23:00') $q$, '23514');
SELECT pg_temp.expect_error($q$
  INSERT INTO notification_rules (name, event_type, recipient_permissions, channels)
  VALUES ('bad permission', 'material.created', ARRAY['everything:read'], ARRAY['in_app']) $q$, '23514');
SELECT pg_temp.expect_error($q$
  INSERT INTO notification_rule_escalations (rule_id, level, after_seconds, recipient_roles, channels)
  VALUES ('00000000-0000-4000-8000-000000000b01', 6, 300, ARRAY['editor_in_chief'], ARRAY['apns']) $q$, '23514');
SELECT pg_temp.expect_error($q$
  INSERT INTO notification_rule_escalations (rule_id, level, after_seconds, recipient_roles, channels)
  VALUES ('00000000-0000-4000-8000-000000000b01', 2, 10, ARRAY['editor_in_chief'], ARRAY['apns']) $q$, '23514');
UPDATE notifications SET rule_id = '00000000-0000-4000-8000-000000000b01';
DELETE FROM notification_rules WHERE id = '00000000-0000-4000-8000-000000000b01';
SELECT pg_temp.assert((SELECT count(*) = 0 FROM notification_rule_escalations), 'escalations go with their rule');
SELECT pg_temp.assert(NOT EXISTS (SELECT 1 FROM notifications WHERE rule_id IS NOT NULL) AND EXISTS (SELECT 1 FROM notifications), 'notifications keep their row when the rule is deleted');
-- حزمة التصدير: طلب لكل أصل، والجاهز يشير إلى مشتق export، والفشل بسبب من القائمة
INSERT INTO material_exports (source_file_id, material_id, requested_by)
VALUES ('00000000-0000-4000-8000-000000000301', '00000000-0000-4000-8000-000000000101', '00000000-0000-4000-8000-000000000012');
SELECT pg_temp.expect_error($q$
  INSERT INTO material_exports (source_file_id, material_id, requested_by)
  VALUES ('00000000-0000-4000-8000-000000000301', '00000000-0000-4000-8000-000000000101', '00000000-0000-4000-8000-000000000012') $q$, '23505');
SELECT pg_temp.expect_error($q$
  UPDATE material_exports SET state = 'ready' WHERE source_file_id = '00000000-0000-4000-8000-000000000301' $q$, '23514');
SELECT pg_temp.expect_error($q$
  UPDATE material_exports SET state = 'failed', failure_reason = 'because' WHERE source_file_id = '00000000-0000-4000-8000-000000000301' $q$, '23514');
INSERT INTO material_files (id, material_id, kind, state, derived_from_id, mime_type, sha256, verified_at)
VALUES ('00000000-0000-4000-8000-000000000303', '00000000-0000-4000-8000-000000000101', 'export', 'verified',
        '00000000-0000-4000-8000-000000000301', 'application/zip', sha256('zip'::bytea), now());
UPDATE material_exports SET state = 'ready', file_id = '00000000-0000-4000-8000-000000000303'
WHERE source_file_id = '00000000-0000-4000-8000-000000000301';
INSERT INTO outbox_events (type, aggregate_type, aggregate_id, idempotency_key, payload)
VALUES ('export.requested', 'material', '00000000-0000-4000-8000-000000000101', 'export.requested:smoke:1',
        '{"material_id": "00000000-0000-4000-8000-000000000101", "source_file_id": "00000000-0000-4000-8000-000000000301",
          "requested_by": "00000000-0000-4000-8000-000000000012"}');
SELECT pg_temp.expect_error($q$
  INSERT INTO outbox_events (type, aggregate_type, aggregate_id, idempotency_key, payload)
  VALUES ('export.requested', 'material', '00000000-0000-4000-8000-000000000101', 'export.requested:smoke:2',
          '{"material_id": "00000000-0000-4000-8000-000000000101", "permissions": ["sensitive_location:read"]}') $q$, '23514');
INSERT INTO audit_log (actor_id, action, target_type, target_id, details)
VALUES ('00000000-0000-4000-8000-000000000012', 'notification_rule.deleted', 'notification_rule', '00000000-0000-4000-8000-000000000b01',
        '{"rule_id": "00000000-0000-4000-8000-000000000b01"}');

-- ---------- reporter identity setting (ADR 0021) ----------
SELECT pg_temp.assert((SELECT value = 'separate' FROM system_settings WHERE key = 'reporter_legal_name_access'),
  'reporter identity access defaults to separate');
SELECT pg_temp.expect_error($q$
  UPDATE system_settings SET value = 'everyone' WHERE key = 'reporter_legal_name_access' $q$, '23514');
SELECT pg_temp.expect_error($q$
  INSERT INTO system_settings (key, value) VALUES ('anything_else', 'x') $q$, '23514');
UPDATE system_settings SET value = 'protected_source', updated_by = '00000000-0000-4000-8000-000000000012'
WHERE key = 'reporter_legal_name_access';
INSERT INTO user_permissions (user_id, permission, granted_by, reason)
VALUES ('00000000-0000-4000-8000-000000000011', 'reporter_identity:read', '00000000-0000-4000-8000-000000000012', 'smoke');
SELECT pg_temp.assert((SELECT count(*) = 1 FROM audit_log WHERE action = 'permission.granted' AND details ->> 'permission' = 'reporter_identity:read'),
  'granting reporter_identity:read is audited');
INSERT INTO outbox_events (type, aggregate_type, aggregate_id, idempotency_key, payload)
VALUES ('setting.changed', 'user', '00000000-0000-4000-8000-000000000012', 'setting.changed:smoke:1',
        '{"setting": "reporter_legal_name_access", "value": "protected_source", "actor_id": "00000000-0000-4000-8000-000000000012", "reason_code": "operational_need"}');
SELECT pg_temp.expect_error($q$
  INSERT INTO outbox_events (type, aggregate_type, aggregate_id, idempotency_key, payload)
  VALUES ('setting.changed', 'user', '00000000-0000-4000-8000-000000000012', 'setting.changed:smoke:2',
          '{"setting": "reporter_legal_name_access", "value": "protected_source", "note": "free text"}') $q$, '23514');
INSERT INTO audit_log (actor_id, action, target_type, target_id, details)
VALUES ('00000000-0000-4000-8000-000000000012', 'setting.changed', 'setting', 'reporter_legal_name_access',
        '{"setting": "reporter_legal_name_access", "value": "protected_source", "reason_code": "operational_need"}');

-- قاعدة تنبيه بالصلاحية الجديدة (ADR 0021)
INSERT INTO notification_rules (name, event_type, recipient_permissions, channels)
VALUES ('identity holders', 'material.created', ARRAY['reporter_identity:read'], ARRAY['in_app']);

-- «الوارد الآن» (ADR 0024): تقدّم الرفع بأرقام ومعرّفات فقط، ولا قاعدة تنبيه عليه
INSERT INTO outbox_events (type, aggregate_type, aggregate_id, idempotency_key, payload)
VALUES ('upload.progress', 'upload', '00000000-0000-4000-8000-000000000012', 'upload.progress:smoke:1',
        '{"material_id": "00000000-0000-4000-8000-000000000012", "upload_session_id": "00000000-0000-4000-8000-000000000012", "kind": "original", "priority": "urgent", "bytes_received": 104857600, "size_bytes": 1048576000}');
SELECT pg_temp.expect_error($q$
  INSERT INTO outbox_events (type, aggregate_type, aggregate_id, idempotency_key, payload)
  VALUES ('upload.progress', 'upload', '00000000-0000-4000-8000-000000000012', 'upload.progress:smoke:2',
          '{"material_id": "00000000-0000-4000-8000-000000000012", "bytes_received": 1, "size_bytes": 2, "filename": "clip.mov"}') $q$, '23514');
SELECT pg_temp.expect_error($q$
  INSERT INTO notification_rules (name, event_type, recipient_roles, channels)
  VALUES ('progress noise', 'upload.progress', ARRAY['supervisor'], ARRAY['in_app']) $q$, '23514');

-- ---------- v0.3: قوالب التراخيص والإدراج (ADR 0025) ----------
INSERT INTO license_templates (id, type, created_by) VALUES
  ('00000000-0000-4000-8000-000000000601', 'editorial_single', '00000000-0000-4000-8000-000000000014'),
  ('00000000-0000-4000-8000-000000000602', 'exclusive_temporary', '00000000-0000-4000-8000-000000000014'),
  ('00000000-0000-4000-8000-000000000603', 'commercial', '00000000-0000-4000-8000-000000000014');
INSERT INTO license_template_versions (template_id, version, type, name_ar, name_en, terms_ar, terms_en, usage_media,
  territory_kind, deliverables, attribution_ar, attribution_en, prohibitions, base_price_minor, currency, enabled, created_by)
VALUES ('00000000-0000-4000-8000-000000000601', 1, 'editorial_single', 'تحريري', 'Editorial', 'شروط', 'Terms', '{tv,web}',
        'worldwide', '{original}', 'فلسطين بوست', 'Palestine Post', '{resale,ai_training}', 20000, 'USD', true,
        '00000000-0000-4000-8000-000000000014');
INSERT INTO license_template_versions (template_id, version, type, name_ar, name_en, terms_ar, terms_en, usage_media,
  territory_kind, deliverables, attribution_ar, attribution_en, base_price_minor, currency, enabled, created_by,
  term_days, exclusivity_hours)
VALUES ('00000000-0000-4000-8000-000000000602', 1, 'exclusive_temporary', 'حصري', 'Exclusive', 'شروط', 'Terms', '{tv}',
        'worldwide', '{original}', 'فلسطين بوست', 'Palestine Post', 150000, 'USD', true,
        '00000000-0000-4000-8000-000000000014', 30, 72);
SELECT pg_temp.expect_error($q$
  UPDATE license_template_versions SET base_price_minor = 1 WHERE template_id = '00000000-0000-4000-8000-000000000601' $q$, '23001');
SELECT pg_temp.expect_error($q$
  DELETE FROM license_template_versions WHERE template_id = '00000000-0000-4000-8000-000000000601' $q$, '23001');
-- النوع ثابت، والإصدار بلا فجوة، والحصرية لـ exclusive_temporary وحده، والعملة من القائمة
SELECT pg_temp.expect_error($q$
  INSERT INTO license_template_versions (template_id, version, type, name_ar, name_en, terms_ar, terms_en, usage_media,
    territory_kind, deliverables, attribution_ar, attribution_en, base_price_minor, currency, enabled, created_by)
  VALUES ('00000000-0000-4000-8000-000000000601', 2, 'commercial', 'x', 'x', 'x', 'x', '{tv}', 'worldwide', '{original}',
          'x', 'x', 1, 'USD', true, '00000000-0000-4000-8000-000000000014') $q$, '23514');
SELECT pg_temp.expect_error($q$
  INSERT INTO license_template_versions (template_id, version, type, name_ar, name_en, terms_ar, terms_en, usage_media,
    territory_kind, deliverables, attribution_ar, attribution_en, base_price_minor, currency, enabled, created_by)
  VALUES ('00000000-0000-4000-8000-000000000601', 3, 'editorial_single', 'x', 'x', 'x', 'x', '{tv}', 'worldwide', '{original}',
          'x', 'x', 1, 'USD', true, '00000000-0000-4000-8000-000000000014') $q$, '23514');
SELECT pg_temp.expect_error($q$
  INSERT INTO license_template_versions (template_id, version, type, name_ar, name_en, terms_ar, terms_en, usage_media,
    territory_kind, deliverables, attribution_ar, attribution_en, base_price_minor, currency, enabled, created_by, exclusivity_hours)
  VALUES ('00000000-0000-4000-8000-000000000601', 2, 'editorial_single', 'x', 'x', 'x', 'x', '{tv}', 'worldwide', '{original}',
          'x', 'x', 1, 'USD', true, '00000000-0000-4000-8000-000000000014', 24) $q$, '23514');
SELECT pg_temp.expect_error($q$
  INSERT INTO license_template_versions (template_id, version, type, name_ar, name_en, terms_ar, terms_en, usage_media,
    territory_kind, deliverables, attribution_ar, attribution_en, base_price_minor, currency, enabled, created_by)
  VALUES ('00000000-0000-4000-8000-000000000601', 2, 'editorial_single', 'x', 'x', 'x', 'x', '{tv}', 'worldwide', '{original}',
          'x', 'x', 1, 'EUR', true, '00000000-0000-4000-8000-000000000014') $q$, '23514');
INSERT INTO license_template_versions (template_id, version, type, name_ar, name_en, terms_ar, terms_en, usage_media,
  territory_kind, territory_countries, deliverables, attribution_ar, attribution_en, base_price_minor, currency, enabled, created_by)
VALUES ('00000000-0000-4000-8000-000000000601', 2, 'editorial_single', 'تحريري', 'Editorial', 'شروط', 'Terms', '{web}',
        'countries', '{PS,JO}', '{original}', 'فلسطين بوست', 'Palestine Post', 25000, 'USD', true,
        '00000000-0000-4000-8000-000000000014');

-- لا تفريغ في التسليم (R11)
SELECT pg_temp.expect_error($q$
  INSERT INTO license_template_versions (template_id, version, type, name_ar, name_en, terms_ar, terms_en, usage_media,
    territory_kind, deliverables, attribution_ar, attribution_en, base_price_minor, currency, enabled, created_by)
  VALUES ('00000000-0000-4000-8000-000000000601', 3, 'editorial_single', 'x', 'x', 'x', 'x', '{tv}', 'worldwide',
          '{original,transcript}', 'x', 'x', 1, 'USD', true, '00000000-0000-4000-8000-000000000014') $q$, '23514');

-- «معروض» يلزمه sellable من الجهتين
SELECT pg_temp.expect_error($q$
  INSERT INTO catalog_listings (material_id, material_version, state, title_ar, title_en, description_ar, description_en,
    listed_at, updated_by)
  VALUES ('00000000-0000-4000-8000-000000000101', 1, 'listed', 'ع', 'T', 'و', 'D', now(),
          '00000000-0000-4000-8000-000000000014') $q$, '23514');
INSERT INTO catalog_listings (id, material_id, material_version, state, title_ar, title_en, description_ar, description_en, updated_by)
VALUES ('00000000-0000-4000-8000-000000000611', '00000000-0000-4000-8000-000000000101', 1, 'draft', 'ع', 'T', 'و', 'D',
        '00000000-0000-4000-8000-000000000014');
INSERT INTO listing_offers (listing_id, license_template_id)
VALUES ('00000000-0000-4000-8000-000000000611', '00000000-0000-4000-8000-000000000601');
SELECT pg_temp.expect_error($q$
  INSERT INTO listing_offers (listing_id, license_template_id)
  VALUES ('00000000-0000-4000-8000-000000000611', '00000000-0000-4000-8000-000000000603') $q$, '23514');
SELECT pg_temp.expect_error($q$
  INSERT INTO listing_offers (listing_id, license_template_id, price_override_minor)
  VALUES ('00000000-0000-4000-8000-000000000611', '00000000-0000-4000-8000-000000000602', 100) $q$, '23514');
UPDATE materials SET rights_state = 'sellable' WHERE id = '00000000-0000-4000-8000-000000000101';
UPDATE catalog_listings SET state = 'listed', listed_at = now() WHERE id = '00000000-0000-4000-8000-000000000611';
SELECT pg_temp.expect_error($q$
  UPDATE materials SET rights_state = 'blocked' WHERE id = '00000000-0000-4000-8000-000000000101' $q$, '23514');
SELECT pg_temp.expect_error($q$
  UPDATE catalog_listings SET state = 'suspended' WHERE id = '00000000-0000-4000-8000-000000000611' $q$, '23514');
UPDATE catalog_listings SET state = 'suspended', suspended_reason = 'rights_changed'
 WHERE id = '00000000-0000-4000-8000-000000000611';
UPDATE materials SET rights_state = 'blocked' WHERE id = '00000000-0000-4000-8000-000000000101';
-- الإذن التجاري: يُضاف العرض بعده، ولا يُسحب الإذن والعرض قائم
UPDATE catalog_listings SET commercial_allowed = true WHERE id = '00000000-0000-4000-8000-000000000611';
INSERT INTO listing_offers (listing_id, license_template_id)
VALUES ('00000000-0000-4000-8000-000000000611', '00000000-0000-4000-8000-000000000603');
SELECT pg_temp.expect_error($q$
  UPDATE catalog_listings SET commercial_allowed = false WHERE id = '00000000-0000-4000-8000-000000000611' $q$, '23514');
INSERT INTO outbox_events (type, aggregate_type, aggregate_id, idempotency_key, payload)
VALUES ('catalog.listing_changed', 'listing', '00000000-0000-4000-8000-000000000611', 'catalog.listing_changed:smoke:1',
        '{"listing_id": "00000000-0000-4000-8000-000000000611", "material_id": "00000000-0000-4000-8000-000000000101", "material_version": 1, "source_file_id": "00000000-0000-4000-8000-000000000301", "state": "suspended", "suspended_reason": "rights_changed"}');
SELECT pg_temp.expect_error($q$
  INSERT INTO outbox_events (type, aggregate_type, aggregate_id, idempotency_key, payload)
  VALUES ('catalog.listing_changed', 'listing', '00000000-0000-4000-8000-000000000611', 'catalog.listing_changed:smoke:2',
          '{"listing_id": "00000000-0000-4000-8000-000000000611", "title": "x"}') $q$, '23514');

-- ---------- indexing policy (ADR 0002) ----------
SELECT pg_temp.assert(
  NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexdef ILIKE '%USING gin%'),
  'no GIN index anywhere (dynamic fields are JSONB without a blanket GIN)');
SELECT pg_temp.assert(
  (SELECT count(*) = 4 FROM pg_indexes WHERE schemaname = 'public' AND indexname IN
    ('materials_board_idx', 'materials_reporter_idx', 'materials_governorate_shot_idx', 'materials_technical_inflight_idx')),
  'composite B-tree indexes on high-frequency material columns exist');
SELECT pg_temp.assert(
  (SELECT count(*) = 1 FROM pg_indexes WHERE indexname = 'outbox_events_pending_idx' AND indexdef ILIKE '%WHERE (published_at IS NULL)%'),
  'outbox dispatcher partial index exists');

-- حزمة تسليم المشتري (ADR 0025 الجزء 9): لكل ترخيص حزمته، وlicense_id للتسليم وحده
-- تسجيل المشتق المتساوي الأثر يستدل الفهرس الجزئي بشرطه الكامل؛ الشرط القديم وحده لا يطابقه بعد هذا الترحيل
INSERT INTO material_files (material_id, kind, state, derived_from_id)
VALUES ('00000000-0000-4000-8000-000000000101', 'proxy', 'received', '00000000-0000-4000-8000-000000000301')
ON CONFLICT (derived_from_id, kind) WHERE derived_from_id IS NOT NULL AND kind <> 'delivery' DO NOTHING;
SELECT pg_temp.expect_error($q$
  INSERT INTO material_files (material_id, kind, state, derived_from_id)
  VALUES ('00000000-0000-4000-8000-000000000101', 'proxy', 'received', '00000000-0000-4000-8000-000000000301')
  ON CONFLICT (derived_from_id, kind) WHERE derived_from_id IS NOT NULL DO NOTHING $q$, '42P10');
INSERT INTO material_files (material_id, kind, state, derived_from_id, license_id)
VALUES ('00000000-0000-4000-8000-000000000101', 'delivery', 'received', '00000000-0000-4000-8000-000000000301', '00000000-0000-4000-8000-000000000801');
INSERT INTO material_files (material_id, kind, state, derived_from_id, license_id)
VALUES ('00000000-0000-4000-8000-000000000101', 'delivery', 'received', '00000000-0000-4000-8000-000000000301', '00000000-0000-4000-8000-000000000802');
SELECT pg_temp.expect_error($q$
  INSERT INTO material_files (material_id, kind, state, derived_from_id, license_id)
  VALUES ('00000000-0000-4000-8000-000000000101', 'delivery', 'received', '00000000-0000-4000-8000-000000000301', '00000000-0000-4000-8000-000000000801') $q$, '23505');
SELECT pg_temp.expect_error($q$
  INSERT INTO material_files (material_id, kind, state, derived_from_id)
  VALUES ('00000000-0000-4000-8000-000000000101', 'delivery', 'received', '00000000-0000-4000-8000-000000000301') $q$, '23514');
SELECT pg_temp.expect_error($q$
  INSERT INTO material_files (material_id, kind, state, derived_from_id, license_id)
  VALUES ('00000000-0000-4000-8000-000000000101', 'export', 'received', '00000000-0000-4000-8000-000000000301', '00000000-0000-4000-8000-000000000801') $q$, '23514');
INSERT INTO outbox_events (type, aggregate_type, aggregate_id, idempotency_key, payload)
VALUES ('license.delivery_requested', 'license', '00000000-0000-4000-8000-000000000801', 'license.delivery_requested:smoke:1',
        '{"license_id": "00000000-0000-4000-8000-000000000801", "material_id": "00000000-0000-4000-8000-000000000101", "source_file_id": "00000000-0000-4000-8000-000000000301", "deliverables": ["original", "audio"], "produced_file_id": null}');
SELECT pg_temp.expect_error($q$
  INSERT INTO outbox_events (type, aggregate_type, aggregate_id, idempotency_key, payload)
  VALUES ('license.delivery_requested', 'license', '00000000-0000-4000-8000-000000000801', 'license.delivery_requested:smoke:2',
          '{"license_id": "00000000-0000-4000-8000-000000000801", "buyer_name": "x"}') $q$, '23514');

\o
\echo smoke OK
ROLLBACK;
