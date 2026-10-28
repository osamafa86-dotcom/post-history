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
- `app/` — Compose: الدخول، الحساب، مادة جديدة (الحقول الثابتة + النموذج الديناميكي + الملفات الأصلية من Photo Picker حتى 20 بصلاحية دائمة دون نسخ، ومادة مستقلة لكل ملف بالبيانات نفسها وعنوانها `(i/N)`؛ ADR 0082)، قائمة الرفع (لا حذف بالسحب: زر إلغاء/إزالة بحوار تأكيد، والتقدم، رقم الإيصال، إعادة المحاولة، تذكير بارز بحذف النسخة المحلية بقرار المراسل)، وشاشة تهيئة قاتلات المهام بحسب المصنّع (`ui/setup/TaskKillerGuide.kt`؛ بلا `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`). المضيف: `UploadJobService` (UIDT، أندرويد 14+) و`UploadForegroundService` (`dataSync`، 10–13) و`BootReceiver` (10–13). الطابور في Room (`data/UploadDatabase.kt`) ورمز الرفع مختوم بـ `KeystoreSealer`. الإشعارات بلا اسم ملف ولا عنوان. النصوص في `res/values` (عربية افتراضية) و`res/values-en`؛ `MissingTranslation` خطأ في lint.
- البناء محليًا: `cd apps/android && ./gradlew :core:test :app:assembleDebug :app:lintDebug` (يحتاج Android SDK 36 وJDK 17+). عنوان الخادم للإصدار `apiBaseUrl=https://…/v1`، يُمرَّر بـ `-P` أو في `gradle.properties` أو في `API_BASE_URL`. `preReleaseBuild` يرفض غير https. debug يشير إلى `http://10.0.2.2:3000/v1`.
- الإصدار عبر `appstore-release` (`apps/postlibrary.yml`):
  - يضيف خطوة `prepare` سطر `apiBaseUrl` إلى `gradle.properties`، ثم يشغّل `:core:test` و`:app:bundleRelease`.
  - رقم النسخة ومفتاح الرفع من `APP_VERSION_CODE` و`APP_KEYSTORE*`.
  - بيانات المتجر في `store/metadata/android/`.
  - `-PplayCloudProjectNumber` وقيم Firebase (`-PfcmAppId` و`fcmApiKey` و`fcmProjectId` و`fcmSenderId`) اختيارية للبناء. بدون الأول لا رفع عبر البوابة، وبدون الثانية لا دفع.
- CI: `.github/workflows/android.yml` يبني ويختبر ويشغّل الحكم المشترك على `core/build/form-conformance/android.json`.
- SEC-01 (جانب الجهاز): `security/DeviceWipe.kt` فوق `core/security/WipeSequence` — مسح طارئ بتأكيد صريح يعمل دون اتصال، ومسح تلقائي بعد 401 على التجديد (الإبطال عن بُعد) مع إيقاف الرفع عند الجزء التالي وشاشة «أُبطلت جلستك»؛ لا سجلات.
- القياس على netlab: وحدة `netlab-runner` (UploadEngine على JVM) تُقاس بـ `tools/netlab/netlab.py run --client-cmd` عبر `apps/android/netlab/measure.sh` (المقاييس والمرجع والحكم كلها من netlab؛ ADR 0007)؛ سير العمل `netlab-android` (office قصير على الطلبات، القياس الكامل بـ `workflow_dispatch`)؛ النتائج في `docs/measurements/netlab/`. حجم طلب PATCH يتكيّف مع السرعة المرصودة (`core/upload/RequestSizer.kt`: نحو 40 ثانية للطلب بين 256 كيلوبايت وحجم جزء الجلسة)، وإزاحة `HEAD` تقدّم مؤكَّد يعيد التراجع إلى أقصره (ADR 0010).
- الاختبار الميداني: `apps/android/docs/field-test-android.md` (يكمّل ورقتَي الجودة `task-killers` و`force-quit-restart`).
- بوابة ingest (SEC-07، ADR 0011): الجلسة التي `ingest_token_required` فيها صحيح ترسل `Ingest-Token` على كل طلب tus. `core/upload/IngestTokens.kt` يطلب تحديًا ثم حكم Play Integrity القياسي على `requestHash = base64url(SHA-256(challenge ‖ session_id))` ثم `POST /uploads/{id}/ingest-token`، ويخزّن الرمز لكل جلسة ويجدده قبل انتهائه بدقيقة أو بعد 401 من البوابة (ثم `HEAD`). الجهاز الذي لا يُشهد له يفشل بـ `DEVICE_NOT_TRUSTED`. `app/upload/PlayIntegrityAttester.kt` بـ `-PplayCloudProjectNumber=<رقم مشروع Cloud المربوط في Play Console>`؛ بدونه لا مشهِد. النسخة المثبتة من خارج Play لا ترفع.
- الإشعارات (FCM):
  - تُهيّأ من خاصيات البناء، بلا `google-services.json`.
  - التسجيل بـ `PUT /push-devices` بمعرّف تثبيت يولّده التطبيق، ويُلغى عند الخروج والمسح.
  - الإشعار يعرض رقم المادة وحالتها فقط، ولا شيء على شاشة القفل.
  - شاشة الإشعارات فيها القراءة والإقرار.
- «موادي» (`ui/material/`): الحالات الثلاث في أسطر منفصلة.
- مراجعة المشرف (`ui/review/`):
  - الوارد بالحالة التحريرية، وقرارات المسار التحريري بسبب إلزامي و`Idempotency-Key` و`If-Match`.
  - لا إحداثيات ولا هوية مراسل.
- أنواع الملفات والأدوار تُطابق بقيمة العقد، وفيها `else`، فلا يكسر العقد الأحدث البناء.
- نظام التصميم (#387):
  - **الرموز:** `:app:generateDesignTokens` يولّد `ui/theme/tokens/DesignTokens.kt` من `docs/design/tokens.json` في كل بناء. لا قيم ألوان أو مسافات مكتوبة يدويًا.
  - **الثيم والمكوّنات:** `ui/theme/Theme.kt` (`Vl.colors` و`Vl.text`، ووضعان) و`ui/theme/Components.kt` (الشارات والأزرار والبطاقة ومؤشر الخطوات).
  - **الخطوط:** مضمّنة في `res/font/`، والمصدر والترخيص في `docs/fonts.md`.
- تدفق المراسل:
  - **A1 مادة جديدة:** أربع خطوات، ومسودات في Room v3، ونموذج محفوظ للعمل دون شبكة.
  - **A2 الرفع:** أجزاء مؤكَّدة، وزمن متبقٍ، وإيقاف مؤقت، وWi‑Fi فقط.
  - **A3 الإيصال:** رمز QR بـ `-PwebBaseUrl`، وصورة للمشاركة، وقرار النسخة المحلية.
  - **A4 موادي:** خط زمني بثلاثة مسارات، والرد على المشرف بالانتقال `needs_changes → reviewing`.
- مؤجَّل ما لم يُطلب: الوسيط على الجهاز (Media3 Transformer)، قفل BiometricPrompt، اختبارات Espresso. شاشة «أرباحي» وطلبات الصرف التجريبية في ui/earnings/ وفق ADR 0033 و#420؛ للمراسل فقط، بالعميل المولّد، ولا قناة حقيقية أو بيانات بنك. تفاصيلها في docs/earnings.md.
