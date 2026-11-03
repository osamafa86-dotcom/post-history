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

-- وسوم المادة (ADR 0086): فارغة افتراضيًا، 12 على الأكثر بلا تكرار، كلٌّ 1–40 محرفًا مشذَّبًا بلا محارف تحكم أو اتجاه
SELECT pg_temp.assert((SELECT tags = '{}' FROM materials WHERE id = '00000000-0000-4000-8000-000000000101'), 'tags default to empty');
UPDATE materials SET tags = '{مساعدات,النصيرات,"وكالة الغوث UNRWA"}' WHERE id = '00000000-0000-4000-8000-000000000101';
SELECT pg_temp.assert((SELECT cardinality(tags) = 3 FROM materials WHERE id = '00000000-0000-4000-8000-000000000101'), 'three tags stored');
SELECT pg_temp.expect_error($q$ UPDATE materials SET tags = '{a1,a2,a3,a4,a5,a6,a7,a8,a9,a10,a11,a12,a13}' WHERE id = '00000000-0000-4000-8000-000000000101' $q$, '23514');
SELECT pg_temp.expect_error($q$ UPDATE materials SET tags = '{مطر,مطر}' WHERE id = '00000000-0000-4000-8000-000000000101' $q$, '23514');
SELECT pg_temp.expect_error($q$ UPDATE materials SET tags = '{""}' WHERE id = '00000000-0000-4000-8000-000000000101' $q$, '23514');
SELECT pg_temp.expect_error($q$ UPDATE materials SET tags = ARRAY[' مطر'] WHERE id = '00000000-0000-4000-8000-000000000101' $q$, '23514');
SELECT pg_temp.expect_error($q$ UPDATE materials SET tags = ARRAY[repeat('و', 41)] WHERE id = '00000000-0000-4000-8000-000000000101' $q$, '23514');
SELECT pg_temp.expect_error($q$ UPDATE materials SET tags = ARRAY[E'\u202Eمطر'] WHERE id = '00000000-0000-4000-8000-000000000101' $q$, '23514');
SELECT pg_temp.expect_error($q$ UPDATE materials SET tags = ARRAY[NULL::text] WHERE id = '00000000-0000-4000-8000-000000000101' $q$, '23514');
SELECT pg_temp.expect_error($q$ UPDATE materials SET tags = NULL WHERE id = '00000000-0000-4000-8000-000000000101' $q$, '23502');
-- رفض بحسب كل قاعدة في القيد (الأمثلة بتهريبات E'' فلا محارف غير مرئية في الملف): محارف التحكم C0 وDEL وC1
SELECT pg_temp.expect_error($q$ UPDATE materials SET tags = ARRAY[E'\u0001'] WHERE id = '00000000-0000-4000-8000-000000000101' $q$, '23514');
SELECT pg_temp.expect_error($q$ UPDATE materials SET tags = ARRAY[E'م\tطر'] WHERE id = '00000000-0000-4000-8000-000000000101' $q$, '23514');
SELECT pg_temp.expect_error($q$ UPDATE materials SET tags = ARRAY[E'م\x7fطر'] WHERE id = '00000000-0000-4000-8000-000000000101' $q$, '23514');
SELECT pg_temp.expect_error($q$ UPDATE materials SET tags = ARRAY[E'م\u0085ط'] WHERE id = '00000000-0000-4000-8000-000000000101' $q$, '23514');
SELECT pg_temp.expect_error($q$ UPDATE materials SET tags = ARRAY[E'م\u009fط'] WHERE id = '00000000-0000-4000-8000-000000000101' $q$, '23514');
-- محارف الاتجاه: العلامتان LRM/RLM، وU+202A، والعزل U+2066 وU+2069، وعلامة الحرف العربي U+061C
SELECT pg_temp.expect_error($q$ UPDATE materials SET tags = ARRAY[E'\u200eمطر'] WHERE id = '00000000-0000-4000-8000-000000000101' $q$, '23514');
SELECT pg_temp.expect_error($q$ UPDATE materials SET tags = ARRAY[E'مطر\u200f'] WHERE id = '00000000-0000-4000-8000-000000000101' $q$, '23514');
SELECT pg_temp.expect_error($q$ UPDATE materials SET tags = ARRAY[E'م\u202aطر'] WHERE id = '00000000-0000-4000-8000-000000000101' $q$, '23514');
SELECT pg_temp.expect_error($q$ UPDATE materials SET tags = ARRAY[E'م\u2066ط'] WHERE id = '00000000-0000-4000-8000-000000000101' $q$, '23514');
SELECT pg_temp.expect_error($q$ UPDATE materials SET tags = ARRAY[E'م\u2069ط'] WHERE id = '00000000-0000-4000-8000-000000000101' $q$, '23514');
SELECT pg_temp.expect_error($q$ UPDATE materials SET tags = ARRAY[E'م\u061cطر'] WHERE id = '00000000-0000-4000-8000-000000000101' $q$, '23514');
-- المسافة في الطرفين: الفراغ الأخير، وU+00A0 وحدها أو في أول الوسم، وفراغات يونيكود لا يقصّها btrim (U+3000 وU+FEFF وU+2028)
SELECT pg_temp.expect_error($q$ UPDATE materials SET tags = ARRAY[E'مطر\x20'] WHERE id = '00000000-0000-4000-8000-000000000101' $q$, '23514');
SELECT pg_temp.expect_error($q$ UPDATE materials SET tags = ARRAY[E'\u00a0'] WHERE id = '00000000-0000-4000-8000-000000000101' $q$, '23514');
SELECT pg_temp.expect_error($q$ UPDATE materials SET tags = ARRAY[E'\u00a0مطر'] WHERE id = '00000000-0000-4000-8000-000000000101' $q$, '23514');
SELECT pg_temp.expect_error($q$ UPDATE materials SET tags = ARRAY[E'مطر\u3000'] WHERE id = '00000000-0000-4000-8000-000000000101' $q$, '23514');
SELECT pg_temp.expect_error($q$ UPDATE materials SET tags = ARRAY[E'مطر\ufeff'] WHERE id = '00000000-0000-4000-8000-000000000101' $q$, '23514');
SELECT pg_temp.expect_error($q$ UPDATE materials SET tags = ARRAY[E'مطر\u2028'] WHERE id = '00000000-0000-4000-8000-000000000101' $q$, '23514');
-- الطول يُعدّ بنقاط الترميز لا بالوحدات: 41 محرفًا خارج BMP مرفوضة
SELECT pg_temp.expect_error($q$ UPDATE materials SET tags = ARRAY[repeat(chr(128167), 41)] WHERE id = '00000000-0000-4000-8000-000000000101' $q$, '23514');
-- الصنف كله لا أمثلة متفرقة (مجموعات المحارف نفسها في نمط MaterialTag بـ openapi.yaml): كل محرف مسافة يُرفض وحده وفي أول الوسم وفي آخره
SELECT pg_temp.assert(
  (SELECT bool_and(NOT material_tags_valid(ARRAY[chr(cp)])
                   AND NOT material_tags_valid(ARRAY[chr(cp) || 'مطر'])
                   AND NOT material_tags_valid(ARRAY['مطر' || chr(cp)]))
   FROM (SELECT generate_series(9, 13) AS cp
         UNION ALL SELECT unnest(ARRAY[32, 160, 5760, 8232, 8233, 8239, 8287, 12288, 65279])
         UNION ALL SELECT generate_series(8192, 8202)) AS ws),
  'every whitespace character of the JSON Schema class is rejected alone, first and last');
-- ... ويُقبل داخل الوسم ما عدا ما هو تحكم أصلًا (U+0009–U+000D)
SELECT pg_temp.assert(
  (SELECT bool_and(material_tags_valid(ARRAY['م' || chr(cp) || 'ط']))
   FROM (SELECT unnest(ARRAY[32, 160, 5760, 8232, 8233, 8239, 8287, 12288, 65279])
         UNION ALL SELECT generate_series(8192, 8202)) AS ws(cp)),
  'whitespace inside a tag is accepted');
-- محارف التحكم والاتجاه تُرفض في كل موضع: C0 وDEL وC1 وU+061C وLRM/RLM وU+202A–U+202E وU+2066–U+2069
SELECT pg_temp.assert(
  (SELECT bool_and(NOT material_tags_valid(ARRAY[chr(cp)])
                   AND NOT material_tags_valid(ARRAY[chr(cp) || 'مطر'])
                   AND NOT material_tags_valid(ARRAY['م' || chr(cp) || 'ط'])
                   AND NOT material_tags_valid(ARRAY['مطر' || chr(cp)]))
   FROM (SELECT generate_series(1, 31) AS cp
         UNION ALL SELECT generate_series(127, 159)
         UNION ALL SELECT unnest(ARRAY[1564, 8206, 8207])
         UNION ALL SELECT generate_series(8234, 8238)
         UNION ALL SELECT generate_series(8294, 8297)) AS bad),
  'every control and direction character is rejected in every position');
-- الجيران القريبون من الصنفين يُقبلون في كل موضع (ZWNJ وZWJ لازمان للعربية والفارسية، وU+061B وU+061D قبل U+061C وبعدها)
SELECT pg_temp.assert(
  (SELECT bool_and(material_tags_valid(ARRAY[chr(cp)])
                   AND material_tags_valid(ARRAY[chr(cp) || 'مطر'])
                   AND material_tags_valid(ARRAY['م' || chr(cp) || 'ط'])
                   AND material_tags_valid(ARRAY['مطر' || chr(cp)]))
   FROM unnest(ARRAY[33, 126, 161, 173, 1563, 1565, 6158, 8203, 8204, 8205, 8208, 8293, 8298]) AS ok(cp)),
  'characters next to the rejected classes are still accepted in every position');
SELECT pg_temp.assert(
  (SELECT count(*) = 1 FROM materials WHERE tags @> '{مساعدات}'),
  'materials are found by tag');
-- حدود القبول: اثنا عشر وسمًا، ووسم من 40 محرفًا (بالعربية وخارج BMP)، ووسم من محرف واحد، ومسافات وZWNJ وZWJ داخل الوسم
UPDATE materials SET tags = ARRAY(SELECT 'tag' || g FROM generate_series(1, 12) g) WHERE id = '00000000-0000-4000-8000-000000000101';
SELECT pg_temp.assert((SELECT cardinality(tags) = 12 FROM materials WHERE id = '00000000-0000-4000-8000-000000000101'), 'twelve tags are accepted');
UPDATE materials SET tags = ARRAY[repeat('و', 40)] WHERE id = '00000000-0000-4000-8000-000000000101';
SELECT pg_temp.assert((SELECT char_length(tags[1]) = 40 FROM materials WHERE id = '00000000-0000-4000-8000-000000000101'), 'a 40-character tag is accepted');
UPDATE materials SET tags = ARRAY[repeat(chr(128167), 40)] WHERE id = '00000000-0000-4000-8000-000000000101';
SELECT pg_temp.assert((SELECT char_length(tags[1]) = 40 FROM materials WHERE id = '00000000-0000-4000-8000-000000000101'), 'a 40-code-point tag outside the BMP is accepted');
UPDATE materials SET tags = ARRAY['م'] WHERE id = '00000000-0000-4000-8000-000000000101';
SELECT pg_temp.assert((SELECT char_length(tags[1]) = 1 FROM materials WHERE id = '00000000-0000-4000-8000-000000000101'), 'a one-character tag is accepted');
UPDATE materials SET tags = ARRAY['م ط', E'م\u00a0ط', E'م\u3000ط', E'م\u200cط', E'م\u200dط'] WHERE id = '00000000-0000-4000-8000-000000000101';
SELECT pg_temp.assert((SELECT cardinality(tags) = 5 FROM materials WHERE id = '00000000-0000-4000-8000-000000000101'), 'inner spaces, ZWNJ and ZWJ are accepted');
UPDATE materials SET tags = '{مساعدات,النصيرات,"وكالة الغوث UNRWA"}' WHERE id = '00000000-0000-4000-8000-000000000101';
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
SELECT pg_temp.expect_error($q$ UPDATE material_files SET technical = '{"video_codec": "h264", "location": "planted"}' WHERE id = '00000000-0000-4000-8000-000000000301' $q$, '23514');
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
SELECT pg_temp.assert(public.material_tags_valid(ARRAY['مطر', 'ركام']) AND NOT public.material_tags_valid(ARRAY['مطر', 'مطر']),
  'tags check accepts and rejects with an empty search_path');
SELECT pg_temp.assert(NOT public.material_tags_valid(ARRAY[E'\u00a0']) AND NOT public.material_tags_valid(ARRAY[E'م\u061cط']),
  'tags check applies its whitespace and direction rules with an empty search_path');
UPDATE public.materials SET tags = '{مطر,ركام}' WHERE id = '00000000-0000-4000-8000-000000000101';
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
-- المادة الموسومة بالحساسية لا تُعرض، من الجهتين؛ الخادم يعلّق بـ sensitive_flagged أولًا
UPDATE materials SET sensitivity_minors = true WHERE id = '00000000-0000-4000-8000-000000000101';
SELECT pg_temp.expect_error($q$
  UPDATE catalog_listings SET state = 'listed', suspended_reason = NULL WHERE id = '00000000-0000-4000-8000-000000000611' $q$, '23514');
UPDATE materials SET sensitivity_minors = false WHERE id = '00000000-0000-4000-8000-000000000101';
UPDATE catalog_listings SET state = 'listed', suspended_reason = NULL WHERE id = '00000000-0000-4000-8000-000000000611';
SELECT pg_temp.expect_error($q$
  UPDATE materials SET sensitivity_graphic = true WHERE id = '00000000-0000-4000-8000-000000000101' $q$, '23514');
SELECT pg_temp.expect_error($q$
  UPDATE materials SET sensitivity_injured = true WHERE id = '00000000-0000-4000-8000-000000000101' $q$, '23514');
UPDATE catalog_listings SET state = 'suspended', suspended_reason = 'sensitive_flagged' WHERE id = '00000000-0000-4000-8000-000000000611';
UPDATE materials SET sensitivity_graphic = true WHERE id = '00000000-0000-4000-8000-000000000101';
UPDATE materials SET sensitivity_graphic = false WHERE id = '00000000-0000-4000-8000-000000000101';
UPDATE catalog_listings SET suspended_reason = 'rights_changed' WHERE id = '00000000-0000-4000-8000-000000000611';
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

-- ---------- v0.3: مؤسسات المشترين (ADR 0025، الجزء 3) ----------
INSERT INTO buyer_organizations (id, legal_name, display_name_ar, display_name_en, country, billing_email)
VALUES ('00000000-0000-4000-8000-000000000701', 'Example Media Ltd', 'وكالة مثال', 'Example Media', 'GB', 'billing@example.invalid');
SELECT pg_temp.expect_error($q$
  UPDATE buyer_organizations SET status = 'active' WHERE id = '00000000-0000-4000-8000-000000000701' $q$, '23514');
UPDATE buyer_organizations SET status = 'active', verified_at = now(), verified_by = '00000000-0000-4000-8000-000000000014'
 WHERE id = '00000000-0000-4000-8000-000000000701';
INSERT INTO users (id, email, password_hash, organization_id)
VALUES ('00000000-0000-4000-8000-000000000711', 'buyer@example.invalid', 'argon2id$test', '00000000-0000-4000-8000-000000000701');
INSERT INTO user_roles (user_id, role, scope_kind, scope_id)
VALUES ('00000000-0000-4000-8000-000000000711', 'buyer_admin', 'organization', '00000000-0000-4000-8000-000000000701');
-- لا دور طاقم لحساب مشترٍ، ولا دور مشترٍ لطاقم أو بنطاق مؤسسة أخرى، ولا دور مشترٍ بلا نطاق مؤسسة
SELECT pg_temp.expect_error($q$
  INSERT INTO user_roles (user_id, role) VALUES ('00000000-0000-4000-8000-000000000711', 'producer') $q$, '23514');
SELECT pg_temp.expect_error($q$
  INSERT INTO user_roles (user_id, role, scope_kind, scope_id)
  VALUES ('00000000-0000-4000-8000-000000000013', 'buyer_member', 'organization', '00000000-0000-4000-8000-000000000701') $q$, '23514');
SELECT pg_temp.expect_error($q$
  INSERT INTO user_roles (user_id, role, scope_kind, scope_id)
  VALUES ('00000000-0000-4000-8000-000000000711', 'buyer_member', 'organization', '00000000-0000-4000-8000-000000000799') $q$, '23514');
SELECT pg_temp.expect_error($q$
  INSERT INTO user_roles (user_id, role) VALUES ('00000000-0000-4000-8000-000000000711', 'buyer_member') $q$, '23514');
-- المؤسسة لا تتغير بعد الأدوار، ولا مكتب لمشترٍ
SELECT pg_temp.expect_error($q$
  UPDATE users SET organization_id = NULL WHERE id = '00000000-0000-4000-8000-000000000711' $q$, '23514');
SELECT pg_temp.expect_error($q$
  UPDATE users SET office_id = '00000000-0000-4000-8000-000000000001' WHERE id = '00000000-0000-4000-8000-000000000711' $q$, '23514');

