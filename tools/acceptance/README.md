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
| `pii-leak` | حقيقي. ساكن (أمثلة العقد وحمولات Outbox ومخططات الاستجابة وأمثلتها + ضوابط إيجابية تثبت أن الكاشف يرى ما يرفضه العقد)، وحي بـ `PII_BASE_URL` وكناري. ملفات `waivers/*.json` تسجّل ما هو حقيقي ورُفع لمالكه؛ الاستثناء يسقط النتيجة إلى `partial` ويصير فشلًا إن زال سببه. |
| `tenant-isolation` | هيكل الحالات (مصفوفة الأدوار × العمليات، النطاق = 404، حجب `x-permissions`، تسريب القوائم) يُبنى من `x-roles` و`x-permissions`، وينفَّذ بـ `TENANT_BASE_URL`. v0 بلا مؤسسات فالجزء المؤسسي يُضاف مع المرحلة التجارية. |
| `upload-resume` | حقيقي ضد tusd: قطع الاتصال أثناء PATCH، HEAD، استئناف من آخر ما وصل على مجمّع اتصالات جديد، وتطابق SHA-256 من الخادم. حجم افتراضي 64 ميغابايت للـ CI؛ معيار البوابة `UPLOAD_SIZE_MB=5120`. |
| `dynamic-fields` | الجزء المشترك فقط (`form-conformance/`). |
| `task-killers` | ميداني: `field/task-killers.md` ثم `field/record-card.mjs`. |
| الباقي | ملف لكل اسم يطبع المعيار ويرجع `pending` حتى توجد الحزمة المقيسة. |

لا يكتب أي سكربت `pass` دون أن يكون الدليل كله حاضرًا: فحص لم يُنفَّذ (مثل الجزء الحي) يُنتج `partial`، ويرفض `validate-results.mjs` أي `pass` مع مقياس يعلن أن الدليل ناقص.
