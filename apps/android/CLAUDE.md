# apps/android — تطبيق المراسلين (Android)

المالك: وكيل أندرويد. الحد الأدنى Android 10 (API 29) بانتظار قياس توزيع الأجهزة. للمراسلين والطاقم فقط في الإصدار الأول.

## التقنية

- Kotlin + Jetpack Compose، Room لقائمة الانتظار، FCM، Android Keystore، BiometricPrompt، Play Integrity، Media3 (Transformer وExoPlayer).
- عميل API مولَّد من `contracts/openapi.yaml`.

## نواة الرفع (وثيقة مشتركة مع iOS: `docs/plan/upload-core.md`)

- Android 14+: مهمة نقل يبدؤها المستخدم (UIDT)، معفاة من حصص المهام التي تفرضها Android 16 حتى على المنطلقة من خدمة أمامية.
- Android 10–13: خدمة أمامية بلا مهلة نظامية (حد الست ساعات لـ `dataSync` يخص التطبيقات المستهدفة لـ Android 15+). التهديد الفعلي هناك قاتلات المهام لدى المصنّعين.
- شاشة تهيئة بحسب المصنّع (Xiaomi وSamsung أولًا): توجيه إلى إعدادات استثناء البطارية **دون** طلب صلاحية `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` التي تقيدها سياسة Google Play، والتشغيل التلقائي، والتطبيقات النائمة.
- على أساس عميل tus الجاهز للمنصة؛ حجم جزء ثابت لكل جلسة من قياس الشبكة عند البدء.
- النسخة الخفيفة بـ Media3 Transformer بثلاثة أوضاع، مع حفظ `start_pts` الأصلي.

## قواعد الحزمة

- Photo Picker وقراءة الملف كتيار بيانات دون نسخة مضغوطة.
- حذف بعد إيصال الاستلام قرار المراسل؛ مسح طارئ؛ إخفاء المحتوى في قائمة التطبيقات الأخيرة.
- لا إحداثيات دقيقة تخرج إلا مشفرة واختيارية.
- كل نص في ملفات موارد بالعربية والإنجليزية.
- اختبارات Espresso، وسكربت اختبار ميداني على جهازي Xiaomi وSamsung بعد قفل الشاشة 30 دقيقة، ونتائجه بمخطط `measurement.json` في `docs/measurements/android-app/`.

## بنية المشروع (الحالة بعد الطلبين الأول والثاني)

- `api/` — العميل المولَّد في البناء من `contracts/openapi.yaml` (OpenAPI Generator، Kotlin + OkHttp + Moshi، دوال معلّقة). لا ملف مصدر مكتوب يدويًا فيه؛ انظر ADR 0008 لمهمة `prepareContractView`.
- `core/` — Kotlin صِرف يُختبر على JVM: `FormValidator` (قواعد `form-conformance` نفسها، 57/57)، و`AuthManager` (الدخول، تدوير رمز التحديث مرة واحدة للطلبات المتزامنة، الإبطال)، ونواة الرفع: `UploadEngine` (آلة حالات تُحفظ بعد كل طلب أكّده الخادم: بصمة على الجهاز → `POST /uploads` بمفتاح ثابت → إنشاء tus → استئناف من `HEAD` → انتظار الإيصال) و`TusTransport` فوق `tus-java-client`. اختبارات الاستئناف بخادم tus مزيّف: قطع في منتصف الطلب، 5xx، قتل العملية ثم تشغيل جديد، انتهاء الرمز، اختلاف البصمة.
- `app/` — Compose: الدخول، الحساب، مادة جديدة (الحقول الثابتة + النموذج الديناميكي + الملف الأصلي من Photo Picker بصلاحية دائمة دون نسخ)، قائمة الرفع (التقدم، رقم الإيصال، إعادة المحاولة، تذكير بارز بحذف النسخة المحلية بقرار المراسل)، وشاشة تهيئة قاتلات المهام بحسب المصنّع (`ui/setup/TaskKillerGuide.kt`؛ بلا `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`). المضيف: `UploadJobService` (UIDT، أندرويد 14+) و`UploadForegroundService` (`dataSync`، 10–13) و`BootReceiver` (10–13). الطابور في Room (`data/UploadDatabase.kt`) ورمز الرفع مختوم بـ `KeystoreSealer`. الإشعارات بلا اسم ملف ولا عنوان. النصوص في `res/values` (عربية افتراضية) و`res/values-en`؛ `MissingTranslation` خطأ في lint.
- البناء محليًا: `cd apps/android && ./gradlew :core:test :app:assembleDebug :app:lintDebug` (يحتاج Android SDK 36 وJDK 17+). عنوان الخادم بـ `-PapiBaseUrl=https://…/v1` للإصدار؛ debug يشير إلى `http://10.0.2.2:3000/v1`.
- CI: `.github/workflows/android.yml` يبني ويختبر ويشغّل الحكم المشترك على `core/build/form-conformance/android.json`.
- SEC-01 (جانب الجهاز): `security/DeviceWipe.kt` فوق `core/security/WipeSequence` — مسح طارئ بتأكيد صريح يعمل دون اتصال، ومسح تلقائي بعد 401 على التجديد (الإبطال عن بُعد) مع إيقاف الرفع عند الجزء التالي وشاشة «أُبطلت جلستك»؛ لا سجلات.
- القياس على netlab: وحدة `netlab-runner` (UploadEngine على JVM) تُقاس بـ `tools/netlab/netlab.py run --client-cmd` عبر `apps/android/netlab/measure.sh` (المقاييس والمرجع والحكم كلها من netlab؛ ADR 0007)؛ سير العمل `netlab-android` (office قصير على الطلبات، القياس الكامل بـ `workflow_dispatch`)؛ النتائج في `docs/measurements/netlab/`. حجم طلب PATCH يتكيّف مع السرعة المرصودة (`core/upload/RequestSizer.kt`: نحو 40 ثانية للطلب بين 256 كيلوبايت وحجم جزء الجلسة)، وإزاحة `HEAD` تقدّم مؤكَّد يعيد التراجع إلى أقصره (ADR 0010).
- الاختبار الميداني: `apps/android/docs/field-test-android.md` (يكمّل ورقتَي الجودة `task-killers` و`force-quit-restart`).
- مؤجَّل: الوسيط على الجهاز (Media3 Transformer)، قفل BiometricPrompt، FCM، Play Integrity، اختبارات Espresso.