-- ---------- v0.3: الطلبات والتراخيص والحصرية (ADR 0025، الجزءان 4 و9؛ ترحيل 030) ----------
UPDATE materials SET rights_state = 'sellable' WHERE id = '00000000-0000-4000-8000-000000000101';
UPDATE catalog_listings SET state = 'listed', suspended_reason = NULL WHERE id = '00000000-0000-4000-8000-000000000611';
INSERT INTO listing_offers (listing_id, license_template_id)
VALUES ('00000000-0000-4000-8000-000000000611', '00000000-0000-4000-8000-000000000602');
SET CONSTRAINTS ALL DEFERRED;
-- البند يجمّد العرض الحي: الإصدار الحالي للقالب بنوعه وسعره، وإصدار المادة المعروض، وعملة الطلب
INSERT INTO orders (id, organization_id, created_by, currency, total_minor, expires_at)
VALUES ('00000000-0000-4000-8000-000000000c01', '00000000-0000-4000-8000-000000000701', '00000000-0000-4000-8000-000000000711',
        'USD', 25000, now() + interval '24 hours');
INSERT INTO order_items (id, order_id, listing_id, material_id, material_version, license_template_id, license_version,
                         license_type, price_minor, currency, title_ar, title_en)
VALUES ('00000000-0000-4000-8000-000000000c11', '00000000-0000-4000-8000-000000000c01', '00000000-0000-4000-8000-000000000611',
        '00000000-0000-4000-8000-000000000101', 1, '00000000-0000-4000-8000-000000000601', 2, 'editorial_single', 25000, 'USD', 'ع', 'T');
SELECT pg_temp.expect_error($q$
  INSERT INTO order_items (order_id, listing_id, material_id, material_version, license_template_id, license_version,
                           license_type, price_minor, currency, title_ar, title_en)
  VALUES ('00000000-0000-4000-8000-000000000c01', '00000000-0000-4000-8000-000000000611', '00000000-0000-4000-8000-000000000101',
          1, '00000000-0000-4000-8000-000000000601', 1, 'editorial_single', 20000, 'USD', 'ع', 'T') $q$, '23514');
SELECT pg_temp.expect_error($q$
  INSERT INTO order_items (order_id, listing_id, material_id, material_version, license_template_id, license_version,
                           license_type, price_minor, currency, title_ar, title_en)
  VALUES ('00000000-0000-4000-8000-000000000c01', '00000000-0000-4000-8000-000000000611', '00000000-0000-4000-8000-000000000101',
          1, '00000000-0000-4000-8000-000000000602', 1, 'exclusive_temporary', 1, 'USD', 'ع', 'T') $q$, '23514');
SELECT pg_temp.expect_error($q$
  INSERT INTO order_items (order_id, listing_id, material_id, material_version, license_template_id, license_version,
                           license_type, price_minor, currency, title_ar, title_en)
  VALUES ('00000000-0000-4000-8000-000000000c01', '00000000-0000-4000-8000-000000000611', '00000000-0000-4000-8000-000000000101',
          1, '00000000-0000-4000-8000-000000000602', 1, 'commercial', 150000, 'USD', 'ع', 'T') $q$, '23514');
SELECT pg_temp.expect_error($q$
  INSERT INTO order_items (order_id, listing_id, material_id, material_version, license_template_id, license_version,
                           license_type, price_minor, currency, title_ar, title_en)
  VALUES ('00000000-0000-4000-8000-000000000c01', '00000000-0000-4000-8000-000000000611', '00000000-0000-4000-8000-000000000101',
          2, '00000000-0000-4000-8000-000000000602', 1, 'exclusive_temporary', 150000, 'USD', 'ع', 'T') $q$, '23514');
SELECT pg_temp.expect_error($q$
  INSERT INTO order_items (order_id, listing_id, material_id, material_version, license_template_id, license_version,
                           license_type, price_minor, currency, title_ar, title_en)
  VALUES ('00000000-0000-4000-8000-000000000c01', '00000000-0000-4000-8000-000000000611', '00000000-0000-4000-8000-000000000101',
          1, '00000000-0000-4000-8000-000000000601', 2, 'editorial_single', 25000, 'USD', 'ع', 'T') $q$, '23505');
-- المجموع مجموع البنود، ولا طلب بلا بند، ولا بند بعملة غير عملة الطلب
SELECT pg_temp.expect_error($q$
  INSERT INTO orders (organization_id, created_by, currency, total_minor, expires_at)
  VALUES ('00000000-0000-4000-8000-000000000701', '00000000-0000-4000-8000-000000000711', 'USD', 0, now() + interval '1 hour') $q$, '23514');
SELECT pg_temp.expect_error($q$
  WITH o AS (INSERT INTO orders (organization_id, created_by, currency, total_minor, expires_at)
             VALUES ('00000000-0000-4000-8000-000000000701', '00000000-0000-4000-8000-000000000711', 'USD', 1, now() + interval '1 hour')
             RETURNING id)
  INSERT INTO order_items (order_id, listing_id, material_id, material_version, license_template_id, license_version,
                           license_type, price_minor, currency, title_ar, title_en)
  SELECT o.id, '00000000-0000-4000-8000-000000000611', '00000000-0000-4000-8000-000000000101', 1,
         '00000000-0000-4000-8000-000000000601', 2, 'editorial_single', 25000, 'USD', 'ع', 'T' FROM o $q$, '23514');
SELECT pg_temp.expect_error($q$
  WITH o AS (INSERT INTO orders (organization_id, created_by, currency, total_minor, expires_at)
             VALUES ('00000000-0000-4000-8000-000000000701', '00000000-0000-4000-8000-000000000711', 'ILS', 25000, now() + interval '1 hour')
             RETURNING id)
  INSERT INTO order_items (order_id, listing_id, material_id, material_version, license_template_id, license_version,
                           license_type, price_minor, currency, title_ar, title_en)
  SELECT o.id, '00000000-0000-4000-8000-000000000611', '00000000-0000-4000-8000-000000000101', 1,
         '00000000-0000-4000-8000-000000000601', 2, 'editorial_single', 25000, 'USD', 'ع', 'T' FROM o $q$, '23514');
SELECT pg_temp.expect_error($q$
  INSERT INTO orders (organization_id, created_by, currency, total_minor, expires_at)
  VALUES ('00000000-0000-4000-8000-000000000701', '00000000-0000-4000-8000-000000000711', 'USD', 0, now() + interval '25 hours') $q$, '23514');
SET CONSTRAINTS ALL DEFERRED;
-- البند مجمّد، والطلب يحفظ مجموعه وعملته، وانتقالاته صريحة
SELECT pg_temp.expect_error($q$ UPDATE order_items SET price_minor = 1 WHERE id = '00000000-0000-4000-8000-000000000c11' $q$, '23001');
SELECT pg_temp.expect_error($q$ DELETE FROM order_items WHERE id = '00000000-0000-4000-8000-000000000c11' $q$, '23001');
SELECT pg_temp.expect_error($q$ UPDATE orders SET total_minor = 1 WHERE id = '00000000-0000-4000-8000-000000000c01' $q$, '23514');
SELECT pg_temp.expect_error($q$ UPDATE orders SET status = 'refunded', paid_at = now() WHERE id = '00000000-0000-4000-8000-000000000c01' $q$, '23514');
SELECT pg_temp.expect_error($q$ UPDATE orders SET status = 'paid', paid_at = now() WHERE id = '00000000-0000-4000-8000-000000000c01' $q$, '23514');
SELECT pg_temp.expect_error($q$ UPDATE orders SET status = 'cancelled' WHERE id = '00000000-0000-4000-8000-000000000c01' $q$, '23514');
-- لا ترخيص قبل الدفع
SELECT pg_temp.expect_error($q$
  INSERT INTO licenses (license_number, order_item_id, organization_id, material_id, license_type, valid_from)
  VALUES ('PH-2026-ABCDEFGH23', '00000000-0000-4000-8000-000000000c11', '00000000-0000-4000-8000-000000000701',
          '00000000-0000-4000-8000-000000000101', 'editorial_single', now()) $q$, '23514');
UPDATE orders SET provider = 'sandbox', provider_ref = 'sbx_c01', status = 'paid', paid_at = now()
 WHERE id = '00000000-0000-4000-8000-000000000c01';
SELECT pg_temp.expect_error($q$ UPDATE orders SET provider_ref = 'sbx_other' WHERE id = '00000000-0000-4000-8000-000000000c01' $q$, '23514');
-- الرقم عشوائي بصيغته، وترخيص واحد للبند، والشروط مجمّدة والحالة وحدها تتغير
SELECT pg_temp.expect_error($q$
  INSERT INTO licenses (license_number, order_item_id, organization_id, material_id, license_type, valid_from)
  VALUES ('PH-2026-ABCDEFGHIO', '00000000-0000-4000-8000-000000000c11', '00000000-0000-4000-8000-000000000701',
          '00000000-0000-4000-8000-000000000101', 'editorial_single', now()) $q$, '23514');
SELECT pg_temp.expect_error($q$
  INSERT INTO licenses (license_number, order_item_id, organization_id, material_id, license_type, valid_from)
  VALUES ('PH-2026-ABCDEFGH23', '00000000-0000-4000-8000-000000000c11', '00000000-0000-4000-8000-000000000701',
          '00000000-0000-4000-8000-000000000101', 'commercial', now()) $q$, '23514');
INSERT INTO licenses (id, license_number, order_item_id, organization_id, material_id, license_type, valid_from)
VALUES ('00000000-0000-4000-8000-000000000c31', 'PH-2026-ABCDEFGH23', '00000000-0000-4000-8000-000000000c11',
        '00000000-0000-4000-8000-000000000701', '00000000-0000-4000-8000-000000000101', 'editorial_single', now());
SELECT pg_temp.expect_error($q$
  INSERT INTO licenses (license_number, order_item_id, organization_id, material_id, license_type, valid_from)
  VALUES ('PH-2026-ABCDEFGH24', '00000000-0000-4000-8000-000000000c11', '00000000-0000-4000-8000-000000000701',
          '00000000-0000-4000-8000-000000000101', 'editorial_single', now()) $q$, '23505');
SELECT pg_temp.expect_error($q$
  UPDATE licenses SET valid_until = now() + interval '1 day' WHERE id = '00000000-0000-4000-8000-000000000c31' $q$, '23514');
SELECT pg_temp.expect_error($q$ UPDATE licenses SET status = 'revoked' WHERE id = '00000000-0000-4000-8000-000000000c31' $q$, '23514');
SELECT pg_temp.expect_error($q$ DELETE FROM licenses WHERE id = '00000000-0000-4000-8000-000000000c31' $q$, '23001');

-- طلب ثانٍ غير حصري مدفوع، يُستعمل لاختباري الحقوق والحجز
INSERT INTO orders (id, organization_id, created_by, currency, total_minor, expires_at)
VALUES ('00000000-0000-4000-8000-000000000c02', '00000000-0000-4000-8000-000000000701', '00000000-0000-4000-8000-000000000711',
        'USD', 25000, now() + interval '1 hour');
INSERT INTO order_items (id, order_id, listing_id, material_id, material_version, license_template_id, license_version,
                         license_type, price_minor, currency, title_ar, title_en)
VALUES ('00000000-0000-4000-8000-000000000c12', '00000000-0000-4000-8000-000000000c02', '00000000-0000-4000-8000-000000000611',
        '00000000-0000-4000-8000-000000000101', 1, '00000000-0000-4000-8000-000000000601', 2, 'editorial_single', 25000, 'USD', 'ع', 'T');
UPDATE orders SET provider = 'sandbox', provider_ref = 'sbx_c02', status = 'paid', paid_at = now()
 WHERE id = '00000000-0000-4000-8000-000000000c02';
-- الحقوق يُعاد التحقق منها عند التأكيد: لا ترخيص لمادة خرجت حقوقها من sellable بعد الطلب
UPDATE catalog_listings SET state = 'suspended', suspended_reason = 'rights_changed' WHERE id = '00000000-0000-4000-8000-000000000611';
UPDATE materials SET rights_state = 'blocked' WHERE id = '00000000-0000-4000-8000-000000000101';
SELECT pg_temp.expect_error($q$
  INSERT INTO licenses (license_number, order_item_id, organization_id, material_id, license_type, valid_from)
  VALUES ('PH-2026-ABCDEFGH25', '00000000-0000-4000-8000-000000000c12', '00000000-0000-4000-8000-000000000701',
          '00000000-0000-4000-8000-000000000101', 'editorial_single', now()) $q$, '23514');
-- ولا بند لإدراج غير معروض
SELECT pg_temp.expect_error($q$
  INSERT INTO order_items (order_id, listing_id, material_id, material_version, license_template_id, license_version,
                           license_type, price_minor, currency, title_ar, title_en)
  VALUES ('00000000-0000-4000-8000-000000000c02', '00000000-0000-4000-8000-000000000611', '00000000-0000-4000-8000-000000000101',
          1, '00000000-0000-4000-8000-000000000602', 1, 'exclusive_temporary', 150000, 'USD', 'ع', 'T') $q$, '23514');
UPDATE materials SET rights_state = 'sellable' WHERE id = '00000000-0000-4000-8000-000000000101';
UPDATE catalog_listings SET state = 'listed', suspended_reason = NULL WHERE id = '00000000-0000-4000-8000-000000000611';
SET CONSTRAINTS ALL DEFERRED;

-- الحصرية: لا حجز لمادة سبق بيعها؛ بعد إبطال الترخيص الوحيد (استرداد) تصير متاحة
INSERT INTO orders (id, organization_id, created_by, currency, total_minor, expires_at)
VALUES ('00000000-0000-4000-8000-000000000c03', '00000000-0000-4000-8000-000000000701', '00000000-0000-4000-8000-000000000711',
        'USD', 150000, now() + interval '15 minutes');
INSERT INTO order_items (id, order_id, listing_id, material_id, material_version, license_template_id, license_version,
                         license_type, price_minor, currency, title_ar, title_en)
VALUES ('00000000-0000-4000-8000-000000000c13', '00000000-0000-4000-8000-000000000c03', '00000000-0000-4000-8000-000000000611',
        '00000000-0000-4000-8000-000000000101', 1, '00000000-0000-4000-8000-000000000602', 1, 'exclusive_temporary', 150000, 'USD', 'ع', 'T');
SELECT pg_temp.expect_error($q$
  INSERT INTO exclusive_holds (material_id, order_item_id, held_until)
  VALUES ('00000000-0000-4000-8000-000000000101', '00000000-0000-4000-8000-000000000c13', now() + interval '15 minutes') $q$, '23514');
SET CONSTRAINTS ALL DEFERRED;
UPDATE licenses SET status = 'revoked', revoked_reason = 'refunded' WHERE id = '00000000-0000-4000-8000-000000000c31';
UPDATE orders SET status = 'refunded' WHERE id = '00000000-0000-4000-8000-000000000c01';
SELECT pg_temp.expect_error($q$
  INSERT INTO exclusive_holds (material_id, order_item_id, held_until)
  VALUES ('00000000-0000-4000-8000-000000000101', '00000000-0000-4000-8000-000000000c13', now() + interval '16 minutes') $q$, '23514');
SELECT pg_temp.expect_error($q$
  INSERT INTO exclusive_holds (material_id, order_item_id, held_until)
  VALUES ('00000000-0000-4000-8000-000000000101', '00000000-0000-4000-8000-000000000c12', now() + interval '15 minutes') $q$, '23514');
INSERT INTO exclusive_holds (id, material_id, order_item_id, held_until)
VALUES ('00000000-0000-4000-8000-000000000c21', '00000000-0000-4000-8000-000000000101', '00000000-0000-4000-8000-000000000c13',
        now() + interval '15 minutes');
-- حجز واحد قائم أو نشط لكل مادة، ولو تزامن طلبان
INSERT INTO orders (id, organization_id, created_by, currency, total_minor, expires_at)
VALUES ('00000000-0000-4000-8000-000000000c04', '00000000-0000-4000-8000-000000000701', '00000000-0000-4000-8000-000000000711',
        'USD', 150000, now() + interval '15 minutes');
INSERT INTO order_items (id, order_id, listing_id, material_id, material_version, license_template_id, license_version,
                         license_type, price_minor, currency, title_ar, title_en)
VALUES ('00000000-0000-4000-8000-000000000c14', '00000000-0000-4000-8000-000000000c04', '00000000-0000-4000-8000-000000000611',
        '00000000-0000-4000-8000-000000000101', 1, '00000000-0000-4000-8000-000000000602', 1, 'exclusive_temporary', 150000, 'USD', 'ع', 'T');
SELECT pg_temp.expect_error($q$
  INSERT INTO exclusive_holds (material_id, order_item_id, held_until)
  VALUES ('00000000-0000-4000-8000-000000000101', '00000000-0000-4000-8000-000000000c14', now() + interval '15 minutes') $q$, '23505');
SET CONSTRAINTS ALL DEFERRED;
-- اختبار مقلوب: بإسقاط فهرس الحصرية يمر حجز ثانٍ، فالاختبار أعلاه يقيس الفهرس
SAVEPOINT exclusive_mutation;
DROP INDEX exclusive_holds_material_key;
INSERT INTO exclusive_holds (material_id, order_item_id, held_until)
VALUES ('00000000-0000-4000-8000-000000000101', '00000000-0000-4000-8000-000000000c14', now() + interval '15 minutes');
ROLLBACK TO SAVEPOINT exclusive_mutation;
SELECT pg_temp.assert((SELECT count(*) = 1 FROM pg_indexes WHERE indexname = 'exclusive_holds_material_key'), 'exclusivity index restored');
-- ولا بيع غير حصري والمادة تحت حجز ساري: لا بند جديد ولا ترخيص لطلب سبق دفعه
SELECT pg_temp.expect_error($q$
  WITH o AS (INSERT INTO orders (organization_id, created_by, currency, total_minor, expires_at)
             VALUES ('00000000-0000-4000-8000-000000000701', '00000000-0000-4000-8000-000000000711', 'USD', 25000, now() + interval '1 hour')
             RETURNING id)
  INSERT INTO order_items (order_id, listing_id, material_id, material_version, license_template_id, license_version,
                           license_type, price_minor, currency, title_ar, title_en)
  SELECT o.id, '00000000-0000-4000-8000-000000000611', '00000000-0000-4000-8000-000000000101', 1,
         '00000000-0000-4000-8000-000000000601', 2, 'editorial_single', 25000, 'USD', 'ع', 'T' FROM o $q$, '23514');
