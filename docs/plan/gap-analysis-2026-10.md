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
| نصاب المدراء للتجاوزات الحساسة | `scripts/admin-quorum.mjs` | **غائب** | `apps/api` | تشغيل السكربت وحفظ القياس. |
| توقيع وتوثيق المصدر (C2PA) | `scripts/c2pa-manifest.mjs` | **غائب** | `workers/ + apps/api` | قياس التحقق من بيان C2PA. |
| منع تسريب نسخ التسليم | `scripts/delivery-leak.mjs` | **غائب** | `apps/api + workers/` | فحص روابط التسليم الموقعة وحفظ القياس. |
| صلاحية روابط التحميل الموقعة | `scripts/download-url.mjs` | **غائب** | `apps/api` | قياس انتهاء صلاحية الروابط. |
| رفع ملف ميداني 1 غيغابايت | `scripts/field-upload-1gb.mjs` | **غائب** | `apps/ + infra/` | تجربة رفع 1GB عبر netlab وحفظ القياس. |
| مسار الوسائط المتكامل | `scripts/media-e2e.mjs` | موجود (`REPORT.md`) | `apps/api + workers/` | توثيق زمن المعالجة الكلي. |
| جلب ومعالجة الوسائط البعيدة | `scripts/media-remote.mjs` | **غائب** | `workers/` | قياس أداء المعالجة عن بُعد. |
| موثوقية توصيل الإشعارات | `scripts/notification-delivery.mjs` | **غائب** | `apps/api + workers/` | قياس نسبة وزمن الوصول. |
| التحكم في التزامن المتفائل | `scripts/optimistic-concurrency.mjs` | **غائب** | `apps/api` | قياس If-Match في الخادم. |
| ضوابط الوصول لهوية المراسل | `scripts/reporter-identity-access.mjs` | **غائب** | `apps/api` | قياس نطاق protected_source:read. |
| حسم تعارضات الحجز | `scripts/reservation-conflict.mjs` | **غائب** | `apps/api` | اختبار التنافس المتزامن على الحجز. |
| توليد مسودة التفريغ النصي | `scripts/transcript-draft.mjs` | **غائب** | `workers/` | قياس زمن ودقة المسودة الأولى. |

**الخلاصة:** 35 اختبارًا لها سكربت؛ 24 منها له قياس موثق، و11 بلا قياس. إغلاق الغائب يعني تشغيل السكربت على بيئة فعلية وحفظ نتيجته بمخطط `contracts/schemas/measurement.json`.

## 2. التناقضات بين العقد والكود

لم تُدرج هنا: المراجعة الأولى أنتجت خمس ملاحظات بمراجع (ملف:سطر) لم يتحقق المنسّق من صحة ثلاثة منها (الملفات المذكورة غير موجودة في المستودع)، فحُذف القسم كله بدل نشر مراجع غير مؤكدة. يُعاد كتابته في PR لاحق بمراجع محقَّقة بأداة فحص انحراف العقد (`tools/contract-drift`، مهمة kimi 3) أو بقراءة مباشرة للملفات الموجودة.
