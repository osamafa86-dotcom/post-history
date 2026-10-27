# تحليل الفجوات بين الخطة والمنجز — أكتوبر 2026

يقابل هذا التقرير اختبارات القبول في الخطة بما نُفّذ منها سكربتًا في `tools/acceptance/scripts/` وما له نتيجة قياس في `docs/measurements/`. عمود القياس **محسوب آليًا** وقت كتابة التقرير: «موجود» يعني أن اسم السكربت يرد في ملف نتيجة أو تقرير داخل `docs/measurements/` (عدا README)، و«غائب» يعني لا أثر له هناك. وجود السكربت لا يعني أن الاختبار أُجري؛ القياس هو الدليل.

## 1. مطابقة اختبارات القبول والقياسات

| اختبار القبول | السكربت | القياس | الحزمة المالكة | ما يلزم لإغلاقه |
|---|---|---|---|---|
| استئناف الرفع بعد انقطاع الشبكة | `scripts/upload-resume.mjs` | موجود (`web/2026-10-21-desktop-upload-resume.json`) | `apps/ + infra/` | مكتمل في السكربت والقياس؛ يتطلب تثبيت بوابة التحقق الدوري في CI. |
| الرفع عبر الشبكات الميدانية الضعيفة | `scripts/field-network-upload.mjs` | موجود (`REPORT.md`) | `tools/ + apps/` | ضبط مهلة إعادة المحاولة التكيفية في عميل الرفع لاجتياز قياس فقدان الحزم العالي. |
| استئناف الرفع بعد الإغلاق القسري وإعادة التشغيل | `scripts/force-quit-restart.mjs` | موجود (`REPORT.md`) | `apps/ios + apps/android` | التحقق من استعادة حالة الإزاحة (offset) من التخزين المحلي قبل إعادة تهيئة الجلسة. |
| التحمل تحت الحمل المتزامن | `scripts/concurrent-load.mjs` | موجود (`REPORT.md`) | `apps/api + infra/` | رفع حدود مجمع اتصالات قاعدة البيانات لتفادي اختناق جلسات الرفع المتزامنة. |
| رفض الملفات غير الصالحة أو التالفة | `scripts/invalid-file.mjs` | موجود (`REPORT.md`) | `apps/api + workers/` | توحيد رمز الخطأ المعاد مع مخطط أخطاء العقد المصدري. |
| دقة وسائط العرض البديلة (Proxy) | `scripts/proxy-accuracy.mjs` | موجود (`REPORT.md`) | `workers/` | ضبط معاملات الترميز لضمان تطابق عدد الإطارات والمدة مع الأصل. |
| إشعار إيصال الاستلام للمراسل | `scripts/receipt-notification.mjs` | موجود (`REPORT.md`) | `apps/api + workers/` | ربط حدث صندوق الخروج بالإشعار الفوري فور التحقق من البصمة. |
| مطابقة الحقول والنماذج الديناميكية | `scripts/dynamic-fields.mjs` | موجود (`REPORT.md`) | `contracts/ + apps/` | مكتمل عبر form-conformance بين الخادم والويب وiOS وأندرويد. |
| عزل المستأجرين والجهات | `scripts/tenant-isolation.mjs` | موجود (`REPORT.md`) | `apps/api` | فرض شرط معرف الجهة في جميع استعلامات القراءة الفرعية للمرفقات. |
| منع تسريب البيانات الشخصية والموقع (PII/GPS) | `scripts/pii-leak.mjs` | موجود (`REPORT.md`) | `workers/ + apps/` | تجريد حقول EXIF/GPS قبل نشر وسائط المعاينة والتحقق الآلي منها. |
| دقة القص والتصدير | `scripts/cut-export.mjs` | موجود (`render-bench/2026-10-21-cut-export.json`) | `workers/` | تقليص انحراف نقاط القطع على مستوى الإطار في العامل. |
| منع الدفع المكرر | `scripts/duplicate-payment.mjs` | موجود (`REPORT.md`) | `apps/api` | فرض قيد التفرد على Idempotency-Key في مسار الدفع. |
| استرداد المدفوعات | `scripts/refund.mjs` | موجود (`REPORT.md`) | `apps/api` | تحديث حالة الحقوق تلقائيًا عند اكتمال الاسترداد. |
| حصرية الحقوق ومنع البيع المزدوج | `scripts/rights-exclusivity.mjs` | موجود (`REPORT.md`) | `apps/api` | قفل التزامن المتفائل عند حجز الحقوق الحصرية. |
| صرف مستحقات المراسلين | `scripts/payout.mjs` | موجود (`REPORT.md`) | `apps/api` | ربط سجل التسويات بأحداث صندوق الخروج وقياس الكمون. |
| التعافي من الأعطال | `scripts/recovery.mjs` | موجود (`ops/2026-10-20-restore-drill-ci.json`) | `infra/` | أتمتة اختبار استعادة لقطة قاعدة البيانات والتحقق من سلامة WAL. |
| التوافرية العالية | `scripts/availability.mjs` | موجود (`REPORT.md`) | `infra/` | استكمال قياس زمن التعافي التلقائي عند توقف عقدة. |
| تقييم جودة نماذج التفريغ والذكاء الاصطناعي | `scripts/ai-eval.mjs` | موجود (`REPORT.md`) | `workers/` | تحديث القياس على عينات معيارية وتثبيت عتبة الخطأ. |
| أداء واجهات البرمجة | `scripts/performance.mjs` | موجود (`REPORT.md`) | `apps/api` | تحسين الفهارس لخفض p95. |
| تصدير القوالب العاجلة | `scripts/urgent-template-export.mjs` | موجود (`render-bench/2026-10-21-urgent-template.json`) | `workers/` | طابور منفصل بأولوية لمهام التصدير العاجل. |
| الصمود أمام قاتلات المهام | `scripts/task-killers.mjs` | موجود (`REPORT.md`) | `apps/android + apps/ios` | توثيق قياس الاستئناف بعد تدخل نظام التشغيل. |
| محاذاة الطوابع الزمنية للنصوص | `scripts/timestamp-alignment.mjs` | موجود (`render-bench/2026-10-22-timestamp-alignment-10min.json`) | `workers/` | معايرة طوابع الكلمات مع مسار الصوت الأصلي. |
| الإلغاء الفوري للجلسة عن بُعد | `scripts/session-revocation.mjs` | موجود (`REPORT.md`) | `apps/api + apps/` | مسح المفاتيح المحلية وإيقاف الرفع النشط فور الإلغاء. |
| نصاب المدراء للتجاوزات الحساسة | `scripts/admin-quorum.mjs` | موجود — **pass** (`docs/measurements/acceptance/manual-40438623850-1/2026-10-27-admin-quorum-api.json`) | `apps/api` | موثق: الواجهة وسطر الأوامر بنصاب شخصين والحارس. |
| توقيع وتوثيق المصدر (C2PA) | `scripts/c2pa-manifest.mjs` | **غائب** | `workers/ + apps/api` | قياس التحقق من بيان C2PA. |
| منع تسريب نسخ التسليم | `scripts/delivery-leak.mjs` | موجود — **partial** (`docs/measurements/acceptance/manual-40438623850-1/2026-10-27-delivery-leak-delivery-leak.json`) | `apps/api + workers/` | جزئي: حزمتان اصطناعيتان بلا تسرب؛ جذر توقيع اختباري، ووحدة المفاتيح والثقة الحقيقية غير مقيسَتين. |
| صلاحية روابط التحميل الموقعة | `scripts/download-url.mjs` | موجود — **pass** (`docs/measurements/acceptance/manual-40456631078-1/2026-10-27-download-url-api.json`) | `apps/api` | نتيجة السكربت: جُلب الرابط وانتُظر الانتهاء (expiry_waited=true)، ونجح فحص توقفه؛ رمز HTTP اللاحق غير محفوظ في الوثيقة أو خرج النجاح، والسكربت يقبل تعذر الشبكة أيضًا، فلا يثبت هذا القياس وحده رفضًا محددًا من الخادم. |
| رفع ملف ميداني 1 غيغابايت | `scripts/field-upload-1gb.mjs` | **غائب** | `apps/ + infra/` | تجربة رفع 1GB عبر netlab وحفظ القياس. |
| مسار الوسائط المتكامل | `scripts/media-e2e.mjs` | موجود (`REPORT.md`) | `apps/api + workers/` | توثيق زمن المعالجة الكلي. |
| جلب ومعالجة الوسائط البعيدة | `scripts/media-remote.mjs` | **غائب** | `workers/` | قياس أداء المعالجة عن بُعد. |
| موثوقية توصيل الإشعارات | `scripts/notification-delivery.mjs` | موجود — **pass** (`docs/measurements/acceptance/manual-40438623850-1/2026-10-27-notification-delivery-api.json`) | `apps/api + workers/` | موثق على 20 مادة بالاستطلاع كل 150 مللي ثانية؛ ليس قياس دفع إلى جهاز فعلي. |
| التحكم في التزامن المتفائل | `scripts/optimistic-concurrency.mjs` | موجود — **pass** (`docs/measurements/acceptance/manual-40438623850-1/2026-10-27-optimistic-concurrency-api.json`) | `apps/api` | موثق على 20 جولة؛ السباقات بين عمليات خادم متعددة غير مقيسة. |
| ضوابط الوصول لهوية المراسل | `scripts/reporter-identity-access.mjs` | موجود — **pass** (`docs/measurements/acceptance/manual-40438623850-1/2026-10-27-reporter-identity-access-api.json`) | `apps/api` | موثق للوضعين والتبديل الحي على نسخة خادم واحدة؛ التبديل عبر عمليات متعددة غير مقيس. |
| حسم تعارضات الحجز | `scripts/reservation-conflict.mjs` | موجود — **pass** (`docs/measurements/acceptance/manual-40438623850-1/2026-10-27-reservation-conflict-api.json`) | `apps/api` | موثق على 20 جولة بثلاثة متنافسين؛ التنافس بين عمليات خادم متعددة غير مقيس. |
| توليد مسودة التفريغ النصي | `scripts/transcript-draft.mjs` | **غائب** | `workers/` | قياس زمن ودقة المسودة الأولى. |

