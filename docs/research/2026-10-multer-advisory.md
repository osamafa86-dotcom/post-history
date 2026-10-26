# بحث: ثغرة multer ‏GHSA-q7qp-rjg7-q26m وإصلاحها

- مسار العمل: Issue ‏#308 (بحث 1).
- تاريخ آخر تحقق من كل ما في هذا الملف: **2026-10-26**.
- النطاق: حقائق وخيارات فقط؛ القرار للمنسّق.

## الخلاصة

1. صدر إصلاح في `multer` **2.5.0** (22 أكتوبر 2026).
2. **لم يصدر** حتى تاريخ التحقق أي إصدار من `@nestjs/platform-express` يحمل `multer` 2.5.0: كل الإصدارات المنشورة (ومنها 11.2.8 و12.2.0) تثبّت `multer` على `2.4.0` حرفيًا. التحديث دُمج في الفرع الرئيسي لـ NestJS في 25 أكتوبر 2026 ولم يُنشر بعد.
3. الاستغلال يتطلب **مسارًا يشغّل multer فعلًا** وفيه **`fileFilter` غير متزامن**. حزمة `apps/api` في المستودع لا تستعمل أي `FileInterceptor` ولا `fileFilter` حتى تاريخ التحقق، فالشيفرة الضعيفة موجودة في الشجرة لكنها غير قابلة للوصول.
4. يوجد override آمن تقنيًا (`multer` → `2.5.0`) جُرِّب محليًا في مشروع اصطناعي: يُحلّ ويُحمَّل ويُسكت `npm audit`.
5. اقتراح `npm audit fix --force` (النزول إلى `@nestjs/platform-express@11.1.1`) **خطر**: يجلب `multer` 1.4.5-lts.2 المتأثر بعدة ثغرات أخرى.

## تفاصيل الثغرة

