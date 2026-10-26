# تغطية العملاء لانحراف العقد

يكمل `contract-clients.mjs` أداة `contract-drift.mjs` (#346): لكل عملية HTTP يطبع هل هي **في العقد** (`contracts/openapi.yaml`)، وهل هي **في الخادم** (مزخرفات NestJS في `apps/api/src`)، و**من يستهلكها** من العملاء الثلاثة. الأداتان مستقلتان الآن ولا تستورد إحداهما الأخرى؛ عند دمج #346 يمكن جمعهما في ملف واحد دون تغيير المنطق.

## مصادر القراءة

| العميل | ما يُقرأ | كيف |
| --- | --- | --- |
| ويب | `apps/web/src/server/*.ts` (بلا تكرار للمجلدات الفرعية وبلا ملفات الاختبار) | نداءات العميل المولَّد الأنواع `api.GET("/path", …)` وأخواتها؛ المسار نص حرفي يُطبَّع كمفاتيح العقد |
| iOS | `apps/ios/**/PostHistoryAPI/APIs/*.swift` (العميل المولَّد المودَع) | مزاوجة كل `localVariablePath = "/…"` مع أقرب `init(method: "…")` يليه في الملف |
| iOS (استهلاك) | بقية `Sources/**/*.swift` خارج `PostHistoryAPI/` وخارج `Tests/` | استدعاءات `XxxAPI.<operationId>(` و`XxxAPI.<operationId>WithRequestBuilder(` |
| أندرويد (استهلاك) | `apps/android/**/*.kt` خارج `build/` و`src/test/` و`src/androidTest/` | استدعاءات `xxxApi.<operationId>(` على نسخ تنتهي أسماؤها بـ `Api` |

عميل أندرويد يُولَّد وقت البناء من العقد (`apps/android/api/build.gradle.kts`) فلا يوجد سطح مولَّد مودَع يُقارن؛ يُكتفى بمواقع النداء. مطابقة iOS وأندرويد تتم بأسماء `operationId` لأن المولّدَين يسمّيان الدوال بها؛ قد تظهر في أندرويد دوال مغلّفة بالاسم نفسه على نسخة تنتهي بـ `Api`، ومواقع الملفات والأسطر في التقرير تتيح الحكم عليها. نداءات iOS على أصناف `API` بأسماء ليست `operationId` في العقد تُطبع أسطر `IOS_UNKNOWN_CALL`.

## التشغيل

```bash
node tools/contract-clients.mjs            # تقرير نصي: ملخص ثم سطر لكل عملية
node tools/contract-clients.mjs --json     # التقرير كاملًا بصيغة JSON (لاستهلاك وكيل آلي)
node tools/contract-clients.mjs --strict   # خروج 1 عند وجود فروق أو مزخرفات غير محلَّلة
node --test tools/contract-clients.test.mjs
```

السطر لكل عملية: `METHOD /path — العقد: نعم/لا | الخادم: نعم/لا | web: n | ios: n | android: n`، ثم أسطر `WEB_ONLY` (نداء ويب خارج العقد) و`IOS_GENERATED_ONLY` (عملية في عميل iOS المولَّد المودَع وليست في العقد، أي توليد قديم) و`UNPARSED_CONTROLLER` و`MISSING_DIR`. عمليات `/internal/…` و`/sandbox/…` و`/payments/webhooks/…` و`/health` لا تظهر في عميل iOS المولَّد عن قصد (واجهات خادم-خادم)، فغيابها هناك متوقع ولا يعدّ انحرافًا؛ راية `iosGenerated` في JSON تبيّنها لكل عملية.

الفروق **تحذير لا فشل**: رمز الخروج الافتراضي `0`، وعند `GITHUB_ACTIONS=true` يطبع تحذيرًا بصيغة GitHub، و`--strict` يجعل الخروج `1`. المجلدات الغائبة (مثل `apps/android` في checkout جزئي) تُفحص فارغة وتُذكر في `MISSING_DIR` ولا تسقط الأداة.

المدخلات بمتغيرات البيئة `CONTRACT_CLIENTS_OPENAPI` و`CONTRACT_CLIENTS_API` و`CONTRACT_CLIENTS_WEB` و`CONTRACT_CLIENTS_IOS` و`CONTRACT_CLIENTS_ANDROID`، أو بخمسة وسائط موضعية بالترتيب نفسه. لا تحتاج الأداة إلى حزم خارجية، ولا تعدّل العقد أو الشفرة أو إعدادات CI.

هذا فحص مسارات وطرق وأسماء عمليات فقط؛ لا يثبت تطابق أجسام الطلبات أو الاستجابات أو الصلاحيات، ولا يثبت أن النداء المطابق بالاسم هو فعلًا نداء العملية (احتمال دوال مغلّفة مماثلة الاسم في أندرويد).
