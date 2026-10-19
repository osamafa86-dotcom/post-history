# 0006 — واجهة عامل الوسائط مع الخادم: نقاط `/internal/media/*` بمصادقة رمز حامل، وطابور Redis Streams

- الحالة: مقبول (المنسّق، 2026-10-19)؛ الجانب المقابل عند وكيلي الخادم والبنية
- التاريخ: 2026-10-19
- المسؤول: وكيل الوسائط
- بند ملحق القرارات: 3 (مسار الرفع)، وخط الوسائط الأولي

## السياق

- الخادم يتحقق اليوم داخله (`UPLOAD_VERIFIER=in_process`): يقفل كل جلسة `completed` ويحسب SHA-256 ثم يستدعي `recordVerification` التي تكتب ملف المادة ورقم الإيصال والمسار الفني وحدث Outbox في معاملة واحدة. عامل الوسائط يحل محله.
- لا طابور أحداث بعد: ناشر Outbox يوزّع على صندوق الوارد فقط. الأحداث المتاحة للعامل: `upload.original_received` و`upload.proxy_received` (الجلسة `completed`) و`upload.verified`.
- العامل يحتاج الملف محليًا على أي حال (ffprobe والنسخة الخفيفة يقرآن عشوائيًا)، فالتنزيل نفسه يحسب البصمة في قراءة واحدة.
- العقد مجمّد: `MaterialFile` لا يحمل الترميز ولا معدل الإطارات ولا علامة المعدل المتغير، ولا يوجد عمود لبصمة الخادم الرخيصة.

## الخيارات

1. **نقاط داخلية `/internal/media/*` على الخادم** يستدعيها العامل بترويسة `Authorization: Bearer <MEDIA_WORKER_TOKEN>`، مقصورة على عنوان العامل بـ `INTERNAL_ALLOWED_CIDRS`. الخادم يبقى الكاتب الوحيد ويستدعي `recordVerification` كما هي.
2. **كتابة مباشرة بدور قاعدة بيانات محدود**: أسرع تنفيذًا، لكنه يكرر في Python منطق `recordVerification` (الإيصال، الانتقالات، Outbox) فيصير للثابت الواحد تنفيذان، ويربط العامل بترحيلات Drizzle، ويحتاج صلاحيات على أربعة جداول بدل ثلاث عمليات.
3. **العامل يحسب فقط ويعيد النتيجة عبر الطابور** والخادم يستهلكها: طابور في الاتجاهين وحالة تتبع أكثر دون مكسب على (1).

## القرار

الخيار 1. الخادم يبقى مالك الحالة والكاتب الوحيد؛ العامل لا يلمس القاعدة ولا يقرر شيئًا تحريريًا.

### الطابور (جانب الخادم)

ناشر Outbox يضيف، داخل النشر نفسه، الأحداث `upload.original_received` و`upload.proxy_received` إلى Redis Stream `media:events` (`XADD … MAXLEN ~ 100000`) بحقلين: `event_id` و`event` (JSON الحدث كما في `outbox-event.json`؛ الحمولة قائمة بيضاء لا كاشف فيها). العامل يقرأ بمجموعة مستهلكين `media`، ويؤكد بـ `XACK` بعد نجاح الخطوات، ويستعيد المعلّق بـ `XAUTOCLAIM` بعد مهلة. التسليم «مرة على الأقل»، والنقاط أدناه متساوية الأثر عند التكرار.

### النقاط (`x-internal`، خارج `/v1`، لا يُولَّد لها عميل)

1. `GET /internal/media/sessions/{upload_session_id}` ← `{ material_id, kind, state, size_bytes, storage_key, proxy_mode, material_has_proxy }`. لا يعيد بصمة العميل (المقارنة في الخادم).
2. `POST /internal/media/sessions/{upload_session_id}/verification` بجسم
   `{ result: "verified" | "invalid_file" | "storage_error", sha256, size_bytes, head_sha256, tail_sha256, technical }`
   الخادم يقفل الجلسة؛ إن لم تكن `completed` يعيد `200` بالنتيجة المسجلة إن طابقت و`409` إن خالفت. يتحقق أن `size_bytes` يساوي حجم الجلسة وحجم الكائن في التخزين (`HEAD`)، ويقارن `client_sha256` بنفسه فيقرر `checksum_mismatch`، ثم يستدعي `recordVerification`، ويكتب `technical` (أدناه) على الملف الجديد. يعيد `{ file_id, receipt_number }`.
3. `POST /internal/media/files/{file_id}/derivatives` بجسم `{ kind: "proxy", storage_key, sha256, size_bytes, technical }` ← ملف جديد `kind=proxy` و`proxy_mode=normal` و`derived_from_id=file_id` و`state=verified`. متساوٍ الأثر على (`derived_from_id`، `kind`). `storage_key` يجب أن يبدأ بالبادئة المشتقة لهذه المادة.