**الخلاصة:** 35 اختبارًا لها سكربت؛ 31 منها له قياس موثق، و4 بلا قياس؛ وجود وثيقة لا يعني أن نتيجتها pass. إغلاق الغائب يعني تشغيل السكربت على بيئة فعلية وحفظ نتيجته بمخطط `contracts/schemas/measurement.json`.

تحديث #422 بتاريخ 2026-10-27: سُجلت سبع وثائق من [التشغيل اليدوي 40438623850، المحاولة 1](https://github.com/osamafa86-dotcom/post-history/actions/runs/40438623850) على main: خمس نتائج pass ونتيجتا partial كما أنتجتهما artifacts، دون تعديل الأرقام أو الأحكام. قياس delivery-leak داخل CI على حزمة اصطناعية بتوقيع اختباري فقط؛ لا يغيّر تعطيل التسليم أو C2PA في الإنتاج، ولا يُثبت ثقة توقيع إنتاجية. تبقى c2pa-manifest وfield-upload-1gb وmedia-remote وtranscript-draft خارج هذه المهمة.

تحديث #426 (ب) بتاريخ 2026-10-27: حُفظت الوثائق السبع حرفيًا من [التشغيل اليدوي 40456631078، المحاولة 1](https://github.com/osamafa86-dotcom/post-history/actions/runs/40456631078) في `docs/measurements/acceptance/manual-40456631078-1/`: ست نتائج pass وdelivery-leak بنتيجة partial؛ لا استبدال للقياس السابق. يشهد خرج download-url بانتظار الانتهاء ونجاح الفحص، لكن رمز HTTP بعد الانتظار غير مسجل؛ تبقى حدود الفحص المذكورة في صفه قائمة. لا تغيير لنطاق الثقة الاختبارية في delivery-leak ولا تفعيل إنتاجي.