SET CONSTRAINTS ALL DEFERRED;
SELECT pg_temp.expect_error($q$
  INSERT INTO licenses (license_number, order_item_id, organization_id, material_id, license_type, valid_from)
  VALUES ('PH-2026-ABCDEFGH25', '00000000-0000-4000-8000-000000000c12', '00000000-0000-4000-8000-000000000701',
          '00000000-0000-4000-8000-000000000101', 'editorial_single', now()) $q$, '23514');
-- الحصري يصدر بحجزه، ثم ينشط الحجز حتى نهاية الحصرية؛ الحجز لا يُحذف ولا يعود ونافذته ثابتة
UPDATE orders SET provider = 'sandbox', provider_ref = 'sbx_c03', status = 'paid', paid_at = now()
 WHERE id = '00000000-0000-4000-8000-000000000c03';
SELECT pg_temp.expect_error($q$
  INSERT INTO licenses (license_number, order_item_id, organization_id, material_id, license_type, valid_from)
  VALUES ('PH-2026-ABCDEFGH26', '00000000-0000-4000-8000-000000000c13', '00000000-0000-4000-8000-000000000701',
          '00000000-0000-4000-8000-000000000101', 'exclusive_temporary', now()) $q$, '23514');
INSERT INTO licenses (id, license_number, order_item_id, organization_id, material_id, license_type, valid_from, valid_until, exclusive_until)
VALUES ('00000000-0000-4000-8000-000000000c33', 'PH-2026-ABCDEFGH26', '00000000-0000-4000-8000-000000000c13',
        '00000000-0000-4000-8000-000000000701', '00000000-0000-4000-8000-000000000101', 'exclusive_temporary', now(),
        now() + interval '30 days', now() + interval '72 hours');
UPDATE exclusive_holds SET state = 'active', active_until = now() + interval '72 hours' WHERE id = '00000000-0000-4000-8000-000000000c21';
SELECT pg_temp.expect_error($q$ UPDATE exclusive_holds SET state = 'held' WHERE id = '00000000-0000-4000-8000-000000000c21' $q$, '23514');
SELECT pg_temp.expect_error($q$
  UPDATE exclusive_holds SET held_until = now() + interval '1 minute' WHERE id = '00000000-0000-4000-8000-000000000c21' $q$, '23514');
SELECT pg_temp.expect_error($q$ DELETE FROM exclusive_holds WHERE id = '00000000-0000-4000-8000-000000000c21' $q$, '23001');
SELECT pg_temp.expect_error($q$
  INSERT INTO licenses (license_number, order_item_id, organization_id, material_id, license_type, valid_from)
  VALUES ('PH-2026-ABCDEFGH25', '00000000-0000-4000-8000-000000000c12', '00000000-0000-4000-8000-000000000701',
          '00000000-0000-4000-8000-000000000101', 'editorial_single', now()) $q$, '23514');

-- الإشعار المستلم فريد بـ (المزوّد، معرّف الحدث) ولا يُعدَّل
INSERT INTO payment_events (provider, event_id, type, provider_ref, amount_minor, currency, occurred_at, order_id, outcome)
VALUES ('sandbox', 'evt_c03_1', 'payment.succeeded', 'sbx_c03', 150000, 'USD', now(), '00000000-0000-4000-8000-000000000c03', 'applied');
SELECT pg_temp.expect_error($q$
  INSERT INTO payment_events (provider, event_id, type, provider_ref, amount_minor, currency, occurred_at, outcome)
  VALUES ('sandbox', 'evt_c03_1', 'payment.succeeded', 'sbx_c03', 150000, 'USD', now(), 'ignored') $q$, '23505');
SELECT pg_temp.expect_error($q$
  UPDATE payment_events SET outcome = 'ignored' WHERE event_id = 'evt_c03_1' $q$, '23001');
SELECT pg_temp.expect_error($q$
  INSERT INTO payment_events (provider, event_id, type, provider_ref, amount_minor, currency, occurred_at, outcome)
  VALUES ('sandbox', 'evt c03 2', 'payment.succeeded', 'sbx_c03', 150000, 'USD', now(), 'ignored') $q$, '23514');
SELECT pg_temp.expect_error($q$
  INSERT INTO payment_events (provider, event_id, type, provider_ref, amount_minor, currency, occurred_at, outcome)
  VALUES ('sandbox', 'evt_c03_3', 'charge.captured', 'sbx_c03', 150000, 'USD', now(), 'ignored') $q$, '23514');

-- الأحداث بمعرّفاتها وحالاتها وحدها، بلا أسعار ولا أسماء
INSERT INTO outbox_events (type, aggregate_type, aggregate_id, idempotency_key, payload)
VALUES ('order.status_changed', 'order', '00000000-0000-4000-8000-000000000c03', 'order.status_changed:smoke:1',
        '{"order_id": "00000000-0000-4000-8000-000000000c03", "organization_id": "00000000-0000-4000-8000-000000000701", "status": "paid", "cancel_reason": null}');
SELECT pg_temp.expect_error($q$
  INSERT INTO outbox_events (type, aggregate_type, aggregate_id, idempotency_key, payload)
  VALUES ('order.status_changed', 'order', '00000000-0000-4000-8000-000000000c03', 'order.status_changed:smoke:2',
          '{"order_id": "00000000-0000-4000-8000-000000000c03", "total_minor": 150000}') $q$, '23514');
INSERT INTO outbox_events (type, aggregate_type, aggregate_id, idempotency_key, payload)
VALUES ('license.issued', 'license', '00000000-0000-4000-8000-000000000c33', 'license.issued:smoke:1',
        '{"license_id": "00000000-0000-4000-8000-000000000c33", "order_id": "00000000-0000-4000-8000-000000000c03", "organization_id": "00000000-0000-4000-8000-000000000701", "material_id": "00000000-0000-4000-8000-000000000101", "material_version": 1, "license_type": "exclusive_temporary"}');
SELECT pg_temp.expect_error($q$
  INSERT INTO outbox_events (type, aggregate_type, aggregate_id, idempotency_key, payload)
  VALUES ('license.issued', 'license', '00000000-0000-4000-8000-000000000c33', 'license.issued:smoke:2',
          '{"license_id": "00000000-0000-4000-8000-000000000c33", "buyer_name": "x"}') $q$, '23514');

-- الدوال تعمل بمسار بحث فارغ (الاستعادة): طلب ببنده وفحص مجموعه المؤجل، ورقمه من الافتراضي (ترحيل 042)
SET LOCAL search_path = '';
INSERT INTO public.orders (id, organization_id, created_by, currency, total_minor, expires_at, purchase_order_number)
VALUES ('00000000-0000-4000-8000-000000000c05', '00000000-0000-4000-8000-000000000701', '00000000-0000-4000-8000-000000000711',
        'USD', 150000, now() + interval '15 minutes', 'PO 2026/17-A');
INSERT INTO public.order_items (order_id, listing_id, material_id, material_version, license_template_id, license_version,
                                license_type, price_minor, currency, title_ar, title_en)
VALUES ('00000000-0000-4000-8000-000000000c05', '00000000-0000-4000-8000-000000000611', '00000000-0000-4000-8000-000000000101',
        1, '00000000-0000-4000-8000-000000000602', 1, 'exclusive_temporary', 150000, 'USD', 'ع', 'T');
SET CONSTRAINTS ALL IMMEDIATE;
SET CONSTRAINTS ALL DEFERRED;
SET LOCAL search_path TO DEFAULT;
-- دعوة بريد قائم خارج المؤسسة: عضو مدعو بديل، ودعوة مفتوحة واحدة لكل بريد بلا تمييز لحالة الأحرف (ترحيل 031)
INSERT INTO buyer_invite_conflicts (id, organization_id, email, existing_user_id, role, invited_by, invite_expires_at)
VALUES ('00000000-0000-4000-8000-000000000d01', '00000000-0000-4000-8000-000000000701', 'reporter@example.invalid',
        '00000000-0000-4000-8000-000000000011', 'buyer_member', '00000000-0000-4000-8000-000000000711', now() + interval '24 hours');
SELECT pg_temp.expect_error($q$
  INSERT INTO buyer_invite_conflicts (organization_id, email, existing_user_id, role, invited_by, invite_expires_at)
  VALUES ('00000000-0000-4000-8000-000000000701', 'Reporter@Example.invalid', '00000000-0000-4000-8000-000000000011',
          'buyer_member', '00000000-0000-4000-8000-000000000711', now() + interval '24 hours') $q$, '23505');
SELECT pg_temp.expect_error($q$
  UPDATE buyer_invite_conflicts SET state = 'dismissed' WHERE id = '00000000-0000-4000-8000-000000000d01' $q$, '23514');
SELECT pg_temp.expect_error($q$
  UPDATE buyer_invite_conflicts SET role = 'producer' WHERE id = '00000000-0000-4000-8000-000000000d01' $q$, '23514');
UPDATE buyer_invite_conflicts SET state = 'dismissed', resolved_at = now(), resolved_by = '00000000-0000-4000-8000-000000000014'
 WHERE id = '00000000-0000-4000-8000-000000000d01';
INSERT INTO buyer_invite_conflicts (organization_id, email, existing_user_id, role, invited_by, invite_expires_at)
VALUES ('00000000-0000-4000-8000-000000000701', 'Reporter@Example.invalid', '00000000-0000-4000-8000-000000000011',
        'buyer_member', '00000000-0000-4000-8000-000000000711', now() + interval '24 hours');
SELECT pg_temp.assert(public.audit_details_is_whitelisted('{"conflict_id": "00000000-0000-4000-8000-000000000d01", "organization_id": "00000000-0000-4000-8000-000000000701"}'::jsonb),
  'audit whitelist accepts conflict_id');

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

-- المحاذاة الصوتية على النسخة الخفيفة وحدها، كاملة أو غائبة
UPDATE material_files SET alignment_original_file_id = '00000000-0000-4000-8000-000000000301', alignment_offset_ms = 120,
  alignment_confidence = 0.9, alignment_margin = 0.4, alignment_reliable = true, aligned_at = now()
 WHERE id = '00000000-0000-4000-8000-000000000302';
SELECT pg_temp.expect_error($q$
  UPDATE material_files SET alignment_original_file_id = '00000000-0000-4000-8000-000000000301', alignment_offset_ms = 0,
    alignment_confidence = 0.5, alignment_margin = 0.5, alignment_reliable = false, aligned_at = now()
   WHERE id = '00000000-0000-4000-8000-000000000301' $q$, '23514');
SELECT pg_temp.expect_error($q$
  UPDATE material_files SET alignment_confidence = 1.5 WHERE id = '00000000-0000-4000-8000-000000000302' $q$, '23514');
SELECT pg_temp.expect_error($q$
  UPDATE material_files SET aligned_at = NULL WHERE id = '00000000-0000-4000-8000-000000000302' $q$, '23514');
-- حزمة تسليم المشتري (ADR 0025 الجزء 9): لكل ترخيص حزمته، وlicense_id للتسليم وحده
-- تسجيل المشتق المتساوي الأثر يستدل الفهرس الجزئي بشرطه الكامل (ترحيلا 026 و038، media.service)؛ الشرطان القديمان لا
-- يطابقانه
INSERT INTO material_files (material_id, kind, state, derived_from_id)
VALUES ('00000000-0000-4000-8000-000000000101', 'proxy', 'received', '00000000-0000-4000-8000-000000000301')
ON CONFLICT (derived_from_id, kind) WHERE derived_from_id IS NOT NULL AND kind NOT IN ('delivery', 'circulated_render') DO NOTHING;
SELECT pg_temp.expect_error($q$
  INSERT INTO material_files (material_id, kind, state, derived_from_id)
  VALUES ('00000000-0000-4000-8000-000000000101', 'proxy', 'received', '00000000-0000-4000-8000-000000000301')
  ON CONFLICT (derived_from_id, kind) WHERE derived_from_id IS NOT NULL DO NOTHING $q$, '42P10');
SELECT pg_temp.expect_error($q$
  INSERT INTO material_files (material_id, kind, state, derived_from_id)
  VALUES ('00000000-0000-4000-8000-000000000101', 'proxy', 'received', '00000000-0000-4000-8000-000000000301')
  ON CONFLICT (derived_from_id, kind) WHERE derived_from_id IS NOT NULL AND kind <> 'delivery' DO NOTHING $q$, '42P10');
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
-- التصدير النهائي مشتق produced (ترحيل 028): نوع مقبول، ومرة واحدة لكل مصدر كبقية المشتقات
INSERT INTO material_files (material_id, kind, state, derived_from_id)
VALUES ('00000000-0000-4000-8000-000000000101', 'produced', 'received', '00000000-0000-4000-8000-000000000301');
SELECT pg_temp.expect_error($q$
  INSERT INTO material_files (material_id, kind, state, derived_from_id)
  VALUES ('00000000-0000-4000-8000-000000000101', 'produced', 'received', '00000000-0000-4000-8000-000000000301') $q$, '23505');
INSERT INTO outbox_events (type, aggregate_type, aggregate_id, idempotency_key, payload)
VALUES ('license.delivery_requested', 'license', '00000000-0000-4000-8000-000000000801', 'license.delivery_requested:smoke:1',
        '{"license_id": "00000000-0000-4000-8000-000000000801", "material_id": "00000000-0000-4000-8000-000000000101", "source_file_id": "00000000-0000-4000-8000-000000000301", "deliverables": ["original", "audio"], "produced_file_id": null}');
SELECT pg_temp.expect_error($q$
  INSERT INTO outbox_events (type, aggregate_type, aggregate_id, idempotency_key, payload)
  VALUES ('license.delivery_requested', 'license', '00000000-0000-4000-8000-000000000801', 'license.delivery_requested:smoke:2',
          '{"license_id": "00000000-0000-4000-8000-000000000801", "buyer_name": "x"}') $q$, '23514');
SELECT pg_temp.assert(
  (SELECT count(*) = 1 FROM pg_indexes WHERE indexname = 'upload_sessions_storage_pending_idx'
     AND indexdef ILIKE '%WHERE ((state = ''failed''::text) AND (storage_removed_at IS NULL))%'),
  'partial index for failed uploads whose temporary data is not yet removed exists');

-- ---------- دفتر الأستاذ (ADR 0031): قيد مزدوج لا يُعدَّل ----------
SET CONSTRAINTS ALL DEFERRED;
INSERT INTO ledger_accounts (id, kind, currency) VALUES
  ('00000000-0000-4000-8000-000000000901', 'provider_clearing', 'USD'), ('00000000-0000-4000-8000-000000000902', 'platform_revenue', 'USD'), ('00000000-0000-4000-8000-000000000906', 'provider_clearing', 'ILS');
INSERT INTO ledger_accounts (id, kind, owner_id, payable_state, currency) VALUES
  ('00000000-0000-4000-8000-000000000904', 'contributor_payable', '00000000-0000-4000-8000-000000000011', 'pending', 'USD'),
  ('00000000-0000-4000-8000-000000000905', 'contributor_payable', '00000000-0000-4000-8000-000000000011', 'available', 'USD');
-- حساب واحد لكل (نوع، مالك، حالة، عملة)، والمالك والحالة للمستحق وحده، وهوية الحساب ثابتة
SELECT pg_temp.expect_error($q$ INSERT INTO ledger_accounts (kind, currency) VALUES ('provider_clearing', 'USD') $q$, '23505');
SELECT pg_temp.expect_error($q$ INSERT INTO ledger_accounts (kind, currency) VALUES ('contributor_payable', 'USD') $q$, '23514');
SELECT pg_temp.expect_error($q$
  INSERT INTO ledger_accounts (kind, owner_id, payable_state, currency) VALUES ('taxes', '00000000-0000-4000-8000-000000000011', 'pending', 'USD') $q$, '23514');
SELECT pg_temp.expect_error($q$ UPDATE ledger_accounts SET currency = 'ILS' WHERE id = '00000000-0000-4000-8000-000000000901' $q$, '23514');
SELECT pg_temp.expect_error($q$ UPDATE ledger_accounts SET payable_state = 'paid' WHERE id = '00000000-0000-4000-8000-000000000904' $q$, '23514');
-- بيعة متوازنة تُقبل عند الإيداع، وتفاصيلها أرقام ومعرّفات
INSERT INTO journal_entries (id, kind, reference_type, reference_id, idempotency_key, details, actor_id) VALUES
  ('00000000-0000-4000-8000-000000000911', 'sale', 'order', '00000000-0000-4000-8000-000000000921', 'sale:smoke:1',
   '{"rule_id": "00000000-0000-4000-8000-000000000931", "platform_bps": 3000, "currency": "USD", "shares": [{"user_id": "00000000-0000-4000-8000-000000000011", "bps": 10000}]}',
   '00000000-0000-4000-8000-000000000014');
