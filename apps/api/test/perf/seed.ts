import type { Pool } from 'pg';

/**
 * حجم سنة من الخطة («تقدير التخزين»، سيناريو 60 مراسلًا): 3.5 غيغابايت للمراسل يوميًا على 22–30 يوم رفع شهريًا (26
 * متوسطًا). بمعدل 5 مواد للمراسل في يوم الرفع (نحو 700 ميغابايت للمادة، مقطع 1080p بطول 6 دقائق بمعدل 15 ميغابت/ث،
 * تقدير يُستبدل بعينة الثلاثين ملفًا) تكون المواد 60 × 26 × 12 × 5 = 93,600 مادة. لكل مادة أصل ومشتقاته الأربعة
 * (النسخة الخفيفة وHLS والصوت والملصق)، ونحو ستة إشعارات (وارد للمشرف، إيصال واطلاع للمراسل، قبول للمنتجين…)
 * ونحو عشرة أحداث Outbox منشورة. scale يصغّر الكل خطيًا (CI: 0.05).
 */
export function yearVolumes(scale: number) {
  const materials = Math.max(1000, Math.round(93_600 * scale));
  return {
    offices: 12,
    reporters: 60,
    supervisors: 12, // مشرف لكل مكتب
    producers: 10,
    materials,
    derivativesPerMaterial: 4,
    notificationsPerMaterial: 6,
    outboxPerMaterial: 10,
  };
}

export type Volumes = ReturnType<typeof yearVolumes>;

const GOVERNORATES = ['gaza', 'north_gaza', 'deir_al_balah', 'khan_younis', 'rafah', 'jerusalem', 'ramallah', 'nablus', 'hebron', 'jenin', 'bethlehem', 'tulkarm'];

/**
 * بذرة اصطناعية بلا أي بيانات كاشفة: عناوين ثابتة «perf»، ومدن ومحافظات بأسماء المحافظات وحدها، ولا إحداثيات ولا
 * أسماء ولا معرّفات أجهزة. تُكتب بـ generate_series داخل القاعدة (لا ذهاب وإياب لكل صف). حسابات المستخدمين المبذورة
 * بكلمة مرور غير صالحة فلا يُدخل بها؛ من يقيس يُنشئ حساباته بنفسه.
 */
