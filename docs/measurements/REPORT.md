# تقرير القبول الموحّد

مولَّد آليًا من `docs/measurements/` بـ `tools/acceptance/report.mjs` (2026-10-20). لا يُعدَّل يدويًا. «pass» لا يُكتب إلا حين يكون الدليل كاملًا؛ ما دونه `partial` مع السبب في ملف النتيجة.

## صفوف جدول اختبارات القبول

الخلاصة: pass 0، partial 11، fail 0، info 0، بلا نتيجة 11 من 22.

| الاختبار | النمط | الحالة | المعيار |
| --- | --- | --- | --- |
| upload-resume | automated | ◐ partial | ملف 5 غيغابايت مع ثلاثة انقطاعات وتبديل شبكة؛ استكمال الأجزاء الناقصة وحدها وتطابق البصمة … |
| field-network-upload | pending | ◐ partial | ملف 1 غيغابايت على رابط رفع بسرعة 0.5 ميغابت/ث مع فقد حزم 30% وانقطاع كل دقيقتين؛ يتقدم ال… |
| force-quit-restart | field | — لا نتيجة | على أجهزة فعلية: استئناف من آخر ما وصل بعد إغلاق التطبيق قسرًا، ونفاد البطارية، وإعادة الت… |
| concurrent-load | pending | ◐ partial | 60 رفعًا متزامنًا بملفات 2 غيغابايت؛ لا تدهور في زمن الإشعار ولا في القرص المؤقت لخادم الر… |
| invalid-file | pending | ◐ partial | رفض واضح دون تعليق النظام أو ضياع بقية ملفات الحزمة |
| proxy-accuracy | automated | ◐ partial | قص على النسخة الخفيفة يُصدَّر من الأصل بفارق لا يتجاوز 40 مللي ثانية عند 10 نقاط عشوائية ف… |
| receipt-notification | pending | ◐ partial | مهمة واحدة خلال 60 ثانية من التحقق الفني في 95% من الاختبارات، وتصعيد العاجل بعد المهلة |
| dynamic-fields | pending | ◐ partial | نشر إصدار نموذج جديد مع بقاء سجلات الإصدار السابق قابلة للقراءة، وإكمال مسودات الهاتف القد… |
| tenant-isolation | automated | ◐ partial | فشل كل محاولة من مؤسسة للوصول إلى ملفات ونتائج بحث وفواتير مؤسسة أخرى، بما يشمل الفهارس وا… |
| pii-leak | automated | ◐ partial | لا إحداثيات GPS ولا معرّفات جهاز ولا أسماء محمية في أي معاينة أو تصدير أو إشعار غير مخوّل،… |
| cut-export | pending | — لا نتيجة | مطابقة نقاط القص المرجعية في صيغ الاختبار، وفارق تزامن صوت لا يتجاوز 40 مللي ثانية، ومعالج… |
| duplicate-payment | pending | ◐ partial | إعادة إشعار البوابة عشر مرات وبترتيب مختلف دون تكرار ترخيص أو قيد مالي |
| refund | pending | — لا نتيجة | قيد عكسي صحيح لكل مساهم قبل الصرف وبعده، وظهوره في تقريري الإدارة والمصور |
| rights-exclusivity | pending | — لا نتيجة | منع بيع مادة محظورة أو مجهولة الحقوق أو مشتقة منها، ومنع بيع الحصرية مرتين بما يشمل الطلبا… |
| payout | pending | — لا نتيجة | وصول مبلغ حقيقي إلى مراسلين في غزة والضفة عبر قناة واحدة على الأقل خلال 7 أيام، برسوم ومتط… |
| recovery | pending | — لا نتيجة | استعادة قاعدة البيانات وعينة أصول من النسخة المعزولة لدى المزوّد الثاني ضمن الهدفين: فقد ل… |
| availability | pending | — لا نتيجة | إسقاط خادم وقاعدة بيانات ونشر أثناء الحمل؛ زمن التعافي يثبت الهدف المعلن |
| ai-eval | pending | — لا نتيجة | تقييم على مجموعة الـ 100 مادة: لا تحريف وقائعي جسيم، وتوثيق نسبة الرفض لكل مزوّد على العين… |
| performance | pending | ◐ partial | معاينة مقطع 10 دقائق بدقة 1080p ضمن الهدف المقيس في التأسيس، وبحث نصي أقل من ثانيتين في 95… |
| urgent-template-export | pending | — لا نتيجة | تركيب طبقات الهوية على مقطع دقيقتين بدقة 1080p في زمن أقل من مدة المقطع على خادم التصدير ا… |
| task-killers | field | — لا نتيجة | رفع 1 غيغابايت على جهازي Xiaomi وSamsung بعد قفل الشاشة 30 دقيقة يكتمل دون تدخل بعد شاشة ا… |
| timestamp-alignment | field | — لا نتيجة | محاذاة صوتية بين النسخة الخفيفة والأصل بإزاحة لا تتجاوز 40 مللي ثانية على عشرة ملفات هاتف … |

## اختبارات الأمن خارج جدول الخطة (SEC-01..SEC-07)