INSERT INTO postings (entry_id, account_id, amount_minor, currency) VALUES
  ('00000000-0000-4000-8000-000000000911', '00000000-0000-4000-8000-000000000901', 1000, 'USD'), ('00000000-0000-4000-8000-000000000911', '00000000-0000-4000-8000-000000000902', -300, 'USD'), ('00000000-0000-4000-8000-000000000911', '00000000-0000-4000-8000-000000000904', -700, 'USD');
SET CONSTRAINTS ALL IMMEDIATE;
SET CONSTRAINTS ALL DEFERRED;
-- غير المتوازن، والقيد بلا سطور، والسطر بعملة غير عملة حسابه: كلها تُرفض
SELECT pg_temp.expect_error($q$
  WITH e AS (INSERT INTO journal_entries (kind, reference_type, reference_id, idempotency_key)
             VALUES ('sale', 'order', '00000000-0000-4000-8000-000000000922', 'sale:smoke:unbalanced') RETURNING id)
  INSERT INTO postings (entry_id, account_id, amount_minor, currency)
  SELECT id, '00000000-0000-4000-8000-000000000901'::uuid, 100, 'USD' FROM e UNION ALL SELECT id, '00000000-0000-4000-8000-000000000902'::uuid, -90, 'USD' FROM e $q$, '23514');
SELECT pg_temp.expect_error($q$
  INSERT INTO journal_entries (kind, reference_type, reference_id, idempotency_key)
  VALUES ('sale', 'order', '00000000-0000-4000-8000-000000000923', 'sale:smoke:empty') $q$, '23514');
SELECT pg_temp.expect_error($q$
  INSERT INTO postings (entry_id, account_id, amount_minor, currency) VALUES ('00000000-0000-4000-8000-000000000911', '00000000-0000-4000-8000-000000000901', 5, 'ILS') $q$, '23514');
SELECT pg_temp.expect_error($q$
  INSERT INTO postings (entry_id, account_id, amount_minor, currency) VALUES ('00000000-0000-4000-8000-000000000911', '00000000-0000-4000-8000-000000000901', 0, 'USD') $q$, '23514');
-- نص حر في التفاصيل يُرفض، والعكس للاسترداد والتصحيح وحدهما، والتكرار بمفتاح القيد يُرفض
SELECT pg_temp.expect_error($q$
  INSERT INTO journal_entries (kind, reference_type, reference_id, idempotency_key, details)
  VALUES ('sale', 'order', '00000000-0000-4000-8000-000000000924', 'sale:smoke:text', '{"note": "buyer Jane Doe"}') $q$, '23514');
SELECT pg_temp.expect_error($q$
  INSERT INTO journal_entries (kind, reference_type, reference_id, idempotency_key)
  VALUES ('refund', 'refund', '00000000-0000-4000-8000-000000000925', 'refund:smoke:orphan') $q$, '23514');
SELECT pg_temp.expect_error($q$
  INSERT INTO journal_entries (kind, reference_type, reference_id, idempotency_key, reverses_entry_id)
  VALUES ('sale', 'order', '00000000-0000-4000-8000-000000000926', 'sale:smoke:reverses', '00000000-0000-4000-8000-000000000911') $q$, '23514');
SELECT pg_temp.expect_error($q$
  INSERT INTO journal_entries (kind, reference_type, reference_id, idempotency_key)
  VALUES ('sale', 'order', '00000000-0000-4000-8000-000000000921', 'sale:smoke:1') $q$, '23505');
-- التصحيح يعكس القيد كاملًا مرة واحدة
WITH e AS (INSERT INTO journal_entries (kind, reference_type, reference_id, idempotency_key, reverses_entry_id)
           VALUES ('correction', 'order', '00000000-0000-4000-8000-000000000921', 'correction:smoke:1', '00000000-0000-4000-8000-000000000911') RETURNING id)
INSERT INTO postings (entry_id, account_id, amount_minor, currency)
SELECT id, '00000000-0000-4000-8000-000000000901'::uuid, -1000, 'USD' FROM e UNION ALL SELECT id, '00000000-0000-4000-8000-000000000902'::uuid, 300, 'USD' FROM e
UNION ALL SELECT id, '00000000-0000-4000-8000-000000000904'::uuid, 700, 'USD' FROM e;
SET CONSTRAINTS ALL IMMEDIATE;
SET CONSTRAINTS ALL DEFERRED;
SELECT pg_temp.expect_error($q$
  INSERT INTO journal_entries (kind, reference_type, reference_id, idempotency_key, reverses_entry_id)
  VALUES ('correction', 'order', '00000000-0000-4000-8000-000000000921', 'correction:smoke:2', '00000000-0000-4000-8000-000000000911') $q$, '23505');
-- لا تحديث ولا حذف ولا تفريغ: الصلاحية مسحوبة من دور التطبيق، والمحفّز يرفض حتى بعد إعادتها
SELECT pg_temp.expect_error($q$ UPDATE postings SET amount_minor = 1 WHERE entry_id = '00000000-0000-4000-8000-000000000911' $q$, '42501');
SELECT pg_temp.expect_error($q$ DELETE FROM journal_entries WHERE id = '00000000-0000-4000-8000-000000000911' $q$, '42501');
SELECT pg_temp.expect_error($q$ TRUNCATE postings $q$, '42501');
GRANT UPDATE, DELETE, TRUNCATE ON journal_entries, postings TO CURRENT_USER;
SELECT pg_temp.expect_error($q$ UPDATE postings SET amount_minor = 1 WHERE entry_id = '00000000-0000-4000-8000-000000000911' $q$, '42501');
SELECT pg_temp.expect_error($q$ DELETE FROM journal_entries WHERE id = '00000000-0000-4000-8000-000000000911' $q$, '42501');
SELECT pg_temp.expect_error($q$ TRUNCATE journal_entries CASCADE $q$, '42501');
REVOKE UPDATE, DELETE, TRUNCATE ON journal_entries, postings FROM CURRENT_USER;
-- المحفّزات تعمل بمسار بحث فارغ (الاستعادة)
SET LOCAL search_path = '';
WITH e AS (INSERT INTO public.journal_entries (kind, reference_type, reference_id, idempotency_key)
           VALUES ('release', 'order', '00000000-0000-4000-8000-000000000921', 'release:smoke:1') RETURNING id)
INSERT INTO public.postings (entry_id, account_id, amount_minor, currency)
SELECT id, '00000000-0000-4000-8000-000000000904'::uuid, 700, 'USD' FROM e UNION ALL SELECT id, '00000000-0000-4000-8000-000000000905'::uuid, -700, 'USD' FROM e;
SET CONSTRAINTS ALL IMMEDIATE;
SET CONSTRAINTS ALL DEFERRED;
SET LOCAL search_path TO DEFAULT;
-- اختبار مقلوب: بلا محفّزي التوازن يمر القيد غير المتوازن، فالاختبار أعلاه يقيس المحفّز لا غيره
ALTER TABLE postings DISABLE TRIGGER postings_balanced;
ALTER TABLE journal_entries DISABLE TRIGGER journal_entries_balanced;
WITH e AS (INSERT INTO journal_entries (kind, reference_type, reference_id, idempotency_key)
           VALUES ('sale', 'order', '00000000-0000-4000-8000-000000000927', 'sale:smoke:mutant') RETURNING id)
INSERT INTO postings (entry_id, account_id, amount_minor, currency) SELECT id, '00000000-0000-4000-8000-000000000901'::uuid, 100, 'USD' FROM e;
SET CONSTRAINTS ALL IMMEDIATE;
SET CONSTRAINTS ALL DEFERRED;
ALTER TABLE postings ENABLE TRIGGER postings_balanced;
ALTER TABLE journal_entries ENABLE TRIGGER journal_entries_balanced;

-- ---------- الاسترداد وقواعد العمولة (ADR 0025، الجزءان 5 و6؛ ترحيل 032) ----------
-- الطلب c02 مدفوع ببند c12 (25000 USD)، وc01 مسترد كاملًا
SELECT pg_temp.expect_error($q$
  WITH r AS (INSERT INTO refunds (order_id, amount_minor, currency, reason_code, created_by)
             VALUES ('00000000-0000-4000-8000-000000000c01', 25000, 'USD', 'buyer_request', '00000000-0000-4000-8000-000000000014') RETURNING id)
  INSERT INTO refund_items (refund_id, order_item_id) SELECT id, '00000000-0000-4000-8000-000000000c11' FROM r $q$, '23514');
SELECT pg_temp.expect_error($q$
  WITH r AS (INSERT INTO refunds (order_id, amount_minor, currency, reason_code, created_by)
             VALUES ('00000000-0000-4000-8000-000000000c02', 25000, 'ILS', 'buyer_request', '00000000-0000-4000-8000-000000000014') RETURNING id)
  INSERT INTO refund_items (refund_id, order_item_id) SELECT id, '00000000-0000-4000-8000-000000000c12' FROM r $q$, '23514');
SELECT pg_temp.expect_error($q$
  WITH r AS (INSERT INTO refunds (order_id, amount_minor, currency, reason_code, created_by)
             VALUES ('00000000-0000-4000-8000-000000000c02', 1, 'USD', 'buyer_request', '00000000-0000-4000-8000-000000000014') RETURNING id)
  INSERT INTO refund_items (refund_id, order_item_id) SELECT id, '00000000-0000-4000-8000-000000000c12' FROM r $q$, '23514');
SELECT pg_temp.expect_error($q$
  WITH r AS (INSERT INTO refunds (order_id, amount_minor, currency, reason_code, created_by)
             VALUES ('00000000-0000-4000-8000-000000000c02', 150000, 'USD', 'buyer_request', '00000000-0000-4000-8000-000000000014') RETURNING id)
  INSERT INTO refund_items (refund_id, order_item_id) SELECT id, '00000000-0000-4000-8000-000000000c13' FROM r $q$, '23514');
SELECT pg_temp.expect_error($q$
  INSERT INTO refunds (order_id, amount_minor, currency, reason_code, created_by)
  VALUES ('00000000-0000-4000-8000-000000000c02', 25000, 'USD', 'chargeback_note', '00000000-0000-4000-8000-000000000014') $q$, '23514');
SET CONSTRAINTS ALL DEFERRED;
INSERT INTO refunds (id, order_id, amount_minor, currency, reason_code, created_by)
VALUES ('00000000-0000-4000-8000-000000000e01', '00000000-0000-4000-8000-000000000c02', 25000, 'USD', 'buyer_request',
        '00000000-0000-4000-8000-000000000014');
INSERT INTO refund_items (refund_id, order_item_id) VALUES ('00000000-0000-4000-8000-000000000e01', '00000000-0000-4000-8000-000000000c12');
-- البند لا يُسترد مرتين ما دام استرداده غير فاشل
SELECT pg_temp.expect_error($q$
  WITH r AS (INSERT INTO refunds (order_id, amount_minor, currency, reason_code, created_by)
             VALUES ('00000000-0000-4000-8000-000000000c02', 25000, 'USD', 'duplicate', '00000000-0000-4000-8000-000000000014') RETURNING id)
  INSERT INTO refund_items (refund_id, order_item_id) SELECT id, '00000000-0000-4000-8000-000000000c12' FROM r $q$, '23505');
SET CONSTRAINTS ALL DEFERRED;
-- النجاح يلزمه قيد refund لا غيره، والمكتمل نهائي، ولا حذف ولا تعديل لما جُمّد
SELECT pg_temp.expect_error($q$
  UPDATE refunds SET status = 'succeeded', completed_at = now() WHERE id = '00000000-0000-4000-8000-000000000e01' $q$, '23514');
SELECT pg_temp.expect_error($q$
  UPDATE refunds SET status = 'succeeded', completed_at = now(), entry_id = '00000000-0000-4000-8000-000000000911'
   WHERE id = '00000000-0000-4000-8000-000000000e01' $q$, '23514');
SELECT pg_temp.expect_error($q$ UPDATE refunds SET amount_minor = 1 WHERE id = '00000000-0000-4000-8000-000000000e01' $q$, '23514');
SELECT pg_temp.expect_error($q$ DELETE FROM refunds WHERE id = '00000000-0000-4000-8000-000000000e01' $q$, '23001');
SELECT pg_temp.expect_error($q$
  DELETE FROM refund_items WHERE refund_id = '00000000-0000-4000-8000-000000000e01' $q$, '23001');
-- الفشل يحرر البند لاسترداد جديد
UPDATE refunds SET status = 'failed', completed_at = now() WHERE id = '00000000-0000-4000-8000-000000000e01';
SELECT pg_temp.expect_error($q$ UPDATE refunds SET status = 'pending', completed_at = NULL WHERE id = '00000000-0000-4000-8000-000000000e01' $q$, '23514');
INSERT INTO refunds (id, order_id, amount_minor, currency, reason_code, created_by, provider_refund_ref)
VALUES ('00000000-0000-4000-8000-000000000e02', '00000000-0000-4000-8000-000000000c02', 25000, 'USD', 'buyer_request',
        '00000000-0000-4000-8000-000000000014', 'sbx_refund_e02');
INSERT INTO refund_items (refund_id, order_item_id) VALUES ('00000000-0000-4000-8000-000000000e02', '00000000-0000-4000-8000-000000000c12');
WITH e AS (INSERT INTO journal_entries (id, kind, reference_type, reference_id, idempotency_key, reverses_entry_id)
           VALUES ('00000000-0000-4000-8000-000000000e91', 'refund', 'refund', '00000000-0000-4000-8000-000000000e02', 'refund:smoke:e02',
                   '00000000-0000-4000-8000-000000000911') RETURNING id)
INSERT INTO postings (entry_id, account_id, amount_minor, currency)
SELECT id, '00000000-0000-4000-8000-000000000901'::uuid, -1000, 'USD' FROM e UNION ALL SELECT id, '00000000-0000-4000-8000-000000000902'::uuid, 300, 'USD' FROM e
UNION ALL SELECT id, '00000000-0000-4000-8000-000000000904'::uuid, 700, 'USD' FROM e;
UPDATE refunds SET status = 'succeeded', completed_at = now(), entry_id = '00000000-0000-4000-8000-000000000e91'
 WHERE id = '00000000-0000-4000-8000-000000000e02';
SELECT pg_temp.expect_error($q$
  UPDATE refunds SET provider_refund_ref = 'sbx_other' WHERE id = '00000000-0000-4000-8000-000000000e02' $q$, '23514');
SET CONSTRAINTS ALL DEFERRED;

-- قواعد العمولة: نطاق بمعرّفه الصحيح، ونقاط أساس 0–10000، ولا تكرار لنطاق وتاريخ سريان، ولا تعديل ولا حذف
INSERT INTO commission_rules (scope, scope_id, license_type, platform_basis_points, effective_from, created_by) VALUES
  ('default', NULL, NULL, 3000, '2026-10-01', '00000000-0000-4000-8000-000000000014'),
  ('material_type', 'press_conference', NULL, 2500, '2026-10-01', '00000000-0000-4000-8000-000000000014'),
  ('reporter', '00000000-0000-4000-8000-000000000011', 'exclusive_temporary', 2000, '2026-10-01', '00000000-0000-4000-8000-000000000014'),
  ('material', '00000000-0000-4000-8000-000000000101', NULL, 1500, '2026-10-01', '00000000-0000-4000-8000-000000000014');
SELECT pg_temp.expect_error($q$
  INSERT INTO commission_rules (scope, scope_id, platform_basis_points, effective_from, created_by)
  VALUES ('default', NULL, 3500, '2026-10-01', '00000000-0000-4000-8000-000000000014') $q$, '23505');
SELECT pg_temp.expect_error($q$
  INSERT INTO commission_rules (scope, scope_id, platform_basis_points, effective_from, created_by)
  VALUES ('default', 'x', 3000, '2026-11-01', '00000000-0000-4000-8000-000000000014') $q$, '23514');
SELECT pg_temp.expect_error($q$
  INSERT INTO commission_rules (scope, scope_id, platform_basis_points, effective_from, created_by)
  VALUES ('material_type', 'podcast', 3000, '2026-11-01', '00000000-0000-4000-8000-000000000014') $q$, '23514');
SELECT pg_temp.expect_error($q$
  INSERT INTO commission_rules (scope, scope_id, platform_basis_points, effective_from, created_by)
  VALUES ('reporter', 'Jane Doe', 3000, '2026-11-01', '00000000-0000-4000-8000-000000000014') $q$, '23514');
SELECT pg_temp.expect_error($q$
  INSERT INTO commission_rules (scope, scope_id, platform_basis_points, effective_from, created_by)
  VALUES ('default', NULL, 10001, '2026-11-01', '00000000-0000-4000-8000-000000000014') $q$, '23514');
SELECT pg_temp.expect_error($q$ UPDATE commission_rules SET platform_basis_points = 1 WHERE scope = 'default' $q$, '23001');
SELECT pg_temp.expect_error($q$ DELETE FROM commission_rules WHERE scope = 'default' $q$, '23001');

-- إبطال الترخيص حدث بمعرّفاته وسببه وحدها
INSERT INTO outbox_events (type, aggregate_type, aggregate_id, idempotency_key, payload)
VALUES ('license.revoked', 'license', '00000000-0000-4000-8000-000000000c31', 'license.revoked:smoke:1',
        '{"license_id": "00000000-0000-4000-8000-000000000c31", "organization_id": "00000000-0000-4000-8000-000000000701", "material_id": "00000000-0000-4000-8000-000000000101", "revoked_reason": "refunded"}');