`technical`: `duration_ms`، `start_pts_us`، `width`، `height` (أعمدة موجودة)، والباقي (`container`، `video_codec`، `audio_codec`، `frame_rate`، `avg_frame_rate`، `vfr`، `frame_count`، `max_frame_gap_ms`، `has_gaps`، `rotation`، `hdr`، `bit_depth`، `audio_sample_rate`، `audio_channels`) في عمود جديد. قائمة بيضاء مغلقة: العامل لا ينقل وسوم الملف أبدًا (فيها الإحداثيات وطراز الجهاز)، والخادم يرفض أي مفتاح آخر.

### تدفق العامل

عند `upload.*_received`: (1) `GET` الجلسة؛ إن لم تكن `completed` يؤكد الحدث ويتوقف. (2) ينزّل الكائن إلى قرص مؤقت ويحسب SHA-256 والبصمة الرخيصة في القراءة نفسها. (3) ffprobe؛ الفشل = `invalid_file`. (4) `POST verification`. (5) إن كان أصلًا مرئيًا و`material_has_proxy=false`: نسخة 480p بـ `-copyts` (تحفظ `start_pts` وطابع كل إطار) تُرفع إلى `derived/<material_id>/<file_id>/proxy-480p.mp4` ثم `POST derivatives`. (6) `XACK` وحذف الملفات المؤقتة. الأصل يُقرأ فقط.

### المصادقة والأسرار

- `MEDIA_WORKER_TOKEN` (≥ 32 حرفًا، `[A-Za-z0-9_-]`) منفصل عن `TUSD_HOOK_SECRET` حتى لا يمتد تسريب أحدهما إلى الآخر؛ يُدار كبقية الأسرار (SEC-05) ولا يوضع في `.env.example`.
- ترويسة لا مقطع مسار: العامل كودنا ويستطيع إرسال الترويسات، فلا يتكرر تسريب الرمز في سجلات tusd وأخطائه (SEC-06). المقارنة ثابتة الزمن، والترويسة لا تُسجَّل، والرد عند الفشل `404` كبقية `/internal/*`.
- `internalOnly` مقصور على عنوان العامل الثابت على شبكة compose داخلية (`media`) مشتركة بين الخادم والعامل وMinIO وRedis فقط.
- مستخدم تخزين خاص بالعامل: قراءة على بادئة الرفع، وكتابة على `derived/` فقط، بلا حذف.

## ما يلزم من غيري

- **وكيل الخادم:** النقاط الثلاث، والنشر إلى `media:events`، وضبط `UPLOAD_VERIFIER=external` في compose مع profile `media`. ما دام العامل متوقفًا تبقى الجلسات `completed`، والرجوع إلى `in_process` يستأنفها.
- **وكيل العقود (PR مستقل، ترحيل):** `material_files.technical jsonb` (غير مكشوف في `/v1` حتى فك التجميد)، و`material_files.head_sha256`/`tail_sha256 bytea` مع فهرس على (`size_bytes`، `head_sha256`) لترشيح المكررات مسبقًا عند إنشاء الجلسة، وفهرس فريد جزئي على (`derived_from_id`، `kind`). وتثبيت معنى «ميغابايت» في `client_fingerprint` بـ 1 MiB = 1,048,576 بايت (ما يحسبه العامل الآن)، وأن الملف الأصغر رأسه وذيله الملف كله.
- **وكيل الرفع والبنية:** شبكة `media` الداخلية بعنوان ثابت للعامل، ومستخدم MinIO بالصلاحيات أعلاه.

## الدليل

- `workers/media/tests/` (وظيفة `media` في CI): النسخة الخفيفة لملف متغير المعدل بفجوة وبداية 10 ث تحفظ طابع كل إطار (فرق < 1 ms) و`start_pts`؛ الوسوم الكاشفة لا تظهر في البيانات الفنية ولا في النسخة؛ البصمة الرخيصة تطابق تعريف العقد لكل أحجام الأجزاء.
- `docs/measurements/media/2026-10-19-ingest-2min-1080p.json`: دقيقتان 1080p (~16 Mbps) في 13.5 ث على 4 أنوية افتراضية (البصمة 0.28 ث من ذاكرة الصفحات، النسخة 12.8 ث).

## التبعات

- أسهل: ثابت التحقق في مكان واحد؛ العامل بلا صلاحيات قاعدة بيانات؛ استبدال العامل أو تكثيره لا يمس الخادم.
- أصعب: ثلاث نقاط وطابور على الخادم قبل أن يعمل العامل طرفًا لطرف؛ الملف يُنزَّل كاملًا إلى قرص العامل (يُقاس مع ملفات 4K الطويلة).
- يُراجع: عند فك تجميد العقد يُعرض `technical` في `MaterialFile`؛ وmTLS بدل الرمز حين تُدار الأسرار في خزنة.