## 2. التناقضات بين العقد والكود

لم تُدرج هنا: المراجعة الأولى أنتجت خمس ملاحظات بمراجع (ملف:سطر) لم يتحقق المنسّق من صحة ثلاثة منها (الملفات المذكورة غير موجودة في المستودع)، فحُذف القسم كله بدل نشر مراجع غير مؤكدة. يُعاد كتابته في PR لاحق بمراجع محقَّقة بأداة فحص انحراف العقد (`tools/contract-drift`، مهمة kimi 3) أو بقراءة مباشرة للملفات الموجودة.

## 3. التناقضات المحققة بين العقد (`contracts/openapi.yaml`) والكود التنفيذي

تم التحقق من جميع المسارات وأرقام الأسطر أدناه مباشرةً مقابل الملفات الفعلية في المستودع وبواسطة أداتي الفحص `tools/contract-drift.mjs:1` (PR #346) و `tools/contract-clients.mjs:1` (PR #393). (ملاحظة المنسّق: ثلاثة مراجع في مسودة الوكيل صُحِّحت بعد التحقق: سطر `download-url` في متحكم المواد، وملفا `dashboard.ts` و`permissions.ts` غير الموجودَين استُبدلا بالملفَين الفعليَّين.)

### أ. مسارات منفذة في متحكمات الخادم (`apps/api/src/`) وغير مدرجة في العقد العام (`CONTROLLER_ONLY`)

هذه المسارات تخدم الخطافات الداخلية وعاملي المعالجة الخلفية (`workers/`) تحت البادئة `/internal/*`، وهي منفذة في متحكمات NestJS ولكنها مستثناة عمداً من عقد العملاء العام `contracts/openapi.yaml:1`:

1. **خطافات خادم الرفع `tusd` الداخلية:**
   - `apps/api/src/uploads/tusd-hooks.controller.ts:11` (`@Controller('internal/tusd-hooks')`)
   - `apps/api/src/uploads/tusd-hooks.controller.ts:19` (`POST /internal/tusd-hooks/:hook_token` عبر `@Post(':hook_token')`)

2. **مسارات عامل معالجة الوسائط والمشتقات الداخلية (`internal/media`):**
   - `apps/api/src/media/media.controller.ts:18` (`@Controller('internal/media')`)
   - `apps/api/src/media/media.controller.ts:26` (`GET /internal/media/sessions/:id`)
   - `apps/api/src/media/media.controller.ts:33` (`POST /internal/media/sessions/:id/verification`)
   - `apps/api/src/media/media.controller.ts:41` (`GET /internal/media/files/:file_id`)
   - `apps/api/src/media/media.controller.ts:48` (`POST /internal/media/files/:file_id/derivatives`)
   - `apps/api/src/media/media.controller.ts:57` (`PUT /internal/media/files/:file_id/alignment`)

### ب. مطابقة مسارات العقد العامة مع متحكمات الخادم وتباين استهلاك العملاء (`WEB_ONLY` / `IOS_GENERATED_ONLY`)

1. **تطابق متحكمات المواد والرفع العامة في الخادم مع `contracts/openapi.yaml`:**
   - جميع مسارات المواد في `apps/api/src/materials/materials.controller.ts:16` (`GET :id/export` في السطر `26`، `GET :id/export/download-url` في السطر `39`، `GET :id/duplicates` في السطر `46`، `GET :id/files/:fileId/download-url` في السطر `53`، `GET /materials` في السطر `60`، `POST /materials` في السطر `66`، `GET :id` في السطر `73`، `PATCH :id` في السطر `79`، `GET :id/transitions` في السطر `85`، `POST :id/transitions` في السطر `91`، `PUT :id/contributors` في السطر `98`، `POST :id/reservation` في السطر `105`، و`DELETE :id/reservation` في السطر `112`) مطبقة ومطابقة للعقد.
   - جميع مسارات جلسات الرفع في `apps/api/src/uploads/uploads.controller.ts:9` (`POST /uploads` في السطر `24`، `GET /uploads` في السطر `31`، `GET /uploads/:id` في السطر `39`، `DELETE /uploads/:id` في السطر `45`، و`POST /uploads/:id/complete` في السطر `52`) مطبقة ومطابقة للعقد.

2. **عمليات العقد المستهلكة حصرياً في الويب (`WEB_ONLY`) وغير المستدعاة في تطبيقات المراسلين (`apps/ios` و `apps/android`):**
   - وفق تصنيف `tools/contract-clients.md:25` (`WEB_ONLY` و `IOS_GENERATED_ONLY`)، فإن تطبيقَي الهاتف (`apps/ios` و `apps/android`) يقتصران وظيفياً على مسارات المراسل الميداني (المصادقة، جلب الاستمارة، إنشاء واستئناف وإكمال جلسة الرفع في `apps/ios/Packages/PostHistoryKit/Sources/UploadCore/UploadAPI.swift:8` والأسطر `9-12`، وفي `apps/android/core/src/main/kotlin/net/palpost/library/core/upload/UploadEngine.kt:1` و `apps/android/app/src/main/kotlin/net/palpost/library/ui/material/MyMaterialsScreen.kt:1`).
   - في المقابل، فإن مسارات الإدارة ولوحة غرفة الأخبار (`apps/web/src/server/handler.ts:1`)، ومراجعة المواد وصلاحياتها (`apps/web/src/server/review-actions.ts:1`)، وحسم تعارضات الدعوات (`apps/web/src/server/invite-conflicts.ts:1`)، والحجز والمدفوعات والتصدير التحريري المعرّفة في `contracts/openapi.yaml:1` تُستهلك من خادم الويب (`apps/web/src/server/*.ts` وفق `tools/contract-clients.md:9`) وتبقى مُولّدة فقط دون استدعاء مباشر في حزمة عميل iOS (`apps/ios/Packages/PostHistoryKit/Sources/PostHistoryAPI/` وفق `tools/contract-clients.md:10`) وعميل أندرويد المولّد عبر `apps/android/api/build.gradle.kts:1` (`tools/contract-clients.md:14`).