SELECT pg_temp.expect_error($q$
  INSERT INTO outbox_events (type, aggregate_type, aggregate_id, idempotency_key, payload)
  VALUES ('license.revoked', 'license', '00000000-0000-4000-8000-000000000c31', 'license.revoked:smoke:2',
          '{"license_id": "00000000-0000-4000-8000-000000000c31", "amount_minor": 25000}') $q$, '23514');

-- الدوال تعمل بمسار بحث فارغ (الاستعادة)
SET LOCAL search_path = '';
INSERT INTO public.commission_rules (scope, scope_id, platform_basis_points, effective_from, created_by)
VALUES ('material_type', 'interview', 2800, '2026-10-01', '00000000-0000-4000-8000-000000000014');
SELECT pg_temp.expect_error($q$
  INSERT INTO public.refunds (order_id, amount_minor, currency, reason_code, created_by)
  VALUES ('00000000-0000-4000-8000-000000000c01', 25000, 'USD', 'buyer_request', '00000000-0000-4000-8000-000000000014') $q$, '23514');
SET CONSTRAINTS ALL DEFERRED;
SET LOCAL search_path TO DEFAULT;

-- محوّل الدفع قائمة مغلقة (ترحيل 033): stripe مقبول، وغيره يُرفض في الإشعار المستلم والطلب
INSERT INTO payment_events (provider, event_id, type, provider_ref, amount_minor, currency, occurred_at, outcome)
VALUES ('stripe', 'evt_1Smoke033', 'payment.succeeded', 'cs_test_smoke033', 25000, 'USD', now(), 'ignored');
SELECT pg_temp.expect_error($q$
  INSERT INTO payment_events (provider, event_id, type, provider_ref, amount_minor, currency, occurred_at, outcome)
  VALUES ('paypal', 'evt_smoke_033', 'payment.succeeded', 'x', 25000, 'USD', now(), 'ignored') $q$, '23514');
SELECT pg_temp.expect_error($q$
  UPDATE orders SET provider = 'paypal', provider_ref = 'pp_1' WHERE id = '00000000-0000-4000-8000-000000000c04' $q$, '23514');
-- ---------- الأرباح وطلبات الصرف (ADR 0033؛ ترحيل 034) ----------
-- متاح المراسل 011 بالدولار (الحساب 905) دائن بـ 700 من قيد التحرير أعلاه
INSERT INTO ledger_accounts (id, kind, owner_id, payable_state, currency) VALUES
  ('00000000-0000-4000-8000-0000000009a1', 'contributor_payable', '00000000-0000-4000-8000-000000000011', 'in_payout', 'USD'),
  ('00000000-0000-4000-8000-0000000009a2', 'contributor_payable', '00000000-0000-4000-8000-000000000011', 'paid', 'USD');
-- سياسة الصرف لا تُعدَّل، والاحتياطي ≤ 50%
INSERT INTO payout_policies (currency, minimum_minor, dual_approval_above_minor, reserve_bps, effective_from, created_by)
VALUES ('USD', 100, 400, 1000, '2026-10-01', '00000000-0000-4000-8000-000000000014');
SELECT pg_temp.expect_error($q$ UPDATE payout_policies SET reserve_bps = 0 $q$, '23001');
SELECT pg_temp.expect_error($q$
  INSERT INTO payout_policies (currency, minimum_minor, dual_approval_above_minor, reserve_bps, effective_from, created_by)
  VALUES ('USD', 100, 400, 6000, '2026-11-01', '00000000-0000-4000-8000-000000000014') $q$, '23514');
SELECT pg_temp.expect_error($q$
  INSERT INTO payout_policies (currency, minimum_minor, dual_approval_above_minor, reserve_bps, effective_from, created_by)
  VALUES ('USD', 200, 400, 1000, '2026-10-01', '00000000-0000-4000-8000-000000000014') $q$, '23505');
-- الطلب يحجز المبلغ فورًا من المتاح إلى قيد الصرف
WITH e AS (INSERT INTO journal_entries (id, kind, reference_type, reference_id, idempotency_key)
           VALUES ('00000000-0000-4000-8000-0000000009b1', 'payout', 'payout_request', '00000000-0000-4000-8000-0000000009c1',
                   'payout:hold:9c1') RETURNING id)
INSERT INTO postings (entry_id, account_id, amount_minor, currency)
SELECT id, '00000000-0000-4000-8000-000000000905'::uuid, 500, 'USD' FROM e
UNION ALL SELECT id, '00000000-0000-4000-8000-0000000009a1'::uuid, -500, 'USD' FROM e;
INSERT INTO payout_requests (id, user_id, amount_minor, currency, channel, approvals_required, hold_entry_id)
VALUES ('00000000-0000-4000-8000-0000000009c1', '00000000-0000-4000-8000-000000000011', 500, 'USD', 'sandbox', 2,
        '00000000-0000-4000-8000-0000000009b1');
SET CONSTRAINTS ALL IMMEDIATE;
SET CONSTRAINTS ALL DEFERRED;
-- لا صرف فوق المتاح: بقي 200، وطلب 300 يجعل المستحق مدينًا
SELECT pg_temp.expect_error($q$
  WITH e AS (INSERT INTO journal_entries (kind, reference_type, reference_id, idempotency_key)
             VALUES ('payout', 'payout_request', '00000000-0000-4000-8000-0000000009c9', 'payout:hold:overdraw') RETURNING id)
  INSERT INTO postings (entry_id, account_id, amount_minor, currency)
  SELECT id, '00000000-0000-4000-8000-000000000905'::uuid, 300, 'USD' FROM e
  UNION ALL SELECT id, '00000000-0000-4000-8000-0000000009a1'::uuid, -300, 'USD' FROM e $q$, '23514');
SET CONSTRAINTS ALL DEFERRED;
-- الطلب يبدأ requested بقيد حجزه من نوع payout ومرجعه، ولا قناة غير sandbox
SELECT pg_temp.expect_error($q$
  INSERT INTO payout_requests (user_id, amount_minor, currency, channel, approvals_required, hold_entry_id)
  VALUES ('00000000-0000-4000-8000-000000000011', 500, 'USD', 'sandbox', 1, '00000000-0000-4000-8000-000000000911') $q$, '23514');
SELECT pg_temp.expect_error($q$
  INSERT INTO payout_requests (id, user_id, amount_minor, currency, channel, approvals_required, hold_entry_id)
  VALUES ('00000000-0000-4000-8000-0000000009c1', '00000000-0000-4000-8000-000000000011', 500, 'USD', 'bank_transfer', 1,
          '00000000-0000-4000-8000-0000000009b1') $q$, '23514');
-- الاعتماد لغير صاحب الطلب، ومرة لكل معتمد، وبالعدد المجمّد
SELECT pg_temp.expect_error($q$
  INSERT INTO payout_approvals (payout_request_id, approver_id)
  VALUES ('00000000-0000-4000-8000-0000000009c1', '00000000-0000-4000-8000-000000000011') $q$, '23514');
INSERT INTO payout_approvals (payout_request_id, approver_id)
VALUES ('00000000-0000-4000-8000-0000000009c1', '00000000-0000-4000-8000-000000000014');
SELECT pg_temp.expect_error($q$
  INSERT INTO payout_approvals (payout_request_id, approver_id)
  VALUES ('00000000-0000-4000-8000-0000000009c1', '00000000-0000-4000-8000-000000000014') $q$, '23505');
SELECT pg_temp.expect_error($q$
  UPDATE payout_requests SET state = 'approved', decided_at = now() WHERE id = '00000000-0000-4000-8000-0000000009c1' $q$, '23514');
INSERT INTO payout_approvals (payout_request_id, approver_id)
VALUES ('00000000-0000-4000-8000-0000000009c1', '00000000-0000-4000-8000-000000000013');
UPDATE payout_requests SET state = 'approved', decided_at = now() WHERE id = '00000000-0000-4000-8000-0000000009c1';
SELECT pg_temp.expect_error($q$
  INSERT INTO payout_approvals (payout_request_id, approver_id)
  VALUES ('00000000-0000-4000-8000-0000000009c1', '00000000-0000-4000-8000-000000000012') $q$, '23514');
-- الانتقالات صريحة، والمصروف يلزمه قيده، والمكتمل نهائي
SELECT pg_temp.expect_error($q$
  UPDATE payout_requests SET state = 'paid', completed_at = now() WHERE id = '00000000-0000-4000-8000-0000000009c1' $q$, '23514');
UPDATE payout_requests SET state = 'processing', channel_ref = 'sbx_payout_9c1' WHERE id = '00000000-0000-4000-8000-0000000009c1';
SELECT pg_temp.expect_error($q$
  UPDATE payout_requests SET state = 'paid', completed_at = now(), settle_entry_id = '00000000-0000-4000-8000-0000000009b1'
   WHERE id = '00000000-0000-4000-8000-0000000009c1' $q$, '23514');
WITH e AS (INSERT INTO journal_entries (id, kind, reference_type, reference_id, idempotency_key)
           VALUES ('00000000-0000-4000-8000-0000000009b2', 'payout', 'payout_request', '00000000-0000-4000-8000-0000000009c1',
                   'payout:settle:9c1') RETURNING id)
INSERT INTO postings (entry_id, account_id, amount_minor, currency)
SELECT id, '00000000-0000-4000-8000-0000000009a1'::uuid, 500, 'USD' FROM e
UNION ALL SELECT id, '00000000-0000-4000-8000-0000000009a2'::uuid, -500, 'USD' FROM e;
UPDATE payout_requests SET state = 'paid', completed_at = now(), settle_entry_id = '00000000-0000-4000-8000-0000000009b2'
 WHERE id = '00000000-0000-4000-8000-0000000009c1';
SELECT pg_temp.expect_error($q$
  UPDATE payout_requests SET channel_ref = 'other' WHERE id = '00000000-0000-4000-8000-0000000009c1' $q$, '23514');
SELECT pg_temp.expect_error($q$
  UPDATE payout_requests SET amount_minor = 1 WHERE id = '00000000-0000-4000-8000-0000000009c1' $q$, '23514');
SELECT pg_temp.expect_error($q$ DELETE FROM payout_requests WHERE id = '00000000-0000-4000-8000-0000000009c1' $q$, '23001');
SET CONSTRAINTS ALL IMMEDIATE;
SET CONSTRAINTS ALL DEFERRED;
-- الإلغاء والرفض يعيدان المبلغ بقيد معاكس، والرفض بسبب
WITH e AS (INSERT INTO journal_entries (id, kind, reference_type, reference_id, idempotency_key)
           VALUES ('00000000-0000-4000-8000-0000000009b3', 'payout', 'payout_request', '00000000-0000-4000-8000-0000000009c2',
                   'payout:hold:9c2') RETURNING id)
INSERT INTO postings (entry_id, account_id, amount_minor, currency)
SELECT id, '00000000-0000-4000-8000-000000000905'::uuid, 150, 'USD' FROM e
UNION ALL SELECT id, '00000000-0000-4000-8000-0000000009a1'::uuid, -150, 'USD' FROM e;
INSERT INTO payout_requests (id, user_id, amount_minor, currency, channel, approvals_required, hold_entry_id)
VALUES ('00000000-0000-4000-8000-0000000009c2', '00000000-0000-4000-8000-000000000011', 150, 'USD', 'sandbox', 1,
        '00000000-0000-4000-8000-0000000009b3');
WITH e AS (INSERT INTO journal_entries (id, kind, reference_type, reference_id, idempotency_key)
           VALUES ('00000000-0000-4000-8000-0000000009b4', 'payout', 'payout_request', '00000000-0000-4000-8000-0000000009c2',
                   'payout:release:9c2') RETURNING id)
INSERT INTO postings (entry_id, account_id, amount_minor, currency)
SELECT id, '00000000-0000-4000-8000-0000000009a1'::uuid, 150, 'USD' FROM e
UNION ALL SELECT id, '00000000-0000-4000-8000-000000000905'::uuid, -150, 'USD' FROM e;
SELECT pg_temp.expect_error($q$
  UPDATE payout_requests SET state = 'rejected', decided_at = now(), completed_at = now(),
         release_entry_id = '00000000-0000-4000-8000-0000000009b4' WHERE id = '00000000-0000-4000-8000-0000000009c2' $q$, '23514');
SET CONSTRAINTS ALL DEFERRED;
UPDATE payout_requests SET state = 'rejected', reason_code = 'documents_missing', decided_at = now(), completed_at = now(),
       release_entry_id = '00000000-0000-4000-8000-0000000009b4' WHERE id = '00000000-0000-4000-8000-0000000009c2';
SET CONSTRAINTS ALL IMMEDIATE;
SET CONSTRAINTS ALL DEFERRED;
SELECT pg_temp.assert(
  (SELECT -sum(p.amount_minor) = 200 FROM postings p WHERE p.account_id = '00000000-0000-4000-8000-000000000905'),
  'available balance is 700 - 500 paid = 200 after the rejected request is released');
-- اختبار مقلوب: بلا المحفّز يمر الصرف فوق المتاح، فالاختبار أعلاه يقيس المحفّز
SAVEPOINT payable_mutation;
ALTER TABLE postings DISABLE TRIGGER postings_payable_not_debit;
WITH e AS (INSERT INTO journal_entries (kind, reference_type, reference_id, idempotency_key)
           VALUES ('payout', 'payout_request', '00000000-0000-4000-8000-0000000009c9', 'payout:hold:mutant') RETURNING id)
INSERT INTO postings (entry_id, account_id, amount_minor, currency)
SELECT id, '00000000-0000-4000-8000-000000000905'::uuid, 900, 'USD' FROM e
UNION ALL SELECT id, '00000000-0000-4000-8000-0000000009a1'::uuid, -900, 'USD' FROM e;
SET CONSTRAINTS ALL IMMEDIATE;
ROLLBACK TO SAVEPOINT payable_mutation;
SET CONSTRAINTS ALL DEFERRED;
-- حدث الصرف بمعرّفاته وحالته وحدها، بلا مبلغ
INSERT INTO outbox_events (type, aggregate_type, aggregate_id, idempotency_key, payload)
VALUES ('payout.status_changed', 'payout', '00000000-0000-4000-8000-0000000009c1', 'payout.status_changed:smoke:1',
        '{"payout_request_id": "00000000-0000-4000-8000-0000000009c1", "user_id": "00000000-0000-4000-8000-000000000011", "state": "paid", "reason_code": null}');
SELECT pg_temp.expect_error($q$
  INSERT INTO outbox_events (type, aggregate_type, aggregate_id, idempotency_key, payload)
  VALUES ('payout.status_changed', 'payout', '00000000-0000-4000-8000-0000000009c1', 'payout.status_changed:smoke:2',
          '{"payout_request_id": "00000000-0000-4000-8000-0000000009c1", "amount_minor": 500}') $q$, '23514');
-- اسم العمل (ADR 0035): لحساب طاقم، بلا مسافة في طرفيه ولا محارف تحكّم، ولا لحساب مشترٍ
UPDATE users SET work_name = 'منتج الصباح' WHERE id = '00000000-0000-4000-8000-000000000014';
UPDATE users SET work_name = NULL WHERE id = '00000000-0000-4000-8000-000000000014';
SELECT pg_temp.expect_error($q$ UPDATE users SET work_name = ' منتج' WHERE id = '00000000-0000-4000-8000-000000000014' $q$, '23514');
SELECT pg_temp.expect_error($q$ UPDATE users SET work_name = E'منتج\nالصباح' WHERE id = '00000000-0000-4000-8000-000000000014' $q$, '23514');
SELECT pg_temp.expect_error($q$ UPDATE users SET work_name = E'منتج\u202Eالصباح' WHERE id = '00000000-0000-4000-8000-000000000014' $q$, '23514');
SELECT pg_temp.expect_error($q$ UPDATE users SET work_name = E'\u2067منتج' WHERE id = '00000000-0000-4000-8000-000000000014' $q$, '23514');
SELECT pg_temp.expect_error($q$ UPDATE users SET work_name = '' WHERE id = '00000000-0000-4000-8000-000000000014' $q$, '23514');
SELECT pg_temp.expect_error($q$ UPDATE users SET work_name = repeat('x', 81) WHERE id = '00000000-0000-4000-8000-000000000014' $q$, '23514');
SELECT pg_temp.expect_error($q$ UPDATE users SET work_name = 'مشترٍ' WHERE id = '00000000-0000-4000-8000-000000000711' $q$, '23514');
-- نسخ قالب «مواد متداولة» (ADR 0091): طلب لكل نسخة من الأصل المتحقق، والعنوان 1–3 أسطر كلٌّ 1–22 محرفًا والمكان ≤ 44
-- بقاعدة الوسوم نفسها، والجاهز يشير إلى مشتق circulated_render، والفشل بسبب من القائمة، والحمولة معرّفات وحدها
INSERT INTO material_renders (id, material_id, material_version, source_file_id, template, aspect, title_lines, location_text, label, requested_by)
VALUES ('00000000-0000-4000-8000-000000000d01', '00000000-0000-4000-8000-000000000101', 1, '00000000-0000-4000-8000-000000000301',
        'circulated', 'vertical', ARRAY['عنوان تجريبي', 'للمادة المتداولة'], 'مدينة، محافظة', 'circulated_footage',
        '00000000-0000-4000-8000-000000000012');