export async function seedYear(pool: Pool, v: Volumes, formVersion: number): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO offices (name_ar, name_en, governorate)
       SELECT 'مكتب ' || g, 'office ' || g, ($1::text[])[g] FROM generate_series(1, $2) g`,
      [GOVERNORATES, v.offices],
    );
    // المراسلون موزعون على المكاتب، ومعهم مشرف لكل مكتب ومنتجون بنطاق كامل
    await client.query(
      `WITH o AS (SELECT id, row_number() OVER (ORDER BY created_at, id) AS n FROM offices WHERE name_en LIKE 'office %')
       INSERT INTO users (email, password_hash, office_id)
       SELECT 'perf-reporter-' || g || '@perf.test', '!', (SELECT id FROM o WHERE n = 1 + (g % $2)) FROM generate_series(1, $1) g`,
      [v.reporters, v.offices],
    );
    await client.query(`INSERT INTO user_roles (user_id, role) SELECT id, 'reporter' FROM users WHERE email LIKE 'perf-reporter-%'`);
    await client.query(
      `WITH o AS (SELECT id, row_number() OVER (ORDER BY created_at, id) AS n FROM offices WHERE name_en LIKE 'office %'),
            u AS (INSERT INTO users (email, password_hash)
                  SELECT 'perf-supervisor-' || g || '@perf.test', '!' FROM generate_series(1, $1) g RETURNING id, email)
       INSERT INTO user_roles (user_id, role, scope_kind, scope_id)
       SELECT u.id, 'supervisor', 'office', (SELECT id::text FROM o WHERE n = split_part(split_part(u.email, '-', 3), '@', 1)::int) FROM u`,
      [v.supervisors],
    );
    await client.query(
      `WITH u AS (INSERT INTO users (email, password_hash) SELECT 'perf-producer-' || g || '@perf.test', '!' FROM generate_series(1, $1) g RETURNING id)
       INSERT INTO user_roles (user_id, role) SELECT id, 'producer' FROM u`,
      [v.producers],
    );

    // المواد على سنة إلى الوراء بتوزيع الحالات في غرفة أخبار مستقرة: معظمها منشور أو مرفوض، والقليل في الوارد
    await client.query(
      `WITH r AS (SELECT u.id, u.office_id, o.governorate, row_number() OVER (ORDER BY u.email) AS n
                    FROM users u JOIN offices o ON o.id = u.office_id WHERE u.email LIKE 'perf-reporter-%')
       INSERT INTO materials (reporter_id, office_id, title, material_types, governorate, city, priority, sensitivity_minors,
                              sensitivity_injured, sensitivity_graphic, display_name_mode, form_version, dynamic_fields,
                              technical_state, editorial_state, rights_state, shot_at, created_at, updated_at)
       SELECT r.id, r.office_id, 'perf', ARRAY['report'], r.governorate, r.governorate,
              CASE WHEN g % 20 = 0 THEN 'urgent' WHEN g % 5 = 0 THEN 'important' ELSE 'normal' END,
              false, false, false, 'network', $3,
              jsonb_build_object('footage_source', CASE WHEN g % 33 = 0 THEN 'handout' ELSE 'own' END, 'casualties_count', g % 7),
              CASE WHEN g % 50 = 0 THEN 'original_received' WHEN g % 97 = 0 THEN 'failed' ELSE 'verified' END,
              (ARRAY['published','published','published','published','rejected','accepted','in_production','final_review',
                     'reviewing','acknowledged','needs_changes','inbox'])[1 + (g % 12)],
              (ARRAY['unknown','documented','sellable','sellable','blocked'])[1 + (g % 5)],
              CASE WHEN g % 9 = 0 THEN NULL ELSE now() - make_interval(secs => (g::float8 / $1) * 31536000 + 3600) END,
              now() - make_interval(secs => (g::float8 / $1) * 31536000),
              now() - make_interval(secs => (g::float8 / $1) * 31536000 * 0.9)
         FROM generate_series(1, $1) g JOIN r ON r.n = 1 + (g % $2)`,
      [v.materials, v.reporters, formVersion],
    );

    // الأصل متحقق بإيصال، ومشتقاته الأربعة
    await client.query(
      `INSERT INTO material_files (material_id, kind, state, storage_key, size_bytes, sha256, head_sha256, tail_sha256, mime_type,
                                   duration_ms, start_pts_us, receipt_number, verified_at, created_at)
       SELECT m.id, 'original', 'verified', 'tus/' || m.id, 700000000 + (row_number() OVER ()) , sha256(m.id::text::bytea),
              sha256(('h' || m.id)::bytea), sha256(('t' || m.id)::bytea), 'video/mp4', 360000, 0,
              'R-' || to_char(m.created_at, 'YYYYMM') || '-' || lpad((row_number() OVER (PARTITION BY to_char(m.created_at, 'YYYYMM') ORDER BY m.id))::text, 6, '0'),
              m.created_at + interval '5 minutes', m.created_at
         FROM materials m WHERE m.title = 'perf' AND m.technical_state = 'verified'`,
    );
    await client.query(
      `INSERT INTO material_files (material_id, kind, state, derived_from_id, storage_key, size_bytes, sha256, mime_type, duration_ms,
                                   start_pts_us, width, height, proxy_mode, verified_at, created_at)
       SELECT f.material_id, k.kind, 'verified', f.id, 'derived/' || f.material_id || '/' || f.id || '/' || k.kind, 1000000,
              sha256((k.kind || f.id)::bytea), k.mime, 360000, 0,
              CASE WHEN k.kind IN ('proxy', 'thumbnail') THEN 854 END, CASE WHEN k.kind IN ('proxy', 'thumbnail') THEN 480 END,
              CASE WHEN k.kind = 'proxy' THEN 'normal' END, f.verified_at + interval '2 minutes', f.created_at
         FROM material_files f
         CROSS JOIN (VALUES ('proxy', 'video/mp4'), ('hls', 'application/vnd.apple.mpegurl'), ('audio', 'audio/mp4'),
                            ('thumbnail', 'image/jpeg')) AS k(kind, mime)
        WHERE f.kind = 'original' AND f.storage_key LIKE 'tus/%'
        LIMIT $1`,
      [v.materials * v.derivativesPerMaterial],
    );

    // أحداث Outbox منشورة (الحمولة القائمة البيضاء للمادة)، ثم إشعارات المستلمين معلَّقة على أولها
    await client.query(
      `INSERT INTO outbox_events (type, aggregate_type, aggregate_id, idempotency_key, payload, published_at, occurred_at)
       SELECT CASE WHEN k = 1 THEN 'material.created' ELSE 'material.editorial_transition' END, 'material', m.id,
              'perf:' || m.id || ':' || k,
              CASE WHEN k = 1 THEN jsonb_build_object('material_id', m.id, 'priority', m.priority)
                   ELSE jsonb_build_object('material_id', m.id, 'priority', m.priority, 'track', 'editorial', 'from', 'inbox', 'to', 'acknowledged') END,
              m.created_at + make_interval(secs => k), m.created_at + make_interval(secs => k)
         FROM materials m CROSS JOIN generate_series(1, $1) k WHERE m.title = 'perf'`,
      [v.outboxPerMaterial],
    );
    // إشعار لكل واحد من أول ستة أحداث المادة: الأول للمشرف (مهمة)، والباقي لمراسلها
    await client.query(
      `INSERT INTO notifications (user_id, event_id, type, material_id, title, priority, state, assignment_state, created_at,
                                  read_at, acknowledged_at)
       SELECT CASE WHEN k = 1 THEN sup.user_id ELSE m.reporter_id END, e.id, e.type, m.id, 'مادة واردة #' || left(m.id::text, 8),
              m.priority, CASE WHEN m.editorial_state = 'inbox' THEN 'sent' ELSE 'acknowledged' END,
              CASE WHEN k = 1 THEN CASE WHEN m.editorial_state = 'inbox' THEN 'assigned' ELSE 'acknowledged' END END,
              e.occurred_at, CASE WHEN m.editorial_state <> 'inbox' THEN e.occurred_at + interval '3 minutes' END,
              CASE WHEN m.editorial_state <> 'inbox' THEN e.occurred_at + interval '3 minutes' END
         FROM outbox_events e
         CROSS JOIN LATERAL (SELECT split_part(e.idempotency_key, ':', 3)::int AS k) kk
         JOIN materials m ON m.id = e.aggregate_id
         JOIN user_roles sup ON sup.role = 'supervisor' AND sup.scope_kind = 'office' AND sup.scope_id = m.office_id::text
        WHERE e.idempotency_key LIKE 'perf:%' AND kk.k <= $1`,
      [v.notificationsPerMaterial],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  await pool.query('ANALYZE');
}
