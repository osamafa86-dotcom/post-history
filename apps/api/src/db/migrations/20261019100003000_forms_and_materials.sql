-- Up Migration
-- النماذج الديناميكية بإصدارات غير قابلة للتعديل، والمواد بحالاتها الثلاث المستقلة، والمساهمون وحصصهم، وسجل الانتقالات.
-- الفهرسة (ADR 0002): الحقول عالية التردد أعمدة صريحة بفهارس B-Tree مركبة؛ الحقول الديناميكية JSONB بلا فهرس GIN شامل.

-- كل إصدار لقطة كاملة بمخطط contracts/schemas/upload-form.json. الحذف أرشفة: الإصدار يبقى لقراءة المواد القديمة.
CREATE TABLE upload_forms (
  version        integer PRIMARY KEY,
  material_types text[] NOT NULL DEFAULT '{}',
  schema         jsonb NOT NULL,
  published_at   timestamptz NOT NULL DEFAULT now(),
  published_by   uuid REFERENCES users (id),
  CONSTRAINT upload_forms_version_positive CHECK (version >= 1),
  CONSTRAINT upload_forms_schema_is_object CHECK (jsonb_typeof(schema) = 'object'),
  CONSTRAINT upload_forms_schema_version_matches CHECK (schema ? 'version' AND (schema ->> 'version')::integer = version),
  CONSTRAINT upload_forms_schema_has_fields CHECK (schema ? 'fields' AND jsonb_typeof(schema -> 'fields') = 'array'),
  CONSTRAINT upload_forms_material_types_known CHECK (material_types <@ allowed_material_types()),
  -- بوابة v0 (مراجعة الأمن على الطلب 4): لا حقول حساسة ولا حقول موقع حتى SEC-03/SEC-04؛ يُحذف بترحيل مع رفع البوابة
  CONSTRAINT upload_forms_no_sensitive_fields_v0 CHECK (
    NOT jsonb_path_exists(schema, '$.fields[*] ? (@.sensitive == true || @.type == "location")'))
);

CREATE TABLE materials (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_id            uuid NOT NULL REFERENCES users (id),
  office_id              uuid REFERENCES offices (id),      -- مكتب المراسل عند الإنشاء = نطاق المادة
  title                  text NOT NULL,
  material_types         text[] NOT NULL,
  governorate            text NOT NULL,
  city                   text NOT NULL,
  shot_at                timestamptz,
  priority               text NOT NULL,
  sensitivity_minors     boolean NOT NULL,
  sensitivity_injured    boolean NOT NULL,
  sensitivity_graphic    boolean NOT NULL,
  display_name_mode      text NOT NULL,
  display_name_pseudonym text,
  gps_enc                bytea,                             -- إحداثيات مشفرة على مستوى الحقل؛ لا تخرج من الخادم إلا لأدوار محددة
  form_version           integer NOT NULL REFERENCES upload_forms (version),
  dynamic_fields         jsonb NOT NULL DEFAULT '{}'::jsonb, -- تُفسَّر فقط مع form_version؛ لا فهرس GIN هنا
  technical_state        text NOT NULL DEFAULT 'pending',
  editorial_state        text NOT NULL DEFAULT 'inbox',
  rights_state           text NOT NULL DEFAULT 'unknown',
  version                integer NOT NULL DEFAULT 1,
  reserved_by            uuid REFERENCES users (id),
  reserved_at            timestamptz,
  original_height        integer,                           -- الدقة؛ يملؤها عامل الوسائط من الأصل
  original_duration_ms   bigint,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT materials_title_len CHECK (char_length(title) BETWEEN 1 AND 200),
  CONSTRAINT materials_types_nonempty CHECK (cardinality(material_types) >= 1),
  CONSTRAINT materials_types_known CHECK (material_types <@ allowed_material_types()),
  CONSTRAINT materials_priority_check CHECK (priority IN ('urgent', 'important', 'normal')),
  CONSTRAINT materials_display_name_mode_check CHECK (display_name_mode IN ('real_name', 'pseudonym', 'network')),
  CONSTRAINT materials_pseudonym_consistent CHECK ((display_name_mode = 'pseudonym') = (display_name_pseudonym IS NOT NULL)),
  CONSTRAINT materials_dynamic_fields_is_object CHECK (jsonb_typeof(dynamic_fields) = 'object'),
  CONSTRAINT materials_technical_state_check CHECK (technical_state IN ('pending', 'proxy_received', 'original_received', 'verified', 'failed')),
  CONSTRAINT materials_editorial_state_check CHECK (editorial_state IN (
    'inbox', 'acknowledged', 'reviewing', 'needs_changes', 'accepted', 'in_production', 'final_review', 'published', 'rejected')),
  CONSTRAINT materials_rights_state_check CHECK (rights_state IN ('unknown', 'documented', 'sellable', 'blocked', 'withdrawn')),
  CONSTRAINT materials_version_positive CHECK (version >= 1),
  CONSTRAINT materials_reservation_consistent CHECK ((reserved_by IS NULL) = (reserved_at IS NULL)),
  CONSTRAINT materials_original_height_positive CHECK (original_height IS NULL OR original_height > 0),
  CONSTRAINT materials_original_duration_nonneg CHECK (original_duration_ms IS NULL OR original_duration_ms >= 0)
);
CREATE TRIGGER materials_set_updated_at BEFORE UPDATE ON materials
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- لوحة غرفة الأخبار ضمن النطاق: أعمدة وارد/قيد المراجعة/... مرتبة بالأولوية ثم الأحدث
CREATE INDEX materials_board_idx ON materials (office_id, editorial_state, priority, created_at DESC);
-- مواد المراسل (لوحة المستخدم)
CREATE INDEX materials_reporter_idx ON materials (reporter_id, created_at DESC);
-- البحث بالمحافظة وتاريخ التصوير
CREATE INDEX materials_governorate_shot_idx ON materials (governorate, shot_at DESC);
-- «الوارد الآن»: الرفع الجاري فقط (فهرس جزئي صغير يتغير كثيرًا)
CREATE INDEX materials_technical_inflight_idx ON materials (technical_state, updated_at)
  WHERE technical_state IN ('pending', 'proxy_received', 'original_received');