| الاختبار | القرار | النمط | الحالة | المعيار |
| --- | --- | --- | --- | --- |
| session-revocation | SEC-01 | automated | ◐ partial | رمز مبطَل (جلسة أو كل الجلسات) يُرفض على الخادم وعلى مسار الرفع خلال ثوانٍ، والرفع الجاري … |
| emergency-wipe | SEC-01 | field | — لا نتيجة | على جهاز فعلي بعد المسح الطارئ: لا شيء من المخازن الموثّقة يبقى، ويتم المسح بلا اتصال خلال… |

## كل النتائج (الأحدث لكل أداة/اختبار/ملف شبكة)

| الاختبار | الأداة | الشبكة | الحالة | الأرقام | التاريخ | التشغيلات | الملف |
| --- | --- | --- | --- | --- | --- | --- | --- |
| concurrent-load | acceptance | — | ◐ partial | concurrency=8، file_size_mb=256، notification_s_p95_load=5.18، degradation_ratio_p95=4.08 | 2026-10-19 | 8 | `docs/measurements/acceptance/2026-10-19-concurrent-load-8x256mb-6.json` |
| duplicate-payment | acceptance | — | ◐ partial | write_operations_checked=15، write_operations_unimplemented=0، failures=0 | 2026-10-19 | 3 | `docs/measurements/acceptance/2026-10-19-duplicate-payment-idempotency-writes-3.json` |
| dynamic-fields | acceptance | — | ◐ partial | server_cases_matching=57، conformance_cases=57، platforms_judged=none | 2026-10-19 | 3 | `docs/measurements/acceptance/2026-10-19-dynamic-fields-reference-3.json` |
| invalid-file | acceptance | — | ◐ partial | failures=0 | 2026-10-19 | 4 | `docs/measurements/acceptance/2026-10-19-invalid-file-media-e2e.json` |
| performance | acceptance | — | ◐ partial | list_materials_ms_p95=155، material_detail_ms_p95=93، inbox_ms_p95=99 | 2026-10-19 | 2 | `docs/measurements/acceptance/2026-10-19-performance-api-read-200m-2.json` |
| pii-leak | acceptance | — | ◐ partial | live_requests=236، live_findings=0، static_findings=0 | 2026-10-19 | 4 | `docs/measurements/acceptance/2026-10-19-pii-leak-live-3.json` |
| proxy-accuracy | acceptance | — | ◐ partial | cut_points=10، cut_matched_by_frame_index=true، cut_worst_gap_ms=0، cut_tolerance_ms=40 | 2026-10-19 | 1 | `docs/measurements/acceptance/2026-10-19-proxy-accuracy-media-e2e.json` |
| receipt-notification | acceptance | — | ◐ partial | creation_to_task_within_60s_pct=100، verification_to_receipt_s_p95=0.35، escalation_to_editor_s=3.48، escalation_to_admin_s=6.23 | 2026-10-19 | 3 | `docs/measurements/acceptance/2026-10-19-receipt-notification-chain-and-escalation-2.json` |
| session-revocation | acceptance | — | ◐ partial | criterion_proposed_s=5، single_access_refused_s=0.01، single_refresh_refused_s=0.01، single_listed_after=false | 2026-10-20 | 2 | `docs/measurements/acceptance/2026-10-20-session-revocation-api-and-tusd-2.json` |
| tenant-isolation | acceptance | — | ◐ partial | cases_executed=229، cases_failed=0، cases_unimplemented=0 | 2026-10-19 | 4 | `docs/measurements/acceptance/2026-10-19-tenant-isolation-live-3.json` |
| upload-resume | acceptance | loopback | ◐ partial | size_bytes=67108864، interruptions=3، resent_pct=0، sha256_match=true | 2026-10-19 | 3 | `docs/measurements/acceptance/2026-10-19-upload-resume-64mb-3.json` |
| field-network-upload | netlab | field-switch | ◐ partial | upload_complete=true، checksum_match=true | 2026-10-19 | 1 | `docs/measurements/netlab/2026-10-19-tusd-field-switch-500mb.json` |
| field-network-upload | netlab | field-weak | ◐ partial | upload_complete=false، checksum_match=false | 2026-10-19 | 1 | `docs/measurements/netlab/2026-10-19-tusd-field-weak-500mb.json` |
| field-network-upload | netlab | office | ◐ partial | upload_complete=true، checksum_match=true | 2026-10-19 | 1 | `docs/measurements/netlab/2026-10-19-tusd-office-500mb.json` |
| — | other | — | ✅ pass | rotation_total_s=14.9، api_recreate_s=11.6، hook_outage_window_s=1، probes_total=151 | 2026-10-19 | 2 | `docs/measurements/ops/2026-10-19-rotate-tusd-hook-secret-previous.json` |
| media-ingest-2min-1080p | other | — | ◐ partial | probe_s=0.45، sha256_and_fingerprint_s=0.28، sha256_mb_per_s=862.2، proxy_480p_s=12.78 | 2026-10-19 | 1 | `docs/measurements/media/2026-10-19-ingest-2min-1080p.json` |
| proxy-av-sync | render-bench | — | ✅ pass | threshold_ms=40، ffmpeg_version=8.0.1، cases_run=3، cases_defined=3 | 2026-10-19 | 1 | `docs/measurements/render-bench/2026-10-19-proxy-av-sync.json` |
