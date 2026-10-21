# apps/ios — تطبيق المراسلين (iOS)

المالك: وكيل iOS. الحد الأدنى iOS 17. للمراسلين والطاقم فقط في الإصدار الأول (لا شراء ولا تصفح للمشترين).

## الهيكل والأوامر

- `Packages/PostHistoryKit/` حزمة SwiftPM (تُبنى وتُختبر على Linux وmacOS): `PostHistoryAPI` مولَّد من العقد (لا يُعدَّل يدويًا)، `AuthCore` (الهوية وKeychain)، `UploadCore` (نواة الرفع، ADR 0009، `docs/plan/upload-core.md`)، `FormEngine` (التحقق المشترك؛ `swift run form-conformance` يكتب ios.json لـ `form-conformance/run.mjs --compare`)، `DeviceSecurity` (المسح الطارئ، SEC-01؛ ADR 0009 القسم الثالث)، `DeviceAttestation` (App Attest ورمز بوابة ingest، SEC-07؛ ADR 0009 القسم الرابع)، والهدف التنفيذي `upload-netlab` (قياس النواة ضد `tools/netlab` على Linux عبر `netlab.py --client-cmd`؛ النتائج في `docs/measurements/netlab/*-ios-core-*.json`؛ سير العمل `netlab-ios`).
- `docs/field-test-ios.md` سكربت الاختبار الميداني على جهاز فعلي (يجريه المشرف الميداني).
- `App/` تطبيق SwiftUI رقيق؛ مشروع Xcode يُولَّد: `cd apps/ios && xcodegen generate` (ADR 0009).
- `scripts/generate-api.sh` بعد كل تغيير في `contracts/openapi.yaml`؛ CI يفشل إن اختلف الناتج.
- الاختبارات: `cd Packages/PostHistoryKit && swift test` (مع `TUSD_URL=http://127.0.0.1:8080/files/` يُشغَّل تكامل tusd الحي). النصوص في `App/Resources/Localizable.xcstrings` (ar/en).

## التقنية

- Swift + SwiftUI، SwiftData لقائمة الانتظار دون اتصال، APNs، Keychain، Face ID/Touch ID، App Attest، Live Activities.
- عميل API مولَّد من `contracts/openapi.yaml`.

## نواة الرفع (وثيقة مشتركة مع أندرويد: `docs/plan/upload-core.md`)

- **المسار الأساسي:** tus 1.0 عبر جلسة URLSession خلفية، على أساس مكتبة tus الجاهزة للمنصة. أجزاء كبيرة (مئات الميغابايت) في الخلفية لأن إيقاظ التطبيق بعد كل جزء صغير يخضع لميزانية الطاقة؛ أجزاء صغيرة في المقدمة. نافذة محدودة من الأجزاء وبصماتها على القرص.
- **تجربة:** مهمة URLSession واحدة بمسودة IETF (iOS 17، المسودة -01) ضد tusd بالعلم التجريبي. سجّل إصدار التوافق ونتيجة الاستئناف الخلفي على جهاز فعلي في `docs/measurements/ios-app/`. تُرقَّى إلى أساسي إن نجحت.
- حجم الجزء ثابت لكل جلسة من قياس الشبكة عند البدء. الوعد للمراسل: الاستئناف من آخر ما وصل، لا الاستمرار بعد الإغلاق القسري.
- النسخة الخفيفة بـ AVFoundation بثلاثة أوضاع (عاجل 360p، عادي 540p، الأصل فقط)، مع حفظ `start_pts` الأصلي في البيانات الوصفية.

## قواعد الحزمة

- اختيار الملف الأصلي غير المضغوط من PhotosUI؛ لا نسخة مصدّرة.
- حذف النسخة المحلية بعد إيصال الاستلام قرار المراسل؛ مسح طارئ للقائمة المحلية؛ إخفاء المحتوى في قائمة التطبيقات الأخيرة.
- لا إحداثيات دقيقة تخرج من الجهاز إلا مشفرة واختيارية؛ المحافظة والمدينة فقط افتراضيًا.
- كل نص في ملفات موارد بالعربية والإنجليزية.
- اختبارات XCUITest، وسكربت اختبار ميداني يجريه المشرف الميداني على أجهزة فعلية ويكتب نتيجته بمخطط `measurement.json`.