-- نسخة ثانية من الأصل نفسه بلا مكان ولا وسم: عدة نسخ لكل أصل
INSERT INTO material_renders (id, material_id, material_version, source_file_id, template, aspect, title_lines, label, requested_by)
VALUES ('00000000-0000-4000-8000-000000000d02', '00000000-0000-4000-8000-000000000101', 1, '00000000-0000-4000-8000-000000000301',
        'circulated', 'square', ARRAY[repeat('م', 22)], 'none', '00000000-0000-4000-8000-000000000013');
SELECT pg_temp.assert((SELECT state = 'requested' AND file_id IS NULL AND completed_at IS NULL FROM material_renders
  WHERE id = '00000000-0000-4000-8000-000000000d02'), 'a render starts requested without a file');
SELECT pg_temp.expect_error($q$ UPDATE material_renders SET title_lines = ARRAY['أ', 'ب', 'ج', 'د'] WHERE id = '00000000-0000-4000-8000-000000000d02' $q$, '23514');
SELECT pg_temp.expect_error($q$ UPDATE material_renders SET title_lines = '{}' WHERE id = '00000000-0000-4000-8000-000000000d02' $q$, '23514');
SELECT pg_temp.expect_error($q$ UPDATE material_renders SET title_lines = ARRAY[repeat('م', 23)] WHERE id = '00000000-0000-4000-8000-000000000d02' $q$, '23514');
SELECT pg_temp.expect_error($q$ UPDATE material_renders SET title_lines = ARRAY[''] WHERE id = '00000000-0000-4000-8000-000000000d02' $q$, '23514');
SELECT pg_temp.expect_error($q$ UPDATE material_renders SET title_lines = ARRAY[NULL::text] WHERE id = '00000000-0000-4000-8000-000000000d02' $q$, '23514');
SELECT pg_temp.expect_error($q$ UPDATE material_renders SET title_lines = ARRAY[' عنوان'] WHERE id = '00000000-0000-4000-8000-000000000d02' $q$, '23514');
SELECT pg_temp.expect_error($q$ UPDATE material_renders SET title_lines = ARRAY[E'عنوان\u00a0'] WHERE id = '00000000-0000-4000-8000-000000000d02' $q$, '23514');
SELECT pg_temp.expect_error($q$ UPDATE material_renders SET title_lines = ARRAY[E'سطر\nثانٍ'] WHERE id = '00000000-0000-4000-8000-000000000d02' $q$, '23514');
SELECT pg_temp.expect_error($q$ UPDATE material_renders SET title_lines = ARRAY[E'عن\u202eوان'] WHERE id = '00000000-0000-4000-8000-000000000d02' $q$, '23514');
SELECT pg_temp.expect_error($q$ UPDATE material_renders SET title_lines = ARRAY[E'عن\u061cوان'] WHERE id = '00000000-0000-4000-8000-000000000d02' $q$, '23514');
SELECT pg_temp.expect_error($q$ UPDATE material_renders SET title_lines = ARRAY[E'عن\u2067وان'] WHERE id = '00000000-0000-4000-8000-000000000d02' $q$, '23514');
SELECT pg_temp.expect_error($q$ UPDATE material_renders SET title_lines = ARRAY[ARRAY['أ'], ARRAY['ب']] WHERE id = '00000000-0000-4000-8000-000000000d02' $q$, '23514');
SELECT pg_temp.expect_error($q$ UPDATE material_renders SET location_text = repeat('د', 45) WHERE id = '00000000-0000-4000-8000-000000000d02' $q$, '23514');
SELECT pg_temp.expect_error($q$ UPDATE material_renders SET location_text = '' WHERE id = '00000000-0000-4000-8000-000000000d02' $q$, '23514');
SELECT pg_temp.expect_error($q$ UPDATE material_renders SET location_text = E'مدينة\u200f' WHERE id = '00000000-0000-4000-8000-000000000d02' $q$, '23514');
UPDATE material_renders SET location_text = repeat('د', 44) WHERE id = '00000000-0000-4000-8000-000000000d02';
UPDATE material_renders SET location_text = NULL WHERE id = '00000000-0000-4000-8000-000000000d02';
SELECT pg_temp.expect_error($q$ UPDATE material_renders SET aspect = 'portrait' WHERE id = '00000000-0000-4000-8000-000000000d02' $q$, '23514');
SELECT pg_temp.expect_error($q$ UPDATE material_renders SET label = 'third_party' WHERE id = '00000000-0000-4000-8000-000000000d02' $q$, '23514');
SELECT pg_temp.expect_error($q$ UPDATE material_renders SET template = 'urgent' WHERE id = '00000000-0000-4000-8000-000000000d02' $q$, '23514');
-- «الشاهد» قالب ثانٍ بالقيود نفسها (ADR 0109، ترحيل 045)، وما سواهما مرفوض
UPDATE material_renders SET template = 'witness' WHERE id = '00000000-0000-4000-8000-000000000d02';
SELECT pg_temp.expect_error($q$ UPDATE material_renders SET template = 'Witness' WHERE id = '00000000-0000-4000-8000-000000000d02' $q$, '23514');
UPDATE material_renders SET template = 'circulated' WHERE id = '00000000-0000-4000-8000-000000000d02';
SELECT pg_temp.expect_error($q$ UPDATE material_renders SET material_version = 0 WHERE id = '00000000-0000-4000-8000-000000000d02' $q$, '23514');
SELECT pg_temp.expect_error($q$ UPDATE material_renders SET state = 'ready', completed_at = now() WHERE id = '00000000-0000-4000-8000-000000000d02' $q$, '23514');
SELECT pg_temp.expect_error($q$ UPDATE material_renders SET state = 'failed', completed_at = now() WHERE id = '00000000-0000-4000-8000-000000000d02' $q$, '23514');
SELECT pg_temp.expect_error($q$ UPDATE material_renders SET state = 'failed', failure_reason = 'because', completed_at = now() WHERE id = '00000000-0000-4000-8000-000000000d02' $q$, '23514');
SELECT pg_temp.expect_error($q$ UPDATE material_renders SET state = 'failed', failure_reason = 'render_failed' WHERE id = '00000000-0000-4000-8000-000000000d02' $q$, '23514');
SELECT pg_temp.expect_error($q$ UPDATE material_renders SET state = 'rendering' WHERE id = '00000000-0000-4000-8000-000000000d02' $q$, '23514');
SELECT pg_temp.expect_error($q$ UPDATE material_renders SET started_at = now() WHERE id = '00000000-0000-4000-8000-000000000d02' $q$, '23514');
SELECT pg_temp.expect_error($q$ UPDATE material_renders SET state = 'rendering', started_at = now(), completed_at = now() WHERE id = '00000000-0000-4000-8000-000000000d02' $q$, '23514');
SELECT pg_temp.expect_error($q$ UPDATE material_renders SET state = 'paused', started_at = now() WHERE id = '00000000-0000-4000-8000-000000000d02' $q$, '23514');
UPDATE material_renders SET state = 'rendering', started_at = now() WHERE id = '00000000-0000-4000-8000-000000000d02';
UPDATE material_renders SET state = 'failed', failure_reason = 'title_overflow', completed_at = now() WHERE id = '00000000-0000-4000-8000-000000000d02';
-- المشتق من الأصل وحده، ونسخة واحدة لكل ملف
SELECT pg_temp.expect_error($q$
  INSERT INTO material_files (material_id, kind, state, mime_type) VALUES ('00000000-0000-4000-8000-000000000101', 'circulated_render', 'verified', 'video/mp4') $q$, '23514');
INSERT INTO material_files (id, material_id, kind, state, derived_from_id, mime_type, sha256, verified_at)
VALUES ('00000000-0000-4000-8000-000000000d11', '00000000-0000-4000-8000-000000000101', 'circulated_render', 'verified',
        '00000000-0000-4000-8000-000000000301', 'video/mp4', sha256('render'::bytea), now());
SELECT pg_temp.expect_error($q$
  UPDATE material_renders SET state = 'ready', file_id = '00000000-0000-4000-8000-000000000d11', completed_at = now()
   WHERE id = '00000000-0000-4000-8000-000000000d01' $q$, '23514');
UPDATE material_renders SET state = 'rendering', started_at = now() WHERE id = '00000000-0000-4000-8000-000000000d01';
UPDATE material_renders SET state = 'ready', file_id = '00000000-0000-4000-8000-000000000d11', completed_at = now()
WHERE id = '00000000-0000-4000-8000-000000000d01';
SELECT pg_temp.expect_error($q$
  UPDATE material_renders SET state = 'ready', failure_reason = NULL, file_id = '00000000-0000-4000-8000-000000000d11'
   WHERE id = '00000000-0000-4000-8000-000000000d02' $q$, '23505');
-- نسخة لكل طلب: مشتق ثانٍ من الأصل نفسه مسموح (ترحيل 038)
INSERT INTO material_files (id, material_id, kind, state, derived_from_id, mime_type, sha256, verified_at)
VALUES ('00000000-0000-4000-8000-000000000d12', '00000000-0000-4000-8000-000000000101', 'circulated_render', 'verified',
        '00000000-0000-4000-8000-000000000301', 'video/mp4', sha256('render 2'::bytea), now());
INSERT INTO outbox_events (type, aggregate_type, aggregate_id, idempotency_key, actor_id, payload)
VALUES ('render.requested', 'material', '00000000-0000-4000-8000-000000000101', 'render.requested:00000000-0000-4000-8000-000000000d01',
        '00000000-0000-4000-8000-000000000012',
        '{"material_id": "00000000-0000-4000-8000-000000000101", "render_id": "00000000-0000-4000-8000-000000000d01",
          "source_file_id": "00000000-0000-4000-8000-000000000301", "requested_by": "00000000-0000-4000-8000-000000000012"}');
INSERT INTO outbox_events (type, aggregate_type, aggregate_id, idempotency_key, payload)
VALUES ('render.started', 'material', '00000000-0000-4000-8000-000000000101', 'render.started:00000000-0000-4000-8000-000000000d01',
        '{"material_id": "00000000-0000-4000-8000-000000000101", "render_id": "00000000-0000-4000-8000-000000000d01"}');
