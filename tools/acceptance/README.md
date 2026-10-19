# acceptance

سكربت واحد لكل صف في جدول «اختبارات القبول» في `docs/plan/الخطة-النسخة-الثالثة.md`. يملكه وكيل الجودة والقبول.

## الاتفاق

- اسم السكربت = اسم الاختبار في الخطة بالإنجليزية (`upload-resume`, `field-network-upload`, `force-quit-restart`, `concurrent-load`, `invalid-file`, `proxy-accuracy`, `receipt-notification`, `dynamic-fields`, `tenant-isolation`, `pii-leak`, `cut-export`, `duplicate-payment`, `refund`, `rights-exclusivity`, `payout`, `recovery`, `availability`, `ai-eval`, `performance`, `urgent-template-export`, `task-killers`, `timestamp-alignment`).
- كل سكربت يطبع المعيار الذي يختبره، ويكتب نتيجته بمخطط `contracts/schemas/measurement.json` في `docs/measurements/acceptance/`.
- ما يحتاج جهازًا فعليًا يُكتب سكربتًا خطوة بخطوة يجريه المشرف الميداني ويسجّل النتيجة بالمخطط نفسه.
- `form-conformance/`: اختبار المطابقة المشترك لراسم النماذج على الويب وiOS وأندرويد من مخطط واحد.

## التشغيل

```bash
cd tools/acceptance && npm ci
node run.mjs --list                          # الأسماء والمعايير وأيها آلي أو ميداني أو ينتظر حزمته
node run.mjs pii-leak tenant-isolation       # يكتب docs/measurements/acceptance/<التاريخ>-<الاسم>-<وصف>.json
node run.mjs all --dry-run                   # كل الأسماء دون كتابة نتائج؛ المنتظر منها «pending» لا فشل
npm test                                     # اختبارات السكربتات نفسها على خوادم وهمية
node validate-results.mjs                    # بوابة CI على كل ملف نتيجة في docs/measurements/
```

الخروج: `0` سليم أو منتظر، `1` فشل معيار، `2` البيئة غير متاحة فلم يُقَس شيء (لا ملف نتيجة).

## الحالة

