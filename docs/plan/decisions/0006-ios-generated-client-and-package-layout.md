# 0006 — iOS: عميل API مولَّد بـ openapi-generator (swift6) وحزمة SwiftPM ومشروع XcodeGen

- الحالة: مقبول
- التاريخ: 2026-10-19
- المسؤول: وكيل iOS
- بند ملحق القرارات: «مشترك بين التطبيقين» (عميل API مولَّد آليًا من مواصفة OpenAPI)

## السياق

قاعدة المستودع: نماذج البيانات تُولَّد من `contracts/openapi.yaml` ولا تُكتب يدويًا. العقد OpenAPI 3.1 بإحالات خارجية
(`$ref: ./schemas/upload-form.json`) ومسار داخلي (`/internal/tusd-hooks/{hook_token}`، `x-internal`) لا يُولَّد له عميل (SEC-06).
يلزم أيضًا تشغيل اختبارات الوحدة دون جهاز Apple حيثما أمكن، لأن وكيل iOS يعمل في حاوية Linux.

## الخيارات

1. **swift-openapi-generator (Apple)** كملحق بناء: يولّد عند البناء، لكنه لا يدعم الإحالات الخارجية، ويلزم تجميع مسبق على أي حال.
2. **openapi-generator (OpenAPITools) بمولّد `swift6`** مع ناتج مُلتزم به في المستودع وفحص في CI يعيد التوليد ويشترط صفر فرق.
3. نماذج يدوية: مخالف للقاعدة.

## القرار

الخيار 2:

- `apps/ios/scripts/generate-api.sh`: `redocly bundle` بإعداد `redocly.yaml` (حل الإحالات الخارجية + `remove-x-internal`) ثم
  `prepare-spec.mjs` ثم openapi-generator 7.26.0 (`swift6`، `urlsession`، `AsyncAwait`، `enumUnknownDefaultCase`). الناتج في
  `apps/ios/Packages/PostHistoryKit/Sources/PostHistoryAPI` ولا يُعدَّل يدويًا؛ وظيفة `api-client` في `ios.yml` تعيد التوليد وتفشل عند أي فرق.
- `prepare-spec.mjs` لا يغيّر معنى العقد للعميل، بل يلتف على ثلاث فجوات في المولّد مع OpenAPI 3.1، وكلها موثقة في الملف:
  حذف مسارات `/internal/*` ومخططات الخطّافات؛ رفع `$defs` في `upload-form.json` إلى مكوّنات مسمّاة (`UploadFormField`…)
  وحذف قيود `allOf` الشرطية (المولّد لا يمثّلها، والتحقق الدلالي في `FormEngine` والخادم)؛ تحويل `type` متعدد الأنواع
  (`equals`، `default`) إلى `JSONValue` وحذف `const` المنطقية.
- **الهيكل:** حزمة SwiftPM واحدة `Packages/PostHistoryKit` بأهداف منفصلة (`PostHistoryAPI` المولَّد، `AuthCore`، ثم `UploadCore` و`FormEngine`
  في التذكرة نفسها) تُبنى وتُختبر على Linux وmacOS، وتطبيق SwiftUI رقيق في `App/` يعتمد عليها. مشروع Xcode يُولَّد من `project.yml` بـ XcodeGen ولا يُلتزم به.
- **الهوية:** `AuthSession` (actor) فوق `TokenStore`؛ التنفيذ على الجهاز `KeychainTokenStore` (`kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`).
  التحديث أحادي المسار (الطلبات المتزامنة تنتظر تحديثًا واحدًا لأن رمز التحديث يُبطل عند أول استخدام)، و`AuthInterceptor` يضيف Bearer ويعيد الطلب مرة
  واحدة بعد `401`. مسارات `/auth/*` بلا معترض وبلا `Idempotency-Key` كما ينص العقد.
- **CI:** `ios.yml` بثلاث وظائف: `api-client` (Ubuntu)، `package-linux` (حاوية swift:6.1، بناء واختبار)، و`ios` (macOS: اختبارات الحزمة ثم XcodeGen وبناء التطبيق للمحاكي).

## التبعات

- أسهل: كل منطق قابل للاختبار يعيش في الحزمة ويُثبت على Linux قبل الدفع؛ تغيير العقد يظهر فورًا كفرق في الناتج المولَّد.
- أصعب: ترقية openapi-generator تعيد توليد كل الملفات (فرق كبير لكنه آلي)؛ واجهة SwiftUI لا تُترجم إلا على macOS.
- يُراجع: إن أضاف openapi-generator دعم 3.1 الكامل تُحذف التفافات `prepare-spec.mjs` المقابلة.