SELECT pg_temp.expect_error($q$
  INSERT INTO outbox_events (type, aggregate_type, aggregate_id, idempotency_key, payload)
  VALUES ('render.started', 'material', '00000000-0000-4000-8000-000000000101', 'render.started:smoke:worker',
          '{"material_id": "00000000-0000-4000-8000-000000000101", "render_id": "00000000-0000-4000-8000-000000000d01",
            "worker_host": "media-render-1"}') $q$, '23514');
INSERT INTO outbox_events (type, aggregate_type, aggregate_id, idempotency_key, payload)
VALUES ('render.completed', 'material', '00000000-0000-4000-8000-000000000101', 'render.completed:00000000-0000-4000-8000-000000000d01',
        '{"material_id": "00000000-0000-4000-8000-000000000101", "render_id": "00000000-0000-4000-8000-000000000d01",
          "file_id": "00000000-0000-4000-8000-000000000d11"}');
INSERT INTO outbox_events (type, aggregate_type, aggregate_id, idempotency_key, payload)
VALUES ('render.failed', 'material', '00000000-0000-4000-8000-000000000101', 'render.failed:00000000-0000-4000-8000-000000000d02',
        '{"material_id": "00000000-0000-4000-8000-000000000101", "render_id": "00000000-0000-4000-8000-000000000d02",
          "failure_reason": "title_overflow"}');
SELECT pg_temp.expect_error($q$
  INSERT INTO outbox_events (type, aggregate_type, aggregate_id, idempotency_key, payload)
  VALUES ('render.requested', 'material', '00000000-0000-4000-8000-000000000101', 'render.requested:smoke:title',
          '{"material_id": "00000000-0000-4000-8000-000000000101", "render_id": "00000000-0000-4000-8000-000000000d01",
            "title_lines": ["عنوان تجريبي"]}') $q$, '23514');
SELECT pg_temp.expect_error($q$
  INSERT INTO outbox_events (type, aggregate_type, aggregate_id, idempotency_key, payload)
  VALUES ('render.completed', 'material', '00000000-0000-4000-8000-000000000101', 'render.completed:smoke:key',
          '{"material_id": "00000000-0000-4000-8000-000000000101", "render_id": "00000000-0000-4000-8000-000000000d01",
            "storage_key": "derived/x/y/z.mp4"}') $q$, '23514');
SELECT pg_temp.expect_error($q$
  INSERT INTO outbox_events (type, aggregate_type, aggregate_id, idempotency_key, payload)
  VALUES ('render.failed', 'material', '00000000-0000-4000-8000-000000000101', 'render.failed:smoke:location',
          '{"material_id": "00000000-0000-4000-8000-000000000101", "render_id": "00000000-0000-4000-8000-000000000d02",
            "location_text": "مدينة، محافظة"}') $q$, '23514');
-- إسناد المادة إلى المونتير (ADR 0096): مهمة مفتوحة واحدة لكل مادة، والأوقات تتبع الحالة، والملاحظتان بقاعدة الوسوم،
-- والحمولة معرّفات وحالات وحدها، وإشعار المهمة يحمل معرّفها
INSERT INTO material_assignments (id, material_id, assignee_id, assigned_by, due_at, note)
VALUES ('00000000-0000-4000-8000-000000000e01', '00000000-0000-4000-8000-000000000101', '00000000-0000-4000-8000-000000000013',
        '00000000-0000-4000-8000-000000000012', now() + interval '30 minutes', 'تقرير تجريبي 60 ثانية طولي');
SELECT pg_temp.assert((SELECT state = 'assigned' AND acknowledged_at IS NULL AND closed_at IS NULL FROM material_assignments
  WHERE id = '00000000-0000-4000-8000-000000000e01'), 'an assignment starts assigned');
SELECT pg_temp.expect_error($q$
  INSERT INTO material_assignments (material_id, assignee_id, assigned_by, due_at)
  VALUES ('00000000-0000-4000-8000-000000000101', '00000000-0000-4000-8000-000000000013', '00000000-0000-4000-8000-000000000012',
          now() + interval '1 hour') $q$, '23505');
SELECT pg_temp.expect_error($q$ UPDATE material_assignments SET due_at = created_at - interval '1 minute' WHERE id = '00000000-0000-4000-8000-000000000e01' $q$, '23514');
SELECT pg_temp.expect_error($q$ UPDATE material_assignments SET note = '' WHERE id = '00000000-0000-4000-8000-000000000e01' $q$, '23514');
SELECT pg_temp.expect_error($q$ UPDATE material_assignments SET note = ' ملاحظة' WHERE id = '00000000-0000-4000-8000-000000000e01' $q$, '23514');
SELECT pg_temp.expect_error($q$ UPDATE material_assignments SET note = E'ملا\u202eحظة' WHERE id = '00000000-0000-4000-8000-000000000e01' $q$, '23514');
SELECT pg_temp.expect_error($q$ UPDATE material_assignments SET note = repeat('م', 501) WHERE id = '00000000-0000-4000-8000-000000000e01' $q$, '23514');
UPDATE material_assignments SET note = repeat('م', 500) WHERE id = '00000000-0000-4000-8000-000000000e01';
SELECT pg_temp.expect_error($q$ UPDATE material_assignments SET state = 'paused' WHERE id = '00000000-0000-4000-8000-000000000e01' $q$, '23514');
SELECT pg_temp.expect_error($q$ UPDATE material_assignments SET state = 'acknowledged' WHERE id = '00000000-0000-4000-8000-000000000e01' $q$, '23514');
SELECT pg_temp.expect_error($q$ UPDATE material_assignments SET state = 'in_progress', acknowledged_at = now() WHERE id = '00000000-0000-4000-8000-000000000e01' $q$, '23514');
SELECT pg_temp.expect_error($q$ UPDATE material_assignments SET state = 'done', acknowledged_at = now(), started_at = now() WHERE id = '00000000-0000-4000-8000-000000000e01' $q$, '23514');
SELECT pg_temp.expect_error($q$ UPDATE material_assignments SET state = 'returned', closed_at = now() WHERE id = '00000000-0000-4000-8000-000000000e01' $q$, '23514');
SELECT pg_temp.expect_error($q$ UPDATE material_assignments SET return_note = 'سبب' WHERE id = '00000000-0000-4000-8000-000000000e01' $q$, '23514');
UPDATE material_assignments SET state = 'acknowledged', acknowledged_at = now() WHERE id = '00000000-0000-4000-8000-000000000e01';
UPDATE material_assignments SET state = 'in_progress', started_at = now() WHERE id = '00000000-0000-4000-8000-000000000e01';
UPDATE material_assignments SET state = 'done', closed_at = now() WHERE id = '00000000-0000-4000-8000-000000000e01';
-- بعد إغلاقها تُفتح مهمة جديدة للمادة نفسها، وتُعاد قبل الإقرار بسبب
INSERT INTO material_assignments (id, material_id, assignee_id, assigned_by, due_at)
VALUES ('00000000-0000-4000-8000-000000000e02', '00000000-0000-4000-8000-000000000101', '00000000-0000-4000-8000-000000000013',
        '00000000-0000-4000-8000-000000000012', now() + interval '1 day');
SELECT pg_temp.expect_error($q$ UPDATE material_assignments SET state = 'returned', closed_at = now(), returned_by = '00000000-0000-4000-8000-000000000012', return_note = E'سطر\nثانٍ' WHERE id = '00000000-0000-4000-8000-000000000e02' $q$, '23514');
UPDATE material_assignments SET state = 'returned', closed_at = now(), returned_by = '00000000-0000-4000-8000-000000000012',
       return_note = 'أُعيد توزيعها' WHERE id = '00000000-0000-4000-8000-000000000e02';
INSERT INTO outbox_events (type, aggregate_type, aggregate_id, idempotency_key, actor_id, payload)
VALUES ('assignment.created', 'material', '00000000-0000-4000-8000-000000000101', 'assignment.created:00000000-0000-4000-8000-000000000e01',
        '00000000-0000-4000-8000-000000000012',
        '{"material_id": "00000000-0000-4000-8000-000000000101", "assignment_id": "00000000-0000-4000-8000-000000000e01",
          "priority": "important", "assignee_id": "00000000-0000-4000-8000-000000000013",
          "assigned_by": "00000000-0000-4000-8000-000000000012"}');
INSERT INTO outbox_events (type, aggregate_type, aggregate_id, idempotency_key, actor_id, payload)
VALUES ('assignment.state_changed', 'material', '00000000-0000-4000-8000-000000000101', 'assignment.state_changed:smoke:done',
        '00000000-0000-4000-8000-000000000013',
        '{"material_id": "00000000-0000-4000-8000-000000000101", "assignment_id": "00000000-0000-4000-8000-000000000e01",
          "priority": "important", "assignee_id": "00000000-0000-4000-8000-000000000013", "from": "in_progress", "to": "done"}');
SELECT pg_temp.expect_error($q$
  INSERT INTO outbox_events (type, aggregate_type, aggregate_id, idempotency_key, payload)
  VALUES ('assignment.created', 'material', '00000000-0000-4000-8000-000000000101', 'assignment.created:smoke:note',
          '{"material_id": "00000000-0000-4000-8000-000000000101", "assignment_id": "00000000-0000-4000-8000-000000000e01",
            "note": "تقرير تجريبي"}') $q$, '23514');
SELECT pg_temp.expect_error($q$
  INSERT INTO outbox_events (type, aggregate_type, aggregate_id, idempotency_key, payload)
  VALUES ('assignment.state_changed', 'material', '00000000-0000-4000-8000-000000000101', 'assignment.state_changed:smoke:due',
          '{"material_id": "00000000-0000-4000-8000-000000000101", "assignment_id": "00000000-0000-4000-8000-000000000e01",
            "due_at": "2026-11-03T10:00:00Z"}') $q$, '23514');
INSERT INTO notifications (user_id, event_id, type, material_id, title, priority, assignment_state, escalate_at, assignment_id)
SELECT '00000000-0000-4000-8000-000000000013', id, type, '00000000-0000-4000-8000-000000000101', 'مهمة جديدة: المادة #00000000',
       'important', 'assigned', now() + interval '5 minutes', '00000000-0000-4000-8000-000000000e01'
FROM outbox_events WHERE idempotency_key = 'assignment.created:00000000-0000-4000-8000-000000000e01';
INSERT INTO audit_log (actor_id, action, target_type, target_id, details, hash)
VALUES ('00000000-0000-4000-8000-000000000012', 'assignment.created', 'material_assignment', '00000000-0000-4000-8000-000000000e01',
        '{"assignment_id": "00000000-0000-4000-8000-000000000e01", "material_id": "00000000-0000-4000-8000-000000000101",
          "target_user_id": "00000000-0000-4000-8000-000000000013", "to": "assigned"}', '\x00');
SELECT pg_temp.expect_error($q$
  INSERT INTO audit_log (actor_id, action, target_type, target_id, details, hash)
  VALUES (NULL, 'assignment.created', 'material_assignment', NULL, '{"note": "تقرير تجريبي"}', '\x00') $q$, '23514');

-- ---------- إدارة الوسوم (ADR 0098) ----------
-- القائمة المقترحة صف واحد مبذور، وكل وسم فيها بقاعدة MaterialTag حتى 50 بلا تكرار
SELECT pg_temp.assert((SELECT count(*) = 1 AND bool_and(tags = '{}' AND version = 1) FROM tag_suggestions), 'tag suggestions seeded once, empty');
SELECT pg_temp.expect_error($q$ INSERT INTO tag_suggestions (id) VALUES (false) $q$, '23514');
SELECT pg_temp.expect_error($q$ INSERT INTO tag_suggestions DEFAULT VALUES $q$, '23505');
UPDATE tag_suggestions SET tags = ARRAY['نزوح', 'مساعدات'], version = version + 1, updated_by = '00000000-0000-4000-8000-000000000012';
UPDATE tag_suggestions SET tags = (SELECT array_agg('وسم ' || i) FROM generate_series(1, 50) AS i);
SELECT pg_temp.expect_error($q$ UPDATE tag_suggestions SET tags = (SELECT array_agg('وسم ' || i) FROM generate_series(1, 51) AS i) $q$, '23514');
SELECT pg_temp.expect_error($q$ UPDATE tag_suggestions SET tags = ARRAY['نزوح', 'نزوح'] $q$, '23514');
SELECT pg_temp.expect_error($q$ UPDATE tag_suggestions SET tags = ARRAY[' نزوح'] $q$, '23514');
SELECT pg_temp.expect_error($q$ UPDATE tag_suggestions SET tags = ARRAY[E'نزو\u200fح'] $q$, '23514');
SELECT pg_temp.expect_error($q$ UPDATE tag_suggestions SET tags = ARRAY[NULL::text] $q$, '23514');
SELECT pg_temp.expect_error($q$ UPDATE tag_suggestions SET tags = ARRAY[repeat('م', 41)] $q$, '23514');
SELECT pg_temp.expect_error($q$ UPDATE tag_suggestions SET version = 0 $q$, '23514');
-- سجل الدمج: أصل وهدف مختلفان بالقاعدة نفسها، ونوع مغلق، ولا يُعدَّل ولا يُحذف
INSERT INTO tag_rewrites (id, source, target, mode, materials_updated, created_by)
VALUES ('00000000-0000-4000-8000-000000000f01', 'مياة', 'مياه', 'rename', 1, '00000000-0000-4000-8000-000000000012');
INSERT INTO tag_rewrite_materials (tag_rewrite_id, material_id)
VALUES ('00000000-0000-4000-8000-000000000f01', '00000000-0000-4000-8000-000000000101');
SELECT pg_temp.expect_error($q$ INSERT INTO tag_rewrites (source, target, mode, materials_updated, created_by)
  VALUES ('مياه', 'مياه', 'merge', 0, '00000000-0000-4000-8000-000000000012') $q$, '23514');
SELECT pg_temp.expect_error($q$ INSERT INTO tag_rewrites (source, target, mode, materials_updated, created_by)
  VALUES ('مياه', 'خيام', 'split', 0, '00000000-0000-4000-8000-000000000012') $q$, '23514');
SELECT pg_temp.expect_error($q$ INSERT INTO tag_rewrites (source, target, mode, materials_updated, created_by)
  VALUES (E'مياه\n', 'خيام', 'merge', 0, '00000000-0000-4000-8000-000000000012') $q$, '23514');
SELECT pg_temp.expect_error($q$ INSERT INTO tag_rewrites (source, target, mode, materials_updated, created_by)
  VALUES ('مياه', 'خيام', 'merge', -1, '00000000-0000-4000-8000-000000000012') $q$, '23514');
SELECT pg_temp.expect_error($q$ UPDATE tag_rewrites SET target = 'خيام' WHERE id = '00000000-0000-4000-8000-000000000f01' $q$, '42501');
SELECT pg_temp.expect_error($q$ DELETE FROM tag_rewrites WHERE id = '00000000-0000-4000-8000-000000000f01' $q$, '42501');
-- الحدثان والتدقيق أرقام ومعرّفات: لا نص وسم
INSERT INTO outbox_events (type, aggregate_type, aggregate_id, idempotency_key, actor_id, payload)
VALUES ('tag.suggestions_changed', 'user', '00000000-0000-4000-8000-000000000012', 'tag.suggestions_changed:smoke',
        '00000000-0000-4000-8000-000000000012', '{"suggestions_version": 2}');
INSERT INTO outbox_events (type, aggregate_type, aggregate_id, idempotency_key, actor_id, payload)
VALUES ('tag.rewritten', 'user', '00000000-0000-4000-8000-000000000012', 'tag.rewritten:00000000-0000-4000-8000-000000000f01',
        '00000000-0000-4000-8000-000000000012',
        '{"tag_rewrite_id": "00000000-0000-4000-8000-000000000f01", "mode": "rename", "materials_updated": 1}');
SELECT pg_temp.expect_error($q$
  INSERT INTO outbox_events (type, aggregate_type, aggregate_id, idempotency_key, payload)
  VALUES ('tag.rewritten', 'user', '00000000-0000-4000-8000-000000000012', 'tag.rewritten:smoke:source',
          '{"tag_rewrite_id": "00000000-0000-4000-8000-000000000f01", "source": "مياة"}') $q$, '23514');
SELECT pg_temp.expect_error($q$
  INSERT INTO outbox_events (type, aggregate_type, aggregate_id, idempotency_key, payload)
  VALUES ('tag.suggestions_changed', 'user', '00000000-0000-4000-8000-000000000012', 'tag.suggestions_changed:smoke:tags',
          '{"suggestions_version": 3, "tags": ["نزوح"]}') $q$, '23514');
INSERT INTO audit_log (actor_id, action, target_type, target_id, details, hash)
VALUES ('00000000-0000-4000-8000-000000000012', 'tag.rewritten', 'tag_rewrite', '00000000-0000-4000-8000-000000000f01',
        '{"tag_rewrite_id": "00000000-0000-4000-8000-000000000f01", "mode": "rename", "materials_updated": 1}', '\x00');
INSERT INTO audit_log (actor_id, action, target_type, target_id, details, hash)
VALUES ('00000000-0000-4000-8000-000000000012', 'tag.suggestions_changed', 'tag_suggestions', 'tag_suggestions',
        '{"suggestions_version": 2}', '\x00');
SELECT pg_temp.expect_error($q$
  INSERT INTO audit_log (actor_id, action, target_type, target_id, details, hash)
  VALUES (NULL, 'tag.rewritten', 'tag_rewrite', NULL, '{"source": "مياة"}', '\x00') $q$, '23514');
-- ---------- هوية المنصة (ADR 0099) ----------
SELECT pg_temp.assert((SELECT count(*) = 1 AND bool_and(version = 1 AND platform_name = 'المكتبة المرئية') FROM platform_settings), 'platform settings seeded once');
SELECT pg_temp.expect_error($q$ INSERT INTO platform_settings (id, platform_name, app_name, watermark_text) VALUES (false, 'م', 'ت', 'ع') $q$, '23514');
SELECT pg_temp.expect_error($q$ INSERT INTO platform_settings (platform_name, app_name, watermark_text) VALUES ('م', 'ت', 'ع') $q$, '23505');
UPDATE platform_settings SET watermark_text = repeat('م', 60), version = version + 1, updated_by = '00000000-0000-4000-8000-000000000012';
SELECT pg_temp.expect_error($q$ UPDATE platform_settings SET watermark_text = repeat('م', 61) $q$, '23514');
SELECT pg_temp.expect_error($q$ UPDATE platform_settings SET app_name = repeat('م', 41) $q$, '23514');
SELECT pg_temp.expect_error($q$ UPDATE platform_settings SET platform_name = ' منصة' $q$, '23514');
SELECT pg_temp.expect_error($q$ UPDATE platform_settings SET app_name = E'تطبيق\u202e' $q$, '23514');
SELECT pg_temp.expect_error($q$ UPDATE platform_settings SET watermark_text = '' $q$, '23514');
SELECT pg_temp.expect_error($q$ UPDATE platform_settings SET version = 0 $q$, '23514');
INSERT INTO outbox_events (type, aggregate_type, aggregate_id, idempotency_key, actor_id, payload)
VALUES ('platform_settings.changed', 'user', '00000000-0000-4000-8000-000000000012', 'platform_settings.changed:smoke',
        '00000000-0000-4000-8000-000000000012', '{"settings_version": 2, "changed_fields": ["watermark_text"]}');
SELECT pg_temp.expect_error($q$
  INSERT INTO outbox_events (type, aggregate_type, aggregate_id, idempotency_key, payload)
  VALUES ('platform_settings.changed', 'user', '00000000-0000-4000-8000-000000000012', 'platform_settings.changed:smoke:text',
          '{"settings_version": 3, "watermark_text": "معاينة"}') $q$, '23514');
INSERT INTO audit_log (actor_id, action, target_type, target_id, details, hash)
VALUES ('00000000-0000-4000-8000-000000000012', 'platform_settings.changed', 'platform_settings', 'platform_settings',
        '{"settings_version": 2, "field_keys": ["watermark_text"]}', '\x00');
SET CONSTRAINTS ALL DEFERRED;

-- ---------- فجوات البناء (ADR 0104؛ ترحيل 043) ----------
-- جلسة النسخة المُنتَجة نوع مقبول، وملفها لا يأخذ إيصالًا (المحفّز للأصل وحده)
INSERT INTO upload_sessions (id, material_id, created_by, kind, size_bytes, filename, part_size_bytes, expires_at)
VALUES ('00000000-0000-4000-8000-000000004301', '00000000-0000-4000-8000-000000000101', '00000000-0000-4000-8000-000000000013',
        'produced', 1048576, 'cut.mp4', 16777216, now() + interval '7 days');
SELECT pg_temp.expect_error($q$ UPDATE upload_sessions SET kind = 'edit' WHERE id = '00000000-0000-4000-8000-000000004301' $q$, '23514');
INSERT INTO material_files (id, material_id, kind, state, upload_session_id, storage_key, size_bytes)
VALUES ('00000000-0000-4000-8000-000000004302', '00000000-0000-4000-8000-000000000101', 'produced', 'received',
        '00000000-0000-4000-8000-000000004301', 'uploads/produced', 1048576);
UPDATE material_files SET state = 'verified', verified_at = now(), sha256 = sha256('cut'::bytea)
 WHERE id = '00000000-0000-4000-8000-000000004302';
SELECT pg_temp.assert((SELECT receipt_number IS NULL FROM material_files WHERE id = '00000000-0000-4000-8000-000000004302'),
  'no receipt for a produced file');
-- التسليم بالملف: من المادة نفسها، ومع done وحدها
INSERT INTO materials (id, reporter_id, office_id, title, material_types, governorate, city, priority,
                       sensitivity_minors, sensitivity_injured, sensitivity_graphic, display_name_mode, form_version, dynamic_fields)
VALUES ('00000000-0000-4000-8000-000000004303', '00000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-000000000001',
        'مادة تجريبية ثانية', '{report}', 'غزة', 'غزة', 'normal', false, false, false, 'network', 1, '{}');
INSERT INTO material_files (id, material_id, kind, state, storage_key, size_bytes, sha256, verified_at)
VALUES ('00000000-0000-4000-8000-000000004304', '00000000-0000-4000-8000-000000004303', 'produced', 'verified',
        'uploads/other', 1048576, sha256('other'::bytea), now());
UPDATE material_assignments SET produced_file_id = '00000000-0000-4000-8000-000000004302' WHERE id = '00000000-0000-4000-8000-000000000e01';
SELECT pg_temp.expect_error($q$
  UPDATE material_assignments SET produced_file_id = '00000000-0000-4000-8000-000000004304' WHERE id = '00000000-0000-4000-8000-000000000e01' $q$, '23503');
SELECT pg_temp.expect_error($q$
  UPDATE material_assignments SET produced_file_id = '00000000-0000-4000-8000-000000004302' WHERE id = '00000000-0000-4000-8000-000000000e02' $q$, '23514');
-- المؤسسة المرفوضة: بسبب من القائمة المغلقة، ولا سبب لغيرها، ولا تحتاج تفعيلًا سابقًا
INSERT INTO buyer_organizations (id, legal_name, display_name_ar, display_name_en, country, billing_email)
VALUES ('00000000-0000-4000-8000-000000004305', 'Sample Media Ltd', 'وكالة تجريبية', 'Sample Media', 'GB', 'billing-2@example.invalid');
SELECT pg_temp.expect_error($q$
  UPDATE buyer_organizations SET status = 'rejected' WHERE id = '00000000-0000-4000-8000-000000004305' $q$, '23514');
SELECT pg_temp.expect_error($q$
  UPDATE buyer_organizations SET status = 'rejected', rejection_reason = 'no_reason' WHERE id = '00000000-0000-4000-8000-000000004305' $q$, '23514');
SELECT pg_temp.expect_error($q$
  UPDATE buyer_organizations SET rejection_reason = 'other' WHERE id = '00000000-0000-4000-8000-000000004305' $q$, '23514');
UPDATE buyer_organizations SET status = 'rejected', rejection_reason = 'commercial_registry' WHERE id = '00000000-0000-4000-8000-000000004305';
-- الحدثان: معرّفات ورموز وحدها
INSERT INTO outbox_events (type, aggregate_type, aggregate_id, idempotency_key, actor_id, payload)
VALUES ('buyer_organization.status_changed', 'organization', '00000000-0000-4000-8000-000000004305',
        'buyer_organization.status_changed:smoke', '00000000-0000-4000-8000-000000000014',
        '{"organization_id": "00000000-0000-4000-8000-000000004305", "from": "pending_verification", "to": "rejected", "reason_code": "commercial_registry"}');
INSERT INTO outbox_events (type, aggregate_type, aggregate_id, idempotency_key, actor_id, payload)
VALUES ('user.roles_changed', 'user', '00000000-0000-4000-8000-000000000013', 'user.roles_changed:smoke',
        '00000000-0000-4000-8000-000000000014', '{"user_id": "00000000-0000-4000-8000-000000000013"}');
SELECT pg_temp.expect_error($q$
  INSERT INTO outbox_events (type, aggregate_type, aggregate_id, idempotency_key, payload)
  VALUES ('user.roles_changed', 'user', '00000000-0000-4000-8000-000000000013', 'user.roles_changed:smoke:roles',
          '{"user_id": "00000000-0000-4000-8000-000000000013", "roles": ["producer"]}') $q$, '23514');
SELECT pg_temp.expect_error($q$
  INSERT INTO outbox_events (type, aggregate_type, aggregate_id, idempotency_key, payload)
  VALUES ('buyer_organization.status_changed', 'organization', '00000000-0000-4000-8000-000000004305', 'buyer_organization.status_changed:smoke:name',
          '{"organization_id": "00000000-0000-4000-8000-000000004305", "legal_name": "Sample Media Ltd"}') $q$, '23514');
SELECT pg_temp.expect_error($q$
  INSERT INTO outbox_events (type, aggregate_type, aggregate_id, idempotency_key, payload)
  VALUES ('order.status_changed', 'buyer', '00000000-0000-4000-8000-000000004305', 'order.status_changed:smoke:aggregate', '{}') $q$, '23514');
SET CONSTRAINTS ALL DEFERRED;

-- ---------- أرقام الطلب (ADR 0100؛ ترحيل 042) ----------
-- لكل طلب رقم عشوائي بصيغته وسنة إنشائه، فريد؛ وأمر الشراء كما كُتب
SELECT pg_temp.assert((SELECT bool_and(order_number ~ '^ORD-[0-9]{4}-[0-9A-HJKMNP-TV-Z]{8}$'
                         AND split_part(order_number, '-', 2) = to_char(created_at AT TIME ZONE 'UTC', 'YYYY')) FROM orders),
  'every order carries a readable number of its creation year');
SELECT pg_temp.assert((SELECT count(DISTINCT order_number) = count(*) FROM orders), 'order numbers are unique');
SELECT pg_temp.assert((SELECT purchase_order_number = 'PO 2026/17-A' FROM orders WHERE id = '00000000-0000-4000-8000-000000000c05'),
  'the purchase order number is kept as written');
-- الفاتورة للمدفوع (والمسترد) وحده، متسلسلة من 1 بلا فجوة في سنتها، والعدّاد عند آخرها
SELECT pg_temp.assert((SELECT bool_and((paid_at IS NULL) = (invoice_number IS NULL)) FROM orders), 'paid orders alone carry an invoice number');
SELECT pg_temp.assert((SELECT invoice_number IS NOT NULL FROM orders WHERE id = '00000000-0000-4000-8000-000000000c01' AND status = 'refunded'),
  'a refunded order keeps its invoice number');
SELECT pg_temp.assert(
  (SELECT array_agg(split_part(invoice_number, '-', 3)::integer ORDER BY invoice_number) FROM orders WHERE invoice_number IS NOT NULL)
  = (SELECT array_agg(i ORDER BY i) FROM invoice_counters c, generate_series(1, c.last_value) AS i),
  'invoice numbers run from 1 without gaps up to the counter');
SELECT pg_temp.assert((SELECT bool_and(invoice_number ~ '^INV-[0-9]{4}-[0-9]{6}$'
                         AND split_part(invoice_number, '-', 2) = to_char(paid_at AT TIME ZONE 'UTC', 'YYYY'))
                         FROM orders WHERE invoice_number IS NOT NULL),
  'an invoice number carries the year of its payment and six digits');
-- الأرقام لا تتغيّر، ولا يكتب رقمَ الفاتورة غيرُ المحفّز
SELECT pg_temp.expect_error($q$ UPDATE orders SET order_number = 'ORD-2026-ABCDEFGH' WHERE id = '00000000-0000-4000-8000-000000000c01' $q$, '23514');
SELECT pg_temp.expect_error($q$ UPDATE orders SET purchase_order_number = 'PO-1' WHERE id = '00000000-0000-4000-8000-000000000c02' $q$, '23514');
SELECT pg_temp.expect_error($q$ UPDATE orders SET purchase_order_number = NULL WHERE id = '00000000-0000-4000-8000-000000000c05' $q$, '23514');
SELECT pg_temp.expect_error($q$ UPDATE orders SET invoice_number = 'INV-2026-999999' WHERE id = '00000000-0000-4000-8000-000000000c01' $q$, '23514');
SELECT pg_temp.expect_error($q$ UPDATE orders SET invoice_number = 'INV-2026-999999' WHERE id = '00000000-0000-4000-8000-000000000c05' $q$, '23514');
SELECT pg_temp.expect_error($q$
  INSERT INTO orders (organization_id, created_by, currency, total_minor, expires_at, invoice_number)
  VALUES ('00000000-0000-4000-8000-000000000701', '00000000-0000-4000-8000-000000000711', 'USD', 0, now() + interval '1 hour',
          'INV-2026-999999') $q$, '23514');
-- أمر الشراء: 1–64 من الحروف اللاتينية والأرقام و« ._/#-» يبدأ وينتهي بحرف أو رقم؛ لا مسافة في الطرفين ولا محارف اتجاه أو تحكم
SELECT pg_temp.expect_error(format($q$
  INSERT INTO orders (organization_id, created_by, currency, total_minor, expires_at, purchase_order_number)
  VALUES ('00000000-0000-4000-8000-000000000701', '00000000-0000-4000-8000-000000000711', 'USD', 0, now() + interval '1 hour', %L) $q$, po), '23514')
  FROM unnest(ARRAY[' PO-1', 'PO-1 ', '', '-PO', E'PO\u200f1', E'PO\n1', 'أمر-1', '١٢٣', repeat('A', 65)]) AS po;
-- العدّاد يرتفع واحدًا ولا يُنقص ولا يُحذف
SELECT pg_temp.expect_error($q$ UPDATE invoice_counters SET last_value = last_value - 1 $q$, '23514');
SELECT pg_temp.expect_error($q$ UPDATE invoice_counters SET last_value = last_value + 2 $q$, '23514');
SELECT pg_temp.expect_error($q$ DELETE FROM invoice_counters $q$, '23001');
SET CONSTRAINTS ALL DEFERRED;

-- ---------- مفاتيح المرور والرموز الاحتياطية (ADR 0107؛ ترحيل 044) ----------
-- الرمز الاحتياطي يحمل وقت توليد مجموعته
INSERT INTO recovery_codes (user_id, code_hash) VALUES ('00000000-0000-4000-8000-000000000013', sha256('ABCDEFGHJKMN'::bytea));
SELECT pg_temp.assert((SELECT created_at IS NOT NULL FROM recovery_codes WHERE user_id = '00000000-0000-4000-8000-000000000013'),
  'a backup code records when its set was generated');
INSERT INTO passkeys (id, user_id, credential_id, public_key, sign_count, transports, multi_device, backed_up, name)
VALUES ('00000000-0000-4000-8000-000000000f01', '00000000-0000-4000-8000-000000000013', '\x0102', '\xa501', 0, '{internal,hybrid}',
        true, true, 'هاتف العمل');
-- معرّف الاعتماد فريد بين الحسابات كلها
SELECT pg_temp.expect_error($q$
  INSERT INTO passkeys (user_id, credential_id, public_key, multi_device, backed_up)
  VALUES ('00000000-0000-4000-8000-000000000014', '\x0102', '\x01', false, false) $q$, '23505');
-- الاسم بقاعدة MaterialTag، والنسخ الاحتياطي لمفتاح متزامن وحده، والعدّاد في مداه، والمعرّف والمفتاح غير فارغين، والإبطال بسبب من القائمة
SELECT pg_temp.expect_error(format($q$ UPDATE passkeys SET name = %L WHERE id = '00000000-0000-4000-8000-000000000f01' $q$, n), '23514')
  FROM unnest(ARRAY[' هاتف', 'هاتف ', '', E'\u202eهاتف', E'\u2066هاتف', E'ها\nتف', repeat('ه', 41)]) AS n;
SELECT pg_temp.expect_error($q$ UPDATE passkeys SET multi_device = false WHERE id = '00000000-0000-4000-8000-000000000f01' $q$, '23514');
SELECT pg_temp.expect_error($q$ UPDATE passkeys SET sign_count = -1 WHERE id = '00000000-0000-4000-8000-000000000f01' $q$, '23514');
SELECT pg_temp.expect_error($q$ UPDATE passkeys SET sign_count = 4294967296 WHERE id = '00000000-0000-4000-8000-000000000f01' $q$, '23514');
SELECT pg_temp.expect_error($q$ UPDATE passkeys SET credential_id = '\x' WHERE id = '00000000-0000-4000-8000-000000000f01' $q$, '23514');
SELECT pg_temp.expect_error($q$ UPDATE passkeys SET public_key = '\x' WHERE id = '00000000-0000-4000-8000-000000000f01' $q$, '23514');
SELECT pg_temp.expect_error($q$ UPDATE passkeys SET revoked_at = now() WHERE id = '00000000-0000-4000-8000-000000000f01' $q$, '23514');
SELECT pg_temp.expect_error($q$
  UPDATE passkeys SET revoked_at = now(), revoked_reason = 'lost' WHERE id = '00000000-0000-4000-8000-000000000f01' $q$, '23514');
UPDATE passkeys SET sign_count = 4294967295, last_used_at = now() WHERE id = '00000000-0000-4000-8000-000000000f01';
UPDATE passkeys SET revoked_at = now(), revoked_reason = 'owner' WHERE id = '00000000-0000-4000-8000-000000000f01';
-- التحدي ببصمته: للتسجيل مستخدمه وللدخول لا مستخدم، وعمره عشر دقائق على الأكثر
INSERT INTO webauthn_challenges (purpose, user_id, challenge_hash, expires_at) VALUES
  ('registration', '00000000-0000-4000-8000-000000000013', sha256('c1'::bytea), now() + interval '5 minutes'),
  ('authentication', NULL, sha256('c2'::bytea), now() + interval '10 minutes');
SELECT pg_temp.expect_error($q$
  INSERT INTO webauthn_challenges (purpose, user_id, challenge_hash, expires_at)
  VALUES ('authentication', '00000000-0000-4000-8000-000000000013', sha256('c3'::bytea), now() + interval '5 minutes') $q$, '23514');
SELECT pg_temp.expect_error($q$
  INSERT INTO webauthn_challenges (purpose, challenge_hash, expires_at)
  VALUES ('registration', sha256('c3'::bytea), now() + interval '5 minutes') $q$, '23514');
SELECT pg_temp.expect_error($q$
  INSERT INTO webauthn_challenges (purpose, challenge_hash, expires_at) VALUES ('signin', sha256('c3'::bytea), now() + interval '5 minutes') $q$, '23514');
SELECT pg_temp.expect_error($q$
  INSERT INTO webauthn_challenges (purpose, challenge_hash, expires_at)
  VALUES ('authentication', sha256('c3'::bytea), now() + interval '11 minutes') $q$, '23514');
SELECT pg_temp.expect_error($q$
  INSERT INTO webauthn_challenges (purpose, challenge_hash, expires_at) VALUES ('authentication', '\x01', now() + interval '5 minutes') $q$, '23514');
-- الأحداث الثلاثة بالمرجع الداخلي والعدد وحدهما: لا معرّف اعتماد ولا اسم ولا رمز
INSERT INTO outbox_events (type, aggregate_type, aggregate_id, idempotency_key, payload) VALUES
  ('auth.passkey_added', 'user', '00000000-0000-4000-8000-000000000013', 'auth.passkey_added:smoke',
   '{"passkey_id": "00000000-0000-4000-8000-000000000f01"}'),
  ('auth.passkey_revoked', 'user', '00000000-0000-4000-8000-000000000013', 'auth.passkey_revoked:smoke',
   '{"passkey_id": "00000000-0000-4000-8000-000000000f01"}'),
  ('auth.recovery_codes_generated', 'user', '00000000-0000-4000-8000-000000000013', 'auth.recovery_codes_generated:smoke',
   '{"codes_count": 10}');
SELECT pg_temp.expect_error($q$
  INSERT INTO outbox_events (type, aggregate_type, aggregate_id, idempotency_key, payload)
  VALUES ('auth.passkey_added', 'user', '00000000-0000-4000-8000-000000000013', 'auth.passkey_added:smoke:credential',
          '{"passkey_id": "00000000-0000-4000-8000-000000000f01", "credential_id": "AQI"}') $q$, '23514');
SELECT pg_temp.expect_error($q$
  INSERT INTO outbox_events (type, aggregate_type, aggregate_id, idempotency_key, payload)
  VALUES ('auth.recovery_codes_generated', 'user', '00000000-0000-4000-8000-000000000013', 'auth.recovery_codes_generated:smoke:codes',
          '{"codes_count": 1, "codes": ["ABCDEFGHJKMN"]}') $q$, '23514');
SELECT pg_temp.expect_error($q$
  INSERT INTO outbox_events (type, aggregate_type, aggregate_id, idempotency_key, payload)
  VALUES ('auth.recovery_approved', 'user', '00000000-0000-4000-8000-000000000013', 'auth.recovery_approved:smoke:token',
          '{"recovery_request_id": "00000000-0000-4000-8000-000000000901", "reset_token": "t"}') $q$, '23514');
INSERT INTO audit_log (actor_id, action, target_type, target_id, details, hash)
VALUES ('00000000-0000-4000-8000-000000000013', 'auth.passkey_added', 'user', '00000000-0000-4000-8000-000000000013',
        '{"target_user_id": "00000000-0000-4000-8000-000000000013", "passkey_id": "00000000-0000-4000-8000-000000000f01"}', '\x00'),
       ('00000000-0000-4000-8000-000000000021', 'auth.reset_link_issued', 'user', '00000000-0000-4000-8000-000000000013',
        '{"recovery_request_id": "00000000-0000-4000-8000-000000000901", "reason_code": "forgot_password", "passkeys_revoked": "1"}', '\x00'),
       ('00000000-0000-4000-8000-000000000013', 'auth.recovery_codes_generated', 'user', '00000000-0000-4000-8000-000000000013',
        '{"target_user_id": "00000000-0000-4000-8000-000000000013", "codes_count": "10"}', '\x00');
SET CONSTRAINTS ALL DEFERRED;
-- الدوال تعمل بمسار بحث فارغ (الاستعادة)
SET LOCAL search_path = '';
SELECT pg_temp.assert(public.order_number_new(now()) ~ '^ORD-[0-9]{4}-[0-9A-HJKMNP-TV-Z]{8}$', 'order numbers work with an empty search_path');
-- الدفع يعطي رقم الفاتورة التالي من المحفّز بمسار بحث فارغ
UPDATE public.orders SET provider = 'sandbox', provider_ref = 'sbx_c05', status = 'paid', paid_at = now()
 WHERE id = '00000000-0000-4000-8000-000000000c05';
SELECT pg_temp.assert((SELECT o.invoice_number = 'INV-' || c.invoice_year || '-' || lpad(c.last_value::text, 6, '0')
                         FROM public.orders o, public.invoice_counters c
                        WHERE o.id = '00000000-0000-4000-8000-000000000c05' AND c.invoice_year = extract(year FROM o.paid_at AT TIME ZONE 'UTC')),
  'payment takes the next invoice number with an empty search_path');
SELECT pg_temp.expect_error($q$ UPDATE public.invoice_counters SET last_value = 1 $q$, '23514');
SELECT pg_temp.assert(public.tag_list_valid(ARRAY['نزوح'], 50) AND NOT public.tag_list_valid(ARRAY['نزوح', 'نزوح'], 50)
  AND NOT public.tag_list_valid(ARRAY[E'\u2066نزوح'], 50), 'tag list check works with an empty search_path');
SELECT pg_temp.expect_error($q$ UPDATE public.tag_suggestions SET tags = ARRAY[' نزوح'] $q$, '23514');
SET CONSTRAINTS ALL DEFERRED;
SELECT pg_temp.expect_error($q$
  INSERT INTO public.payout_approvals (payout_request_id, approver_id)
  VALUES ('00000000-0000-4000-8000-0000000009c2', '00000000-0000-4000-8000-000000000014') $q$, '23514');
SELECT pg_temp.assert(public.payout_entry_matches('00000000-0000-4000-8000-0000000009b1', '00000000-0000-4000-8000-0000000009c1'),
  'payout entry check works with an empty search_path');
SELECT pg_temp.assert(public.render_title_lines_valid(ARRAY['عنوان تجريبي']) AND NOT public.render_title_lines_valid(ARRAY[E'\u202eعنوان']),
  'render title check works with an empty search_path');
SELECT pg_temp.expect_error($q$
  UPDATE public.material_renders SET title_lines = ARRAY[' عنوان'] WHERE id = '00000000-0000-4000-8000-000000000d01' $q$, '23514');
SET CONSTRAINTS ALL DEFERRED;
SELECT pg_temp.expect_error($q$
  UPDATE public.material_assignments SET note = E'\u2067ملاحظة' WHERE id = '00000000-0000-4000-8000-000000000e02' $q$, '23514');
SET CONSTRAINTS ALL DEFERRED;
-- اسم مفتاح المرور يُفحص بمسار بحث فارغ (passkeys_name_valid يستدعي public.render_text_valid)
SELECT pg_temp.expect_error($q$
  UPDATE public.passkeys SET name = E'\u202eهاتف' WHERE id = '00000000-0000-4000-8000-000000000f01' $q$, '23514');
SET CONSTRAINTS ALL DEFERRED;
SET LOCAL search_path TO DEFAULT;

\o
\echo smoke OK
ROLLBACK;