-- الحقوق مع الحالة التحريرية (أساس الكتالوج لاحقًا)
CREATE INDEX materials_rights_idx ON materials (rights_state, editorial_state, updated_at DESC);
-- الحجوزات القائمة فقط (تحرير الخمول)
CREATE INDEX materials_reserved_idx ON materials (reserved_by, reserved_at) WHERE reserved_by IS NOT NULL;
-- ترقيم الصفحات بالمؤشر (created_at, id)
CREATE INDEX materials_cursor_idx ON materials (created_at DESC, id DESC);
-- الحقل الديناميكي الموسوم «مرشّح بحث» يُرقَّى بترحيل لاحق إلى فهرس تعبيري، مثلًا:
--   CREATE INDEX materials_df_footage_source_idx ON materials ((dynamic_fields ->> 'footage_source'));
-- قفل الحصرية (ملحق القرارات 19) فهرس فريد جزئي يُفعَّل في المرحلة التجارية مع جدول التراخيص:
--   CREATE UNIQUE INDEX licenses_exclusive_active_key ON licenses (material_id) WHERE kind = 'exclusive' AND state = 'active';

-- مجموع حصص المساهمين في المادة الواحدة = 100.00 قيدًا مؤجلًا إلى نهاية المعاملة (يسمح بالاستبدال الكامل داخل معاملة).
CREATE TABLE material_contributors (
  material_id   uuid NOT NULL REFERENCES materials (id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES users (id),
  role          text NOT NULL,
  share_percent numeric(5, 2) NOT NULL,
  PRIMARY KEY (material_id, user_id),
  CONSTRAINT material_contributors_role_check CHECK (role IN ('photographer', 'reporter', 'editor', 'fixer')),
  CONSTRAINT material_contributors_share_range CHECK (share_percent >= 0 AND share_percent <= 100)
);

CREATE FUNCTION material_contributors_check_sum() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  target uuid := COALESCE(NEW.material_id, OLD.material_id);
  total  numeric(7, 2);
BEGIN
  SELECT sum(share_percent) INTO total FROM material_contributors WHERE material_id = target;
  IF total IS NOT NULL AND total <> 100.00 THEN
    RAISE EXCEPTION 'contributor shares for material % sum to % (must be 100.00)', target, total
      USING ERRCODE = 'check_violation', CONSTRAINT = 'material_contributors_sum_100';
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER material_contributors_sum_100
  AFTER INSERT OR UPDATE OR DELETE ON material_contributors
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION material_contributors_check_sum();

-- سجل الانتقالات في المسارات الثلاثة: من نفّذ ومتى ولماذا. إلحاقي (لا تحديث ولا حذف من التطبيق).
CREATE TABLE material_transitions (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  material_id      uuid NOT NULL REFERENCES materials (id) ON DELETE CASCADE,
  track            text NOT NULL,
  from_state       text NOT NULL,
  to_state         text NOT NULL,
  reason           text NOT NULL,
  note_timecode_ms integer,
  actor_id         uuid REFERENCES users (id),   -- NULL للانتقالات التي يكتبها الخادم (hooks الرفع)
  occurred_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT material_transitions_track_check CHECK (track IN ('technical', 'editorial', 'rights')),
  CONSTRAINT material_transitions_reason_nonempty CHECK (char_length(reason) BETWEEN 1 AND 2000),
  CONSTRAINT material_transitions_timecode_nonneg CHECK (note_timecode_ms IS NULL OR note_timecode_ms >= 0),
  CONSTRAINT material_transitions_changes_state CHECK (from_state <> to_state)
);
CREATE INDEX material_transitions_material_idx ON material_transitions (material_id, id);

-- Down Migration
DROP TABLE material_transitions;
DROP TRIGGER material_contributors_sum_100 ON material_contributors;
DROP FUNCTION material_contributors_check_sum();
DROP TABLE material_contributors;
DROP TABLE materials;
DROP TABLE upload_forms;
