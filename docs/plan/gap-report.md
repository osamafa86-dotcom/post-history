# تقرير الفجوات بين الخطة والقياسات

> ملف مولَّد آليًا بـ `node tools/gap-report.mjs`؛ لا يُحرَّر يدويًا وأي تحرير يضيع عند أول توليد.
> المصادر: قسم «اختبارات القبول» في `docs/plan/الخطة-النسخة-الثالثة.md`، وكتالوج `tools/acceptance/lib/catalog.mjs`،
> وملفات `docs/measurements/**/*.json` (الربط بـ `test_name` ثم باسم السكربت من اسم الملف)، وعمود الحزمة من
> `docs/plan/gap-analysis-2026-10.md` — وثيقة تاريخية تُقرأ ولا تُعدَّل.

## اختبارات القبول (جدول الخطة)

| اختبار القبول | السكربت | آخر قياس | الحزمة | الفجوة |
| --- | --- | --- | --- | --- |
| استئناف الرفع | `tools/acceptance/scripts/upload-resume.mjs` | 2026-10-19 — جزئي؛ ما لم يتحقق: تبديل الشبكة هنا إعادة بناء مجمّع الاتصالات على الجهاز نفسه؛ تغيّر العنوان الحقيقي يقيسه netlab والاختبار الميداني؛ الحجم 64 ميغابايت للتحق… | apps/ + infra/ | القياس الأخير جزئي |
| الرفع على شبكة ميدانية | `tools/acceptance/scripts/field-network-upload.mjs` | 2026-10-20 — جزئي؛ ما لم يتحقق: toxiproxy 2.12.0 -> nginx tusd-proxy -> tusd v2.10.1 -> MinIO (local compose). Client: apps/ios UploadCore (PostHistoryKit upload-netlab, S… | tools/ + apps/ | القياس الأخير جزئي |
| الإغلاق القسري وإعادة التشغيل | `tools/acceptance/scripts/force-quit-restart.mjs` | لا يوجد | apps/ios + apps/android | لا قياس بعد |
| الحمل المتزامن | `tools/acceptance/scripts/concurrent-load.mjs` | 2026-10-26 — جزئي؛ ما لم يتحقق: نطاق التشغيل 5x100mb-api20rps: اكتمل 5 رفعًا مع قطع واستئناف 2 منها، ثم 20 طلب/ث مستهدف على مساري الوارد والكتالوج. الذاكرة مجموع استخدام ا… | apps/api + infra/ | القياس الأخير جزئي |
| ملف غير صالح | `tools/acceptance/scripts/invalid-file.mjs` | 2026-10-26 — جزئي؛ ما لم يتحقق: عامل الوسائط: قوائم HLS وconcat بامتداد فيديو وملف مقطوع تنتهي failed بسبب invalid_file بلا مشتق ولا اتصال خارج الحاوية؛ لم يُقَس ترميز غير… | apps/api + workers/ | القياس الأخير جزئي |
| النسخة الخفيفة | `tools/acceptance/scripts/proxy-accuracy.mjs` | 2026-10-26 — جزئي؛ ما لم يتحقق: لم يُقَس: HDR بألوان صحيحة في النسخة الخفيفة، ولا ملف هاتف حقيقي (المقاطع اصطناعية من FFmpeg)؛ المصغّرتان فُحصتا وجودًا وصيغةً وغياب الوسوم… | workers/ | القياس الأخير جزئي |
| إشعار الاستلام | `tools/acceptance/scripts/receipt-notification.mjs` | 2026-10-19 — جزئي؛ ما لم يتحقق: قرار المنسّق: تعيين المشرف عند الإنشاء (الوارد الحي يرى المادة فور وصول بياناتها)، و`upload.verified` يحدّث الحالة الفنية ويُشعر المراسل با… | apps/api + workers/ | القياس الأخير جزئي |
| الحقول المتغيرة | `tools/acceptance/scripts/dynamic-fields.mjs` | 2026-10-19 — جزئي؛ ما لم يتحقق: الخادم الحي: النشر والبوابة v0 والتاريخ المقروء وإكمال المسودة القديمة وكل حالات المطابقة المشتركة عبر POST /materials؛ لم تُقدَّم نتائج ال… | contracts/ + apps/ | القياس الأخير جزئي |
| حدود الصلاحيات | `tools/acceptance/scripts/tenant-isolation.mjs` | 2026-10-19 — جزئي؛ ما لم يتحقق: 5 ثغرة توثيق في العقد مُستثناة بإذن مكتوب في waivers/tenant-isolation.json؛ v0 بلا مؤسسات: عزل المؤسسات والفهارس والنسخ المؤقتة والفواتير ي… | apps/api | القياس الأخير جزئي |
| كشف البيانات الكاشفة | `tools/acceptance/scripts/pii-leak.mjs` | 2026-10-19 — جزئي؛ ما لم يتحقق: الجزء الحي غطّى استجابات الواجهة والإشعارات والأحداث وسجلات الخادم؛ لم تُغطَّ بعد: previews-and-derivatives,exports,external-channels(push/… | workers/ + apps/ | القياس الأخير جزئي |
| القص والتصدير | `tools/acceptance/scripts/cut-export.mjs` | 2026-10-21 — جزئي؛ ما لم يتحقق: اختبار القبول «القص والتصدير» على مصادر اصطناعية بعلامات ومضة/نغمة كل ثانيتين: 1080p30 متغير المعدل ببداية 3.5 ث، و1080p25، وHEVC 10 بت HLG… | workers/ | القياس الأخير جزئي |
| الدفع المكرر | `tools/acceptance/scripts/duplicate-payment.mjs` | 2026-10-19 — جزئي؛ ما لم يتحقق: بديل مؤقت لمعيار الدفع المكرر: يقيس مفتاح منع التكرار على كل كتابة موجودة، ولا يدّعي معيار البوابة المالية (لا دفع في التأسيس) | apps/api | القياس الأخير جزئي |
| الاسترداد | `tools/acceptance/scripts/refund.mjs` | لا يوجد | apps/api | الحزمة لم تُبنَ بعد؛ لا قياس بعد |
| الحقوق والحصرية | `tools/acceptance/scripts/rights-exclusivity.mjs` | لا يوجد | apps/api | الحزمة لم تُبنَ بعد؛ لا قياس بعد |
| صرف المستحقات | `tools/acceptance/scripts/payout.mjs` | لا يوجد | apps/api | الحزمة لم تُبنَ بعد؛ لا قياس بعد |
| التعافي | `tools/acceptance/scripts/recovery.mjs` | 2026-10-26 — جزئي؛ ما لم يتحقق: ADR 0051 point-in-time restore: the latest WAL-G base backup fetched from the second provider and decrypted with the offline private key, W… | infra/ | القياس الأخير جزئي |
| التوفر | `tools/acceptance/scripts/availability.mjs` | 2026-10-22 — جزئي؛ ما لم يتحقق: ADR 0050: tools/acceptance/scripts/availability.mjs --dry-run inside infra/field-trial/smoke-trial.sh, 4 readers 50 ms apart, the kill a SI… | infra/ | القياس الأخير جزئي |
| الذكاء الاصطناعي | `tools/acceptance/scripts/ai-eval.mjs` | لا يوجد | workers/ | لا قياس بعد |
| الأداء | `tools/acceptance/scripts/performance.mjs` | 2026-10-19 — جزئي؛ ما لم يتحقق: يقيس زمن قراءة الواجهة (القائمة والتفصيل والصندوق) تحت حمل متزامن على قاعدة اصطناعية؛ البحث النصي ومعاينة مقطع 10 دقائق غير موجودين بعد فلم… | apps/api | القياس الأخير جزئي |
| تصدير القالب العاجل | `tools/acceptance/scripts/urgent-template-export.mjs` | 2026-10-21 — جزئي؛ ما لم يتحقق: تصدير القالب العاجل على مقطع دقيقتين 1080p30 (H.264 نحو 17 Mbps) بين مقدمة وخاتمة جاهزتين (3 ث لكل)، في ترميز واحد libx264 veryfast CRF 20 … | workers/ | الحزمة لم تُبنَ بعد؛ القياس الأخير جزئي |
| قاتلات المهام | `tools/acceptance/scripts/task-killers.mjs` | لا يوجد | apps/android + apps/ios | لا قياس بعد |
| مطابقة الطوابع الزمنية | `tools/acceptance/scripts/timestamp-alignment.mjs` | 2026-10-26 — جزئي؛ ما لم يتحقق: محاذاة صوتية من الطرف إلى الطرف في المكدس: نسخة هاتف 240p (تبدأ بعد الأصل بمقدار معلوم وطوابعها مصفَّرة) تُرفع أولًا ثم الأصل (30 ث بمعدل م… | workers/ | القياس الأخير جزئي |

## اختبارات إضافية من قرارات الأمن والكتالوج

ليست صفوفًا في جدول الخطة؛ مصدر كل منها مذكور في الكتالوج.

| اختبار القبول | السكربت | آخر قياس | الحزمة | الفجوة |
| --- | --- | --- | --- | --- |
| delivery-leak | `tools/acceptance/scripts/delivery-leak.mjs` | 2026-10-26 — جزئي؛ ما لم يتحقق: حزمة تسليم المشتري (أصل وصوت وخمس صور، كلها موقَّعة C2PA) على مقطعين اصطناعيين بوسوم وموقع وSEI: محتويات الحزمة، والبصمات، وبيان كل ملف بقا… | apps/api + workers/ | القياس الأخير جزئي |
| c2pa-manifest | `tools/acceptance/scripts/c2pa-manifest.mjs` | 2026-10-26 — جزئي؛ ما لم يتحقق: توقيع C2PA (ADR 0060) على مقطعين اصطناعيين بوسوم وموقع (وSEI في مقطع الهاتف) عبر مساري التصدير ومعاينة المتجر: البيان يُقرأ كاملًا بقائمة ب… | workers/ + apps/api | القياس الأخير جزئي |
| web-upload-resume | `tools/acceptance/scripts/web-upload-resume.mjs` | لا يوجد | — | لا قياس بعد |
| web-sensitivity-catalog | `tools/acceptance/scripts/web-sensitivity-catalog.mjs` | لا يوجد | — | لا قياس بعد |
| web-mobile-390 | `tools/acceptance/scripts/web-mobile-390.mjs` | لا يوجد | — | لا قياس بعد |
| web-a11y | `tools/acceptance/scripts/web-a11y.mjs` | لا يوجد | — | لا قياس بعد |
| ci-step-timings | `لا سكربت` | لا يوجد | — | لا سكربت |
| sandbox-purchase | `tools/acceptance/live/sandbox-purchase.mjs` | 2026-10-26 — جزئي؛ ما لم يتحقق: الشراء بالمزوّد التجريبي على خادم حي: مؤسسة وعضو بالواجهة، ومادة معروضة، وطلب بسعر مجمّد (100.01 USD) ومهلته، وحجز حصري 15 دقيقة، وصفحة الد… | — | القياس الأخير جزئي |
| payout-concurrent | `tools/acceptance/live/payout-concurrent.mjs` | 2026-10-26 — جزئي؛ ما لم يتحقق: طلبات صرف متزامنة فوق المتاح لا تُقبل إلا بقدر المتاح: خمسة طلبات بـ2000 معًا ثم طلبان بـ4000 معًا على رصيد محرَّر من بيعة تجريبية؛ القبول … | — | القياس الأخير جزئي |
| refund-after-payout | `tools/acceptance/live/refund-after-payout.mjs` | 2026-10-26 — جزئي؛ ما لم يتحقق: استرداد بعد الصرف: حصة المراسل من بيعة تجريبية تُحرَّر وتُطلب وتُعتمد وتُصرف بالقناة التجريبية (طلب، موافقة، معالجة، مصروف بأحداثها)، ثم يُ… | — | القياس الأخير جزئي |
| web-buyer-checkout | `tools/acceptance/scripts/web-buyer-checkout.mjs` | 2026-10-26 — جزئي؛ ما لم يتحقق: شراء تجريبي كامل عبر الواجهة في متصفح حقيقي: الكتالوج ← ترخيص ← سلة ← طلب بانتظار الدفع ← صفحة المزوّد المستضافة ← طلب مدفوع ← ترخيص جديد ب… | — | القياس الأخير جزئي |
| web-invite-conflict | `tools/acceptance/scripts/web-invite-conflict.mjs` | 2026-10-26 — جزئي؛ ما لم يتحقق: طابور تعارض الدعوات من الخارج: دعوتان ببريدَي حسابين قائمين وثالثة ببريد جديد بالجواب نفسه شكلًا وحالةً (لا كشف لوجود حساب)، والطابور لمدير… | — | القياس الأخير جزئي |
| session-revocation | `tools/acceptance/scripts/session-revocation.mjs` | 2026-10-20 — جزئي؛ ما لم يتحقق: «خلال ثوانٍ» حُوِّل إلى رقم مقترح: ≤ 5 ث من رد استدعاء الإبطال إلى أول رفض (القيم المقيسة في المقاييس، -1 = لم يُرفض ضمن 15 ث)؛ الرفع الجار… | apps/api + apps/ | القياس الأخير جزئي |
| field-upload-1gb | `tools/acceptance/scripts/field-upload-1gb.mjs` | لا يوجد | apps/ + infra/ | لا قياس بعد |
| notification-delivery | `tools/acceptance/scripts/notification-delivery.mjs` | 2026-10-26 — جزئي؛ ما لم يتحقق: 20 مادة؛ زمن الوصول بالاستطلاع كل 150 مللي ثانية؛ أقل من 20 جولة أو بلا التصعيد أو الأحداث أو مشرف المكتب الآخر فلا pass | apps/api + workers/ | القياس الأخير جزئي |
| reservation-conflict | `tools/acceptance/scripts/reservation-conflict.mjs` | 2026-10-26 — ناجح | apps/api | مغلق بحسب آخر قياس |
| optimistic-concurrency | `tools/acceptance/scripts/optimistic-concurrency.mjs` | 2026-10-26 — ناجح | apps/api | مغلق بحسب آخر قياس |
| admin-quorum | `tools/acceptance/scripts/admin-quorum.mjs` | 2026-10-26 — ناجح | apps/api | مغلق بحسب آخر قياس |
| download-url | `tools/acceptance/scripts/download-url.mjs` | 2026-10-26 — جزئي؛ ما لم يتحقق: الانتهاء الفعلي لم يُنتظر (DL_WAIT_EXPIRY=1)؛ فلا pass | apps/api | القياس الأخير جزئي |
| transcript-draft | `tools/acceptance/scripts/transcript-draft.mjs` | 2026-10-26 — جزئي؛ ما لم يتحقق: 4 مقطع اصطناعي بكلام عربي (كلام حقيقي عام: FLEURS مثبّت ببصمته) ومقطع لمادة موسومة بالحساسية؛ لا دقة كلمات هنا (ذلك tools/asr-bench) ولا تس… | workers/ | القياس الأخير جزئي |
| reporter-identity-access | `tools/acceptance/scripts/reporter-identity-access.mjs` | 2026-10-26 — ناجح | apps/api | مغلق بحسب آخر قياس |
| emergency-wipe | `tools/acceptance/field/emergency-wipe.md` | لا يوجد | — | لا قياس بعد |
| upload-contract | `tools/acceptance/scripts/upload-contract.mjs` | لا يوجد | — | لا قياس بعد |
| outbox-transaction | `tools/acceptance/scripts/outbox-transaction.mjs` | لا يوجد | — | لا قياس بعد |
| material-state-independence | `tools/acceptance/scripts/material-state-independence.mjs` | لا يوجد | — | لا قياس بعد |
| sensitive-material-visibility | `tools/acceptance/scripts/sensitive-material-visibility.mjs` | لا يوجد | — | لا قياس بعد |
| stripe-webhook | `tools/acceptance/scripts/stripe-webhook.mjs` | 2026-10-26 — جزئي؛ ما لم يتحقق: مزوّد Stripe في وضع الاختبار على بيئة محلية (لا مال حقيقي)؛ صفوف الحقوق والملف المتحقق مزروعة بـSQL لغياب عامل الوسائط؛ تشغيل واحد. يقيس ال… | — | القياس الأخير جزئي |
| invite-conflict-totp | `tools/acceptance/scripts/invite-conflict-totp.mjs` | 2026-10-26 — جزئي؛ ما لم يتحقق: بيئة محلية بمستخدمين اصطناعيين وتشغيل واحد؛ لا يُنتَظر انتهاء نافذة الحد (15 دقيقة افتراضيًا) فيُقاس القطع لا التعافي | — | القياس الأخير جزئي |

## الخلاصة

- جدول الخطة: 22 اختبارًا، 0 مغلقًا بحسب آخر قياس، 16 بقياس جزئي، 0 بقياس فاشل، 6 بلا قياس، 4 ينتظر حزمته.
- الإضافية: 28 اختبارًا، 4 مغلقًا بحسب آخر قياس، 13 بقياس جزئي، 0 بقياس فاشل، 10 بلا قياس، 0 ينتظر حزمته.
- قياسات لا ترتبط باختبار قبول في الكتالوج: 52 (نتائج أدوات أخرى كـ netlab وasr-bench، وليست فجوات).