| الاسم | الحالة |
| --- | --- |
| `pii-leak` | حقيقي. حي ضد الخادم (الاستجابات والإشعارات والأحداث وسجلات الخادم بكناري إحداثيات وعناوين). `shot_at` كاشف خارج غرفة الأخبار فقط (قرار المالك)؛ المشتقات والتصدير والقنوات الخارجية لم تُغطَّ بعد فالنتيجة `partial`. ساكن (أمثلة العقد وحمولات Outbox ومخططات الاستجابة وأمثلتها + ضوابط إيجابية تثبت أن الكاشف يرى ما يرفضه العقد)، وحي بـ `PII_BASE_URL` وكناري. ملفات `waivers/*.json` تسجّل ما هو حقيقي ورُفع لمالكه؛ الاستثناء يسقط النتيجة إلى `partial` ويصير فشلًا إن زال سببه. |
| `tenant-isolation` | هيكل الحالات (مصفوفة الأدوار × العمليات، النطاق = 404، حجب `x-permissions`، تسريب القوائم) يُبنى من `x-roles` و`x-permissions`، وينفَّذ بـ `TENANT_BASE_URL`. v0 بلا مؤسسات فالجزء المؤسسي يُضاف مع المرحلة التجارية. |
| `upload-resume` | حقيقي ضد tusd: قطع الاتصال أثناء PATCH، HEAD، استئناف من آخر ما وصل على مجمّع اتصالات جديد، وتطابق SHA-256. البصمة من S3/MinIO مباشرة (`UPLOAD_S3_*`) لأن compose يعطّل التنزيل، وإلا من GET. حجم افتراضي 64 ميغابايت للـ CI؛ معيار البوابة `UPLOAD_SIZE_MB=5120` (`manual/plan-size.md`). |
| `duplicate-payment` | **بديل مؤقت**: `Idempotency-Key` على كل كتابة (بلا مفتاح/مفتاح مشوّه = 422، تكرار = الاستجابة الأولى، جسم مختلف = 422، متزامن = مرة واحدة). لا يدّعي معيار الدفع. |
| `invalid-file` | الخطّاف الداخلي (رفض واضح، دفعة تخلط الجيد والرديء، عدم التعليق) ثم الوصول إلى `failed` بالسبب الصحيح (`checksum_mismatch` و`storage_error` و`invalid_file`) مع بقاء الجيد في الدفعة موثَّقًا. الملف التالف الترميز للوسائط. |
| `receipt-notification` | ثلاثة قياسات: الإنشاء ← مهمة المشرف (20 تشغيلًا)، والتحقق ← إشعار الإيصال برقمه وبصمة الخادم، والتصعيد بمهلة محقونة (محرر الأخبار ثم مدير النظام، والمُقَرّ لا يُصعَّد). المشرف يتلقى مهمته عند الإنشاء لا عند التحقق: سؤال مرفوع للمنسّق، فالنتيجة `partial`. |
| `concurrent-load` | 60 رفعًا متزامنًا (CI: 1 ميغابايت عبر الخطّاف وS3؛ يدويًا: 2 غيغابايت عبر tusd، انظر `manual/plan-size.md`) ومقارنة زمن الإشعار مع التشغيل المنفرد. حد «لا تدهور» افتراضي من الجودة. لا قياس لقرص خادم الرفع. |
| `performance` | زمن قراءة الواجهة تحت حمل (قائمة، تفصيل، صندوق) ويفشل عند p95 فوق 2 ثانية؛ البحث النصي ومعاينة 10 دقائق غير موجودين فلا يُدَّعيان. |
| `dynamic-fields` | الجزء المشترك (`form-conformance/`) وحيًّا على الخادم: نشر إصدار، بوابة v0، التاريخ المقروء، إكمال مسودة قديمة بإصدار أحدث، وكل الحالات المشتركة عبر `POST /materials`. `pass` يتطلب أيضًا نتائج web وios وandroid متطابقة. |
| `task-killers` | ميداني: `field/task-killers.md` ثم `field/record-card.mjs`. |
| الباقي | ملف لكل اسم يطبع المعيار ويرجع `pending` حتى توجد الحزمة المقيسة. |

لا يكتب أي سكربت `pass` دون أن يكون الدليل كله حاضرًا: فحص لم يُنفَّذ (مثل الجزء الحي) يُنتج `partial`، ويرفض `validate-results.mjs` أي `pass` مع مقياس يعلن أن الدليل ناقص.

## التشغيل الحي ضد الخادم

```bash
cd apps/api && npm ci && src/db/migrate.sh up && npm run build      # DATABASE_URL لقاعدة فارغة مرحَّلة
cd ../../tools/acceptance && node live/run.mjs [--dry-run]
```

يبدأ `live/run.mjs` الخادم المبني بأسرار مؤقتة عشوائية، ويزرع `live/seed.mjs` قاعدة اصطناعية (مكتبان، مستخدم لكل دور، مراسل ومشرف في مكتب آخر، مواد بإحداثيات وعناوين كناري)، ثم يشغّل: `tenant-isolation`، `duplicate-payment`، `invalid-file`، `receipt-notification`، `concurrent-load`، `performance`، ثم `pii-leak` (يقرأ سجلات كل ما سبقه)، و`dynamic-fields` أخيرًا لأنه ينشر نموذجًا يصير الحالي بحقول مطلوبة. بـ `LIVE_REDIS_URL` و`LIVE_S3_*` يتحقق الخادم فعليًا ويُشارك حد المعدل في Redis؛ بدونهما تُشغَّل الأجزاء التي لا تحتاجهما فقط. `--only=a,b` يشغّل بعضها. بلا `--dry-run` تُكتب النتائج في `docs/measurements/acceptance/`. وظيفة `live` في `.github/workflows/acceptance.yml` تشغّله بـ `--dry-run`.

العمليات التي لم تُنفَّذ بعد في الخادم (404 دون اعتماد) تُحسب `unimplemented` وتُبقي النتيجة `partial`؛ تتحول إلى حالات فعلية تلقائيًا حين تُنفَّذ.