| البند | القيمة | المصدر |
| --- | --- | --- |
| المعرّفات | GHSA-q7qp-rjg7-q26m / CVE-2026-113872 | [GitHub Advisory](https://github.com/advisories/GHSA-q7qp-rjg7-q26m) (تحقق 2026-10-26) |
| الخطورة | عالية، CVSS 3.1 = 7.5، `AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:H` | المصدر نفسه |
| الإصدارات المتأثرة | `>= 2.0.0, < 2.5.0` | المصدر نفسه |
| الإصدار المُصلِح | `2.5.0` | المصدر نفسه، و[ملاحظات إصدار v2.5.0](https://github.com/expressjs/multer/releases/tag/v2.5.0) (تحقق 2026-10-26) |
| نوع الضعف | CWE-248 (استثناء غير ملتقط)، CWE-404 (تحرير غير سليم لمورد) | [GitHub Advisory](https://github.com/advisories/GHSA-q7qp-rjg7-q26m) |
| تاريخ النشر | نُشر من المشروع وNVD في 22 أكتوبر 2026، وروجع في قاعدة GitHub في 23 أكتوبر 2026 | المصدر نفسه |
| الإيداع المُصلِح | `expressjs/multer@80a2d9d` | [الإيداع](https://github.com/expressjs/multer/commit/80a2d9df1dfd63b5fab631b8b9966164ed647adf) (تحقق 2026-10-26) |

### شروط الاستغلال بالضبط

بحسب نص [الإعلان](https://github.com/advisories/GHSA-q7qp-rjg7-q26m) (تحقق 2026-10-26):

- يجب أن يكون `multer` **مهيّأً بـ `fileFilter` غير متزامن** (يستدعي الـ callback لاحقًا، بعد `await` أو مؤقت أو استعلام).
- يُجهَض الطلب (مثلًا برفض أحد الملفات) بينما `fileFilter` لملف آخر ما زال معلّقًا؛ حين يعود الـ callback يستأنف تدفق تحليل فكّكه multer، فيطلق busboy حدث `error` بلا مستمع، فتنهار عملية Node كلها.
- **طلب واحد غير مصادَق يكفي**، أيًّا كان محرك التخزين.
- `fileFilter` **المتزامن غير متأثر**؛ وهذا هو الحل البديل الرسمي.

النتيجة العملية: الثغرة لا تُستغل إلا عبر مسار HTTP يمر فعلًا بـ middleware ‏multer.

### هل يعمل multer في NestJS دون أن نستدعيه؟

- فُحصت حزمة `@nestjs/platform-express@11.2.7` المنشورة على npm (2026-10-26): `multer` لا يُستورد إلا في ملفات `multer/interceptors/*` (‏`FileInterceptor` و`FilesInterceptor` و`FileFieldsInterceptor` و`AnyFilesInterceptor` و`NoFilesInterceptor`)، ولا يوجد فيها `fileFilter` افتراضي. أي أن multer لا يعمل إلا على المسارات التي تُزيَّن بأحد هذه الـ interceptors، و`fileFilter` لا يوجد إلا إن مرّره المطوّر. (المصدر: [شيفرة FileInterceptor في مستودع NestJS](https://github.com/nestjs/nest/blob/master/packages/platform-express/multer/interceptors/file.interceptor.ts)، تحقق 2026-10-26.)
- حالة المستودع (فرع `main` في 2026-10-26): `apps/api/package.json` يثبّت `@nestjs/platform-express` على `11.2.7`، و`apps/api/package-lock.json` يحلّ `multer` إلى `2.4.0`. البحث في `apps/api` عن `FileInterceptor|FilesInterceptor|AnyFilesInterceptor|UploadedFile|MulterModule|fileFilter` لا يعيد أي نتيجة. الرفع في الخطة يمر عبر tus وروابط موقّعة لا عبر multipart في الـ API.
- لذلك: الاعتماد ضعيف على مستوى الشجرة (وسيُعلَّم في `npm audit` وDependabot)، لكنه غير قابل للاستغلال ما لم يُضف مسار يستعمل multer مع `fileFilter` غير متزامن. هذا استنتاج من الفحص أعلاه، ولا يغني عن إعادة الفحص عند أي إضافة.

## جدول الإصدارات

| الحزمة | الإصدار | تاريخ النشر على npm | `multer` المضمَّن | الحالة تجاه الثغرة |
| --- | --- | --- | --- | --- |
| `multer` | 2.4.0 | 2026-09-14 | — | متأثر |
| `multer` | **2.5.0** | 2026-10-22 | — | **مُصلَح** (`latest` على npm) |
| `@nestjs/platform-express` | 11.2.7 (المستعمل عندنا) | 2026-09-30 | `2.4.0` (تثبيت حرفي) | متأثر |
| `@nestjs/platform-express` | 11.2.8 (`legacy`) | 2026-10-23 | `2.4.0` | متأثر |
| `@nestjs/platform-express` | 12.2.0 (`latest`) | 2026-10-19 | `2.4.0` | متأثر |
| `@nestjs/platform-express` | 11.1.1 | — | `1.4.5-lts.2` | خارج نطاق هذه الثغرة لكنه متأثر بثغرات أخرى (انظر أدناه) |
| `@nestjs/platform-express` | الإصدار القادم من الفرع الرئيسي | لم يُنشر | `2.5.0` | PR ‏[nestjs/nest#18268](https://github.com/nestjs/nest/pull/18268) دُمج في 2026-10-25 على `master` |

مصادر الجدول: سجل npm عبر `npm view multer time` و`npm view @nestjs/platform-express@<v> dependencies` و`dist-tags` (نُفّذت في 2026-10-26)؛ و[PR ‏#18268](https://github.com/nestjs/nest/pull/18268) (تحقق 2026-10-26). لم يُعثر على فرع صيانة لـ 11.x في مستودع NestJS يحمل التحديث، فلا تاريخ معلنًا لإصدار 11.x مُصلَح.

## خيارات الإصلاح (للمنسّق)

### الخيار أ: override في `apps/api/package.json`

- توثيق npm: `overrides` تُقرأ من `package.json` الجذري للمشروع فقط، وتُستعمل تحديدًا لاستبدال اعتماد فرعي فيه ثغرة معروفة ([توثيق npm ‏package.json › overrides](https://docs.npmjs.com/cli/v10/configuring-npm/package-json/?v=true)، تحقق 2026-10-26). `apps/api` مشروع جذري مستقل (له `package-lock.json` خاص ولا يوجد `package.json` في جذر المستودع)، فالـ override يوضع فيه.
- الشكل: `"overrides": { "multer": "2.5.0" }`.
- التوافق: `multer` 2.4.0 و2.5.0 لهما الاعتمادات نفسها (`busboy ^1.6.0`، `type-is ^1.6.18`، `append-field ^1.0.0`) و`engines` نفسه (`node >= 10.16.0`) بحسب `npm view` (2026-10-26). ملاحظات إصدار 2.5.0 لا تذكر تغييرًا كاسرًا؛ فيها إلى جانب الإصلاح الأمني إصلاحان: عدم إضافة رفع فاشل إلى قائمة التنظيف عند الإجهاض، وقبول قيمة حقل بطول `fieldSize` تمامًا ([v2.5.0](https://github.com/expressjs/multer/releases/tag/v2.5.0)).
- تجربة محلية (2026-10-26، Node 20.20.2، npm 10.8.2) على مشروع اصطناعي بالإصدارات نفسها (`@nestjs/common|core|platform-express@11.2.7`): بلا override أبلغ `npm audit` عن ثغرتين عاليتين (multer وplatform-express المعتمد عليه)؛ مع override صار `npm ls multer` يعرض `multer@2.5.0 overridden`، و`npm audit` صفر ثغرات، وتحميل `FileInterceptor` يعمل. لم تُشغَّل اختبارات `apps/api` نفسها، ولم يُقس سلوك رفع فعلي.
- الكلفة: override يجب أن يُزال أو يُراجع حين يصدر platform-express يحمل 2.5.0، وإلا قد يثبّت إصدارًا أقدم من المطلوب لاحقًا.

### الخيار ب: انتظار إصدار NestJS

- التحديث مدموج في `master` (فرع 12.x) منذ 2026-10-25 ولم يُنشر ([PR ‏#18268](https://github.com/nestjs/nest/pull/18268)). نحن على 11.x، ولا دليل على إصدار 11.x قادم يحمله؛ الانتقال إلى 12.x ترقية رئيسية لـ `@nestjs/common` و`core` و`testing` معًا.

### الخيار ج: عدم التغيير مع ضابط

- مقبول تقنيًا ما دام لا يوجد مسار multer، لكنه يترك تنبيه `npm audit`/Dependabot مفتوحًا، ويحتاج قاعدة مراجعة: أي `fileFilter` يُضاف يكون متزامنًا (وهو الحل البديل الرسمي في [الإعلان](https://github.com/advisories/GHSA-q7qp-rjg7-q26m)).

### ما يجب تجنبه: `npm audit fix --force`

- في التجربة نفسها اقترح npm تثبيت `@nestjs/platform-express@11.1.1` («breaking change»). هذا الإصدار يعتمد `multer` ‏`1.4.5-lts.2` (بحسب `npm view`، 2026-10-26)، وهو ضمن نطاق ثغرات منشورة أخرى، منها [GHSA-72gw-mp4g-v24j](https://github.com/advisories/GHSA-72gw-mp4g-v24j) (‏`>= 1.0.0, < 2.2.0`) و[GHSA-wc9g-mqfw-jrwm](https://github.com/advisories/GHSA-wc9g-mqfw-jrwm) و[GHSA-535w-7cp7-47q4](https://github.com/advisories/GHSA-535w-7cp7-47q4) (‏`< 2.3.0`)، بحسب واجهة GitHub العامة للإعلانات (‏`/advisories?affects=multer`، استعلام في 2026-10-26).

## سياق: سلسلة ثغرات multer في 2026

بحسب واجهة GitHub العامة للإعلانات (‏`/advisories?affects=multer`، استعلام في 2026-10-26)، نُشرت لـ multer أحد عشر إعلانًا بين 1 مارس و23 أكتوبر 2026 (وأربعة أخرى في 2025)، معظمها حجب خدمة مرتبط بإجهاض الرفع أو أسماء الحقول، وآخرها هذه الثغرة. المعنى العملي: أي مسار multipart مستقبلي في الـ API يحتاج متابعة دورية لهذه الحزمة.

## ما لم يُتحقق منه

- لم يُشغَّل اختبار استغلال، ولم تُقس أي نتيجة في `docs/measurements/`.
- لا تاريخ معلن لإصدار NestJS يحمل multer 2.5.0.
