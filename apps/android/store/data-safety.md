# أجوبة نموذج «أمان البيانات» في Google Play — تطبيق أندرويد
# Google Play "Data safety" form answers — Android app

- الحالة / Status: مسودة يدخلها المالك في Play Console ثم تُراجَع قبل كل تقديم؛ لا تدّعي اعتمادًا من Google. / A draft the owner enters in Play Console and re-checks before every submission; it does not claim Google approval.
- آخر مطابقة للكود / Last matched to the code: 2026-10-27، `versionName` 0.1.0، `targetSdk` 36.
- المرجع / Reference: Issue #307، المهمة 7 / task 7. تطابق iOS في `apps/ios/store/app-privacy.md`.
- لا بريد ولا نطاق ولا عنوان IP في هذه الوثيقة. بريد التواصل هو «بريد التواصل في سياسة الخصوصية» / "the contact email in the privacy policy".
- كل جواب مرفق بمصدره في المستودع. ما لا مصدر له لم يُكتب. وما احتاج قرار المالك مُعلَّم **[OC-n]** ومجمَّع في القسم 7. / Every answer cites its repo source. Nothing without a source is claimed. Items needing the owner's decision are marked **[OC-n]** and collected in section 7.

## 0. مفاتيح المصادر / Source keys

| المفتاح / Key | المصدر / Source |
| --- | --- |
| P1…P12 | سياسة الخصوصية المدمجة `privacy.sections[0..11]` في `apps/web/messages/ar.json` و`en.json` (بالترتيب: 1 من يشغّل المنصة، 2 البيانات التي نجمعها، 3 الملف الأصلي والموقع الدقيق، 4 كيف نستخدم بياناتك، 5 إشعارات الهاتف، 6 من يطّلع على المواد، 7 الذكاء الاصطناعي والمزوّدون الخارجيون، 8 الترخيص للمؤسسات المشترية، 9 المدفوعات في هذه المرحلة، 10 الاحتفاظ والحذف والنسخ الاحتياطي، 11 الأمان، 12 حقوقك وكيف تتواصل معنا) / The merged privacy policy, same order in both languages |
| I1…I3 | `apps/ios/store/app-privacy.md` الأقسام 1 و2 و3 / sections 1, 2, 3 |
| R | `docs/research/2026-10-store-review-requirements.md` (أقسام «جوجل» و«قائمة تحقق قابلة للتنفيذ») |
| M | `apps/android/app/src/main/AndroidManifest.xml` |
| K | `contracts/openapi.yaml` (مخططات `LoginRequest` و`Session` و`MaterialCreate` و`DisplayName` و`UploadSessionCreate` و`PushDeviceRegistration` و`PayoutRequestCreate`) |
| A:ملف / A:file | شيفرة أندرويد تحت `apps/android/`؛ المسار نسبي إلى `app/src/main/kotlin/net/palpost/library/` ما لم يبدأ بـ`core/` أو `app/` / Android code; paths relative to `app/src/main/kotlin/net/palpost/library/` unless prefixed |
| ADR61 | `docs/plan/decisions/0061-android-upload-resilience-and-privacy-review.md` (Issue #307) |

## 1. أسئلة النموذج العامة / General form questions

| السؤال / Question | الجواب / Answer | المصدر / Source |
| --- | --- | --- |
| هل يجمع تطبيقك أو يشارك أيًّا من أنواع بيانات المستخدم المطلوبة؟ / Does your app collect or share any of the required user data types? | نعم / Yes | القسم 2 / section 2؛ P2، I1 |
| هل كل البيانات المجمعة مشفرة أثناء النقل؟ / Is all of the user data collected by your app encrypted in transit? | نعم / Yes. التطبيق يمنع HTTP النصي لكل المضيفات (`cleartextTrafficPermitted="false"`)، وبناء الإصدار يرفض أي عنوان خادم لا يبدأ بـ`https://`. / The release app blocks cleartext HTTP for all hosts and the release build refuses a non-https server address. | A:`res/xml/network_security_config.xml`؛ `app/build.gradle.kts` (مهمة `preReleaseBuild`)؛ P11 («اتصال مشفر») |
| هل توفّرون وسيلة لطلب حذف البيانات؟ / Do you provide a way for users to request that their data is deleted? | نعم / Yes — بطلب عبر بريد التواصل في سياسة الخصوصية. **لا يوجد حذف من داخل التطبيق.** / On request through the contact email in the privacy policy. **There is no in-app deletion.** | P10، P12 |
| رابط طلب الحذف / Deletion request link | يُدخل المالك في Play Console رابط صفحة سياسة الخصوصية العامة (قسم «حقوقك وكيف تتواصل معنا»)؛ لا يُكتب هنا. / The owner enters the public privacy policy page link in Play Console; it is not written here. | P12؛ **[OC-11]** |
| ما يُحتفظ به بعد طلب الحذف / What stays after a deletion request | الأصل بلا مدة حذف تلقائية ما دام الأرشيف قائمًا؛ وسجل التدقيق وقيود دفتر الأستاذ وسجلات البيع والفواتير إلحاقية؛ والنسخ الاحتياطية المشفرة حتى انتهاء مدتها. / Originals have no automatic deletion period while the archive operates; the audit log, ledger entries, sales records and invoices are append-only; encrypted backups remain until their retention ends. | P10، P12 |
| مراجعة أمنية مستقلة (اختيارية) / Independent security review (optional) | لا يُدّعى. لا مصدر في المستودع. / Not claimed. No source in the repo. | — |
| هل تُباع البيانات أو تُستخدم للإعلان؟ / Sold or used for advertising? | لا / No. لا بيع، ولا إعلان، ولا معرّف إعلانات، ولا تتبع عبر تطبيقات أخرى. / No selling, no advertising, no advertising ID, no cross-app tracking. | P4، P2 («لا يجمع التطبيقان معرّف الإعلانات»)، I1. انظر **[OC-1]** و**[OC-10]** |

## 2. أنواع البيانات / Data types

مفتاح الأعمدة / Column key: **يُجمع** Collected — **يُشارك** Shared — **الاختيار** Required or Optional — **المعالجة العابرة** Ephemeral = لا في كل الصفوف، فالبيانات تُخزَّن على خوادم الجهة المشغّلة / No in every row, data is stored on the Operator's servers.
الأغراض بمصطلحات النموذج / Purposes use the form's terms: App functionality، Account management، Fraud prevention, security, and compliance. لا أحد من الأغراض Analytics وAdvertising or marketing وPersonalization وDeveloper communications ينطبق على أي صف / None of Analytics, Advertising or marketing, Personalization or Developer communications applies to any row (P4، I1).

### 2.1 الموقع / Location

| النوع / Type | يُجمع | يُشارك | الاختيار | الأغراض | المصدر |
| --- | --- | --- | --- | --- | --- |
| الموقع الدقيق / Precise location | نعم / Yes **[OC-3]** | لا / No | إلزامي / Required | App functionality | P3، I2 |
| الموقع التقريبي / Approximate location | نعم / Yes **[OC-2]** | نعم، المحافظة وحدها للمؤسسات المشترية في الكتالوج، والمدينة لا تُشارك / Yes, the governorate only, to buyer organizations in the catalog; the city is not shared | إلزامي / Required | App functionality | A:`ui/material/NewMaterialScreen.kt`، K:`MaterialCreate`، P2 |

**العربية.** الموقع الدقيق يُجمع لوظيفة التطبيق ولا يُستعمل للتتبع (P3). مصدره في أندرويد هو ما يحمله **الملف الأصلي** في بياناته الوصفية: يُرفع كما سجّلته الكاميرا بلا ضغط ولا تجريد، حفاظًا على بصمة SHA-256، ويُحفظ على الخادم كما وصل ولا يُعدَّل ولا يُسلَّم لأي مشترٍ، أما التجريد فيقع في المشتقات (المعاينات والمصغّرات والنسخ المسلَّمة) على الخادم (P3، I2). لا يطلب التطبيق صلاحية موقع ولا يقرأ موقع الجهاز (M: لا `ACCESS_FINE_LOCATION` ولا `ACCESS_COARSE_LOCATION` ولا `ACCESS_MEDIA_LOCATION`؛ ADR61 البند 2). لا يرسل التطبيق إحداثيات: حقل الموقع في النموذج الديناميكي غير مدعوم في أندرويد (A:`ui/forms/DynamicForm.kt`)، ولا يملأ استدعاء إنشاء المادة الحقل الاختياري `gps` (A:`NewMaterialScreen.kt`). وهو الموقع الدقيق الوحيد الذي يصل من هذا التطبيق.

**English.** Precise location is collected for the app's function and is not used for tracking (P3). On Android its only source is what the **original file** carries in its metadata: the original is uploaded exactly as the camera recorded it, without compression or stripping, to preserve its SHA-256 fingerprint; it is stored on the server as it arrived, never modified and never delivered to any buyer, while stripping happens in the server-made derivatives (previews, thumbnails, delivered copies) (P3, I2). The app requests no location permission and does not read the device location (M: no `ACCESS_FINE_LOCATION`, `ACCESS_COARSE_LOCATION` or `ACCESS_MEDIA_LOCATION`; ADR61 item 2). The app sends no coordinates: the dynamic form's location field is unsupported on Android (`ui/forms/DynamicForm.kt`) and the create-material call leaves the optional `gps` field unset (`NewMaterialScreen.kt`).

**الموقع التقريبي / Approximate location.** المحافظة والمدينة حقلان نصيان إلزاميان يكتبهما المراسل في خطوة بيانات المادة ويُرسلان في `MaterialCreate` (`governorate` و`city`). هما مكان المادة لا قراءة من الجهاز؛ أُعلنا تحوّطًا لأن النموذج يُعرّف الموقع التقريبي بمستوى المدينة. وتظهر المحافظة وحدها للمؤسسات المشترية في الكتالوج (K:`CatalogItem.governorate`، ADR 0025)، ولا تظهر المدينة ولا أي إحداثيات. / Governorate and city are two required text fields the reporter types and the app sends in `MaterialCreate`. They describe the material's place, not a device reading; declared conservatively because the form defines approximate location at city level. Only the governorate is shown to buyer organizations in the catalog (K:`CatalogItem.governorate`, ADR 0025); the city and any coordinates are not.

### 2.2 المعلومات الشخصية / Personal info

| النوع / Type | يُجمع | يُشارك | الاختيار | الأغراض | المصدر |
| --- | --- | --- | --- | --- | --- |
| الاسم / Name | نعم، اسم مستعار اختياري / Yes, optional pseudonym **[OC-4]** | لا: النسب في الكتالوج اسم الشبكة الثابت، والمستعار لا يدخل الكتالوج (`catalog.service.ts:159-160`، `CATALOG_CREDIT`) / No: the catalog credit is the network's fixed name, and the pseudonym never enters the catalog (`catalog.service.ts:159-160`, `CATALOG_CREDIT`) | اختياري / Optional | App functionality | A:`NewMaterialScreen.kt` (`DisplayModePicker`)، K:`DisplayName`، P2 |
| البريد الإلكتروني / Email address | نعم / Yes | لا / No | إلزامي / Required | Account management | A:`ui/LoginScreen.kt`، K:`LoginRequest`، P2، I2 |
| معرّفات المستخدم / User IDs | نعم / Yes | لا / No | إلزامي / Required | Account management، App functionality | K:`Session.user_id`، A:`core/.../auth/AuthManager.kt`، I2 (Identifiers) |
| معلومات أخرى / Other info (كلمة المرور ورمز التحقق / password and verification code) | نعم / Yes **[OC-5]** | لا / No | كلمة المرور إلزامية، والرمز السداسي لمن فُعِّل له / Password required, 6-digit code where enabled | Account management | A:`ui/LoginScreen.kt`، K:`LoginRequest` (`password`، `totp_code`) |
| العنوان، الهاتف، العرق، المعتقد السياسي أو الديني، الميول الجنسية / Address, phone, race and ethnicity, political or religious beliefs, sexual orientation | لا / No **[OC-13]** | — | — | — | لا حقل ثابت في التطبيق؛ حقول نموذج المكتب يعرّفها الخادم (K:`MaterialCreate.dynamic_fields`) / no fixed field in the app; the desk form's fields are server-defined |

**العربية.** البريد يُستعمل لتسجيل الدخول فقط (حقيقة معروفة؛ P2 «وسيلة الاتصال الوحيدة»)، والتطبيق لا يطلب اسمًا حقيقيًا. لكن الكود يُظهر أمرين لم يذكرهما نص P2: (أ) الدخول يرسل أيضًا كلمة مرور ورمزًا سداسيًا اختياريًا (`LoginRequest`)؛ (ب) خيار «اسم مستعار» لاسم الظهور يحمل نصًّا يكتبه المراسل (حتى 80 حرفًا). والنموذج لا يُفرد نوعًا لكلمات المرور، فاقتُرح تحت «Other info». ولا يصل اسم الظهور إلى المشترين: النسب في الكتالوج اسم الشبكة الثابت (`CATALOG_CREDIT`). وفي وضع «الاسم الحقيقي» لا يرسل التطبيق اسمًا؛ يحدده الحساب على الخادم.

**English.** The email is used for login only (known fact; P2 "the only contact information"), and the app does not ask for a real name. The code shows two things P2's text does not mention: (a) sign-in also sends a password and an optional 6-digit code (`LoginRequest`); (b) the "pseudonym" display-name option carries text the reporter types (up to 80 characters). The form has no dedicated type for passwords, so they are proposed under "Other info". The display name does not reach buyers: the catalog credit is the network's fixed name (`CATALOG_CREDIT`). In "real name" mode the app sends no name; the account on the server decides.

### 2.3 المعلومات المالية / Financial info

| النوع / Type | يُجمع | يُشارك | الاختيار | الأغراض | المصدر |
| --- | --- | --- | --- | --- | --- |
| معلومات الدفع / User payment info | لا / No | — | — | — | تحقق من الكود أدناه / verified in code below |
| سجل المشتريات / Purchase history | لا / No | — | — | — | لا مكتبة فوترة بين التبعيات (`gradle/libs.versions.toml`) / no billing library among dependencies |
| الدرجة الائتمانية / Credit score | لا / No | — | — | — | — |
| معلومات مالية أخرى / Other financial info | نعم، مبلغ طلب صرف تجريبي فقط / Yes, a sandbox payout-request amount only **[OC-6]** | لا / No | اختياري، يضغط المراسل الزر بنفسه / Optional, the reporter taps the button | App functionality | A:`ui/earnings/EarningsViewModel.kt`، K:`PayoutRequestCreate`، P9، `apps/android/docs/earnings.md` |

**التحقق في الكود / Verified in code.** (1) `PayoutRequestCreate` يحمل حقلين فقط: `amount` (قيمة صغرى وعملة USD أو ILS) و`channel`، وقيمة `channel` الوحيدة `sandbox`، و`additionalProperties: false` (K). (2) المبلغ ليس إدخالًا حرًّا: هو **كامل `requestable`** كما أعاده الخادم (`EarningsViewModel.request`). (3) `EarningsScreen.kt` لا يحوي حقل نص: عرض أرصدة وقيود وطلبات ومرشحات وزر واحد موسوم «تجريبي». (4) لا حقل بطاقة ولا IBAN ولا حساب بنكي ولا اختيار قناة في العقد ولا في الشاشة. (5) سياسة الخصوصية: الصرف تجريبي «لا مال حقيقي ولا بيانات مصرفية» (P9). الأرصدة والقيود التي تُعرض تأتي من الخادم ولا يرسلها الجهاز.
(1) `PayoutRequestCreate` has two fields only, `amount` (minor units plus a USD or ILS currency) and `channel`, whose only value is `sandbox`, with `additionalProperties: false` (K). (2) The amount is not free input: it is the **whole `requestable`** balance as the server returned it (`EarningsViewModel.request`). (3) `EarningsScreen.kt` has no text field: it shows balances, entries, requests, filters and one button marked sandbox. (4) No card field, no bank account number and no channel choice in the contract or the screen. (5) The privacy policy says payouts are test-only, "no real money and no bank details" (P9). The balances and entries displayed come from the server; the device does not send them.

### 2.4 الصور والفيديو / Photos and videos

| النوع / Type | يُجمع | يُشارك | الاختيار | الأغراض | المصدر |
| --- | --- | --- | --- | --- | --- |
| الصور / Photos | نعم / Yes | نعم، مشتقات مجرَّدة من البيانات الكاشفة للمؤسسات المشترية / Yes, derivatives stripped of revealing data, to buyer organizations **[OC-1]** | إلزامي: لا مادة بلا أصل / Required: no material without an original | App functionality | A:`NewMaterialScreen.kt` (`PickMultipleVisualMedia` حتى 20 ملفًا للمادة الواحدة، و`PickVisualMedia.ImageAndVideo` للقطة البديلة؛ و`submit` يشترط ملفًا أصليًا واحدًا على الأقل)، P2، P8، I2 |
| الفيديو / Videos | نعم / Yes | كما أعلاه / as above | إلزامي / Required | App functionality | نفسه / same |

**العربية.** يختار المراسل الملف يدويًا من منتقي النظام فقط؛ لا كاميرا داخل التطبيق ولا صلاحية وسائط (M؛ ADR61 البند 3؛ R صف «صلاحيات الصور والفيديو»). يُرفع الأصل بلا مساس. الأصل لا يُسلَّم للمشتري؛ يتسلّم المشتري نسخًا مجرَّدة، مفحوصة قبل التسليم، بروابط موقّعة قصيرة العمر ومعاينات بعلامة مائية (P8). المواد الموسومة بالحساسية لا تُرسل إلى مزوّد خارجي أبدًا (P7).

**English.** The reporter picks the file manually through the system picker only; there is no in-app camera and no media permission (M; ADR61 item 3; R row "Photo and video permissions"). The original is uploaded untouched. The original is never delivered to a buyer; the buyer receives stripped copies, checked before delivery, with signed short-lived links and watermarked previews (P8). Material tagged as sensitive is never sent to an external provider (P7).

### 2.5 الصوت / Audio files

| النوع / Type | يُجمع | يُشارك | الاختيار | الأغراض | المصدر |
| --- | --- | --- | --- | --- | --- |
| تسجيلات الصوت / Voice or sound recordings | لا، بوصفه نوعًا مستقلًا / No, as a separate type **[OC-7]** | — | — | — | M: لا `RECORD_AUDIO`؛ A:`NewMaterialScreen.kt`: المنتقي صور وفيديو فقط |
| ملفات الموسيقى والصوت الأخرى / Music and other audio files | لا، بوصفه نوعًا مستقلًا / No, as a separate type **[OC-7]** | — | — | — | لا مسار في الكود ينشئ رفع `voice_note`؛ لا يرد إلا اسم النوع في عقد API وتسمية في `ui/material/MaterialLabels.kt` / no code path creates a `voice_note` upload; the name appears only in the API contract and a label |

**العربية.** لا يسجّل التطبيق صوتًا ولا يختار ملفات صوتية. غير أن مقاطع الفيديو المرفوعة تحمل مسارها الصوتي، ويذكر P7 أن المنصة تُجري «التفريغ النصي» آليًا. لذا قرار تمثيل هذا المسار في النموذج للمالك **[OC-7]**؛ الإعلان الحالي يعدّه جزءًا من «الفيديو».

**English.** The app records no audio and picks no audio files. The uploaded videos do carry their soundtrack, and P7 says the platform runs automated "transcription". How to represent that soundtrack in the form is the owner's decision **[OC-7]**; the current declaration treats it as part of "Videos".

### 2.6 الملفات والمستندات / Files and docs

| النوع / Type | يُجمع | يُشارك | الاختيار | الأغراض | المصدر |
| --- | --- | --- | --- | --- | --- |
| الملفات والمستندات / Files and docs | نعم، اسم الملف ونوعه وحجمه فقط / Yes, file name, type and size only **[OC-8]** | لا / No | إلزامي / Required | App functionality | K:`UploadSessionCreate` (`filename`، `mime_type`، `size_bytes`)، A:`core/.../upload/UploadEngine.kt` |

**العربية.** يرسل التطبيق اسم الملف على الجهاز ونوعه وحجمه مع إنشاء جلسة الرفع. حقول المرفقات في نموذج المكتب تحمل `{mime, size_bytes}` فقط؛ لا مسار في الكود يرفع محتوى ملف مرفق (`DynamicForm.kt` يحتفظ بالمُختار للعرض، ورفع الأصل `kind = "original"` وحده في `NewMaterialScreen.kt`). مشاركة صورة الإيصال (A3) تخرج بطلب المراسل عبر مشاركة النظام من ذاكرة التخزين المؤقت ولا تحمل موقعًا ولا أسماء (M: `FileProvider`، `res/xml/file_paths.xml`، `a3_qr_caption`).

**English.** The app sends the on-device file name, type and size when it creates the upload session. Attachment fields in the desk form carry `{mime, size_bytes}` only; no code path uploads an attachment's content (`DynamicForm.kt` keeps the picked file for display; the only upload is `kind = "original"` in `NewMaterialScreen.kt`). Sharing the receipt image (A3) happens at the reporter's request through the system share sheet from the cache and carries no location or names (M: `FileProvider`, `res/xml/file_paths.xml`, string `a3_qr_caption`).

### 2.7 نشاط التطبيق / App activity

| النوع / Type | يُجمع | يُشارك | الاختيار | الأغراض | المصدر |
| --- | --- | --- | --- | --- | --- |
| محتوى آخر من إنشاء المستخدم / Other user-generated content | نعم / Yes | نعم، عنوان المادة ووصفها وقائمة لقطاتها في الكتالوج للمؤسسات المشترية (K:`CatalogItem`) / Yes, the material's title, description and shot list in the catalog, to buyer organizations (K:`CatalogItem`) **[OC-1]** | إلزامي (العنوان وحقول المكتب الإلزامية) / Required (title and required desk fields) | App functionality | K:`MaterialCreate` (`title`، `dynamic_fields`، `sensitivity`)، A:`ui/review/ReviewScreen.kt` (سبب قرار المشرف حتى 2000 حرف)، P2 |
| تفاعلات التطبيق، سجل البحث، التطبيقات المثبتة، إجراءات أخرى / App interactions, in-app search history, installed apps, other actions | لا / No | — | — | — | لا حزمة تحليلات بين التبعيات (`gradle/libs.versions.toml`: `play-integrity` و`firebase-messaging` فقط)؛ P4، I1 / no analytics package among dependencies |

**ملاحظة / Note.** حالة قراءة الإشعار وإقراره تُحفظ على الخادم جزءًا من الوظيفة لا تحليلًا (A:`ui/notifications/NotificationsScreen.kt`؛ `apps/android/CLAUDE.md` قسم الإشعارات). / The read and acknowledged state of a notification is stored on the server as part of the function, not as analytics.

### 2.8 معلومات التطبيق وأداؤه / App info and performance

| النوع / Type | يُجمع | الجواب / Answer | المصدر |
| --- | --- | --- | --- |
| سجلات الأعطال / Crash logs | لا / No | لا Crashlytics ولا غيره بين التبعيات / no crash reporter among dependencies | `gradle/libs.versions.toml` |
| التشخيصات / Diagnostics | لا / No **[OC-9]** | لا قياسات أداء. رقم نسخة التطبيق يرافق تسجيل الإشعارات (`app_version`) ضمن سجل التسجيل لا بوصفه تشخيصًا / No performance metrics. The app version number accompanies push registration (`app_version`) as part of that record, not as diagnostics | A:`push/Push.kt`، K:`PushDeviceRegistration` |
| بيانات أداء أخرى / Other app performance data | لا / No | — | — |

### 2.9 المعرّفات / Device or other IDs

| النوع / Type | يُجمع | يُشارك | الاختيار | الأغراض | المصدر |
| --- | --- | --- | --- | --- | --- |
| معرّف التثبيت المولَّد / Generated installation ID | نعم / Yes | لا / No | إلزامي (لا مفتاح إيقاف في التطبيق) / Required (no off switch in the app) | App functionality | A:`AppSettings.kt`، K:`PushDeviceRegistration`، P2، I2 |
| رمز FCM / FCM token | نعم / Yes **[OC-9]** | لا، مزوّد خدمة / No, service provider | إلزامي كما فوق / Required as above | App functionality | A:`push/Push.kt`، P2، P5 |
| رمز سلامة التطبيق / App integrity token (Play Integrity) | نعم / Yes **[OC-9]** | لا، مزوّد خدمة / No, service provider | إلزامي لرفع الجلسات خلف بوابة الاستلام / Required for uploads behind the ingest gate | Fraud prevention, security, and compliance | A:`upload/PlayIntegrityAttester.kt`، `core/.../upload/IngestTokens.kt`، P2، ADR61 |
| معرّف الإعلانات / Advertising ID | لا / No **[OC-10]** | — | — | — | P2؛ ADR61 البند 2 (لا `ANDROID_ID` ولا `Build.SERIAL`) |

**العربية.** معرّف التثبيت UUID عشوائي يولّده التطبيق عند أول استعمال ولا يُشتق من معرّفات الجهاز (`AppSettings.installationId`)، ويُرسل مع رمز FCM إلى `PUT /push-devices` عند كل تسجيل دخول، لتنبيهات العمل والحساب فقط (P5). رفض صلاحية الإشعارات يمنع العرض ولا يمنع التسجيل (`PostHistoryApp.kt` و`Push.show`). تُهيَّأ Firebase يدويًا من خاصيات البناء ولا تجلب رمزًا قبل الدخول (M: `firebase_messaging_auto_init_enabled=false`، و`FirebaseInitProvider` محذوف). رمز Play Integrity يُرسل إلى خادمنا ويفك الخادم وحده الحكم (`PlayIntegrityAttester` وP2).

**English.** The installation ID is a random UUID the app generates on first use, not derived from device identifiers (`AppSettings.installationId`); it is sent with the FCM token to `PUT /push-devices` on each sign-in, for work and account alerts only (P5). Denying the notification permission stops display, not registration (`PostHistoryApp.kt`, `Push.show`). Firebase is initialised by hand from build settings and fetches no token before sign-in (M: `firebase_messaging_auto_init_enabled=false`, `FirebaseInitProvider` removed). The Play Integrity token is sent to our server, which alone decodes the verdict (`PlayIntegrityAttester`, P2).

### 2.10 أنواع غير مجمعة / Types not collected

| الفئة / Category | الجواب / Answer | المصدر / Source |
| --- | --- | --- |
| الصحة واللياقة / Health and fitness | لا / No | لا صلاحية ولا حقل ثابت؛ علامات الحساسية (`minors`، `injured`، `graphic`) وصف للمادة لا للمستخدم / no permission or fixed field; the sensitivity flags describe the material, not the user (K:`Sensitivity`) |
| الرسائل (بريد، SMS، رسائل التطبيق) / Messages | لا / No | M: لا `READ_SMS` ولا `RECEIVE_SMS`؛ لا دردشة / no chat |
| التقويم وجهات الاتصال / Calendar and contacts | لا / No | M: لا `READ_CALENDAR` ولا `READ_CONTACTS`؛ I3 |
| تصفح الويب / Web browsing | لا / No | لا متصفح مدمج في الكود / no embedded browser in the code |

## 3. التتبع والمشاركة / Tracking and sharing

- **المشاركة بمعنى النموذج / Sharing as the form defines it:** (أ) مشتقات الصور والفيديو إلى المؤسسات المشترية المرخَّص لها (P8)، بنسبةٍ إلى اسم الشبكة الثابت لا إلى اسم المراسل، ومعها في الكتالوج عنوان المادة ووصفها وقائمة لقطاتها والمحافظة وحدها (K:`CatalogItem`) **[OC-1]**؛ (ب) لا مشاركة مع وسطاء بيانات ولا شبكات إعلانية (P4). / (a) Photo and video derivatives go to licensed buyer organizations (P8), credited to the network's fixed name rather than the reporter's name, and the catalog also shows them the material's title, description, shot list and governorate only (K:`CatalogItem`) **[OC-1]**; (b) nothing goes to data brokers or ad networks (P4).
- **مزوّدو الخدمة / Service providers:** FCM وPlay Integrity بنية تشغيل للإشعارات والتحقق، والنقل إلى مزوّد خدمة يعالج نيابةً عن المطوّر لا يُعد مشاركة بحسب R («ما لا يُعلَن»). المعالجة الخارجية للمواد غير الحساسة معطّلة إلى أن تعتمد الإدارة سياسة مكتوبة؛ الآن «تجري المعالجة الآلية محليًا» (P7) **[OC-14]**. / FCM and Play Integrity are operating infrastructure; a transfer to a service provider acting for the developer is not sharing per R ("what is not declared"). External processing of non-sensitive material is off until the administration approves a written policy; for now "automated processing runs locally" (P7) **[OC-14]**.
- **التتبع / Tracking:** لا تتبع عبر تطبيقات أو مواقع (P4، I1). / No tracking across apps or sites.

## 4. تبرير صلاحيات أندرويد لمراجعة Play / Android permission rationale for Play review

مصدر القائمة: `AndroidManifest.xml` (M). / The list comes from the source manifest (M). **[OC-10]** القائمة المدموجة في الحزمة المبنية لم تُفحص هنا (لا SDK في هذه البيئة)؛ يتحقق المالك منها قبل التقديم. / The merged manifest of the built bundle was not inspected here (no SDK in this environment); the owner checks it before submission.

| الصلاحية / Permission | التبرير بالعربية | Justification in English | المصدر / Source |
| --- | --- | --- | --- |
| `INTERNET` | رفع المواد التي يختارها المراسل إلى خوادم المؤسسة وتسجيل الدخول وجلب الحالة والإشعارات. كل الحركة مشفرة، والتطبيق يمنع HTTP النصي. | Uploads the material the reporter chooses to the organization's servers, signs in and fetches status and notifications. All traffic is encrypted and the app blocks cleartext HTTP. | M؛ `network_security_config.xml`؛ P11 |
| `POST_NOTIFICATIONS` | تُطلب بضغطة المراسل من شاشة التهيئة (`ui/setup/TaskKillerSetupScreen.kt`). تعرض إشعار تقدم الرفع الذي يشترطه النظام للمهمة والخدمة الأمامية، وتنبيهات العمل والحساب (حالة المادة، الإيصال، تنبيهات التحرير). نص الإشعار رقم المادة وحالتها فقط، ولا شيء على شاشة القفل (`VISIBILITY_SECRET`)، ولا إعلان. | Requested when the reporter taps in the setup screen. Shows the upload-progress notification the system requires for the job and the foreground service, and work and account alerts (material status, receipt, editorial alerts). The text is the material number and status only, nothing on the lock screen (`VISIBILITY_SECRET`), and no advertising. | M؛ `push/Push.kt`؛ P5؛ `apps/android/CLAUDE.md` |
| `FOREGROUND_SERVICE` + `FOREGROUND_SERVICE_DATA_SYNC` | الخدمة `UploadForegroundService` من نوع `dataSync` تُكمل رفع ملف اختاره المراسل وبدأه بنفسه، على أندرويد 10–13 فقط؛ من 14 يُستعمل بدلها مهمة نقل يبدؤها المستخدم. تتوقف بـ`stopSelf()` حين ينتهي الطابور. التفاصيل في القسم 5. | `UploadForegroundService`, type `dataSync`, finishes the upload of a file the reporter chose and started, on Android 10–13 only; from 14 a user-initiated data transfer job is used instead. It stops with `stopSelf()` when the queue ends. Details in section 5. | M؛ A:`upload/UploadScheduler.kt`، `upload/UploadForegroundService.kt`؛ ADR61 البند 4؛ R صف `dataSync` |
| `RUN_USER_INITIATED_JOBS` | مهمة النقل التي يبدؤها المستخدم على أندرويد 14+: تُجدول (`setUserInitiated(true)`) بعد ضغط المراسل إرسال المادة والتطبيق ظاهر، ولها إشعار، وتتبع شرط Wi‑Fi إن اختاره. | The user-initiated data transfer job on Android 14+: scheduled (`setUserInitiated(true)`) after the reporter taps send while the app is visible, with a notification, and honouring the Wi‑Fi-only option if chosen. | M؛ A:`UploadScheduler.kt`؛ R صف UIDT |
| `RECEIVE_BOOT_COMPLETED` | بعد إعادة التشغيل على أندرويد 10–13 يستأنف `BootReceiver` رفعًا غير مكتمل بدأه المراسل. من أندرويد 14 يعود المستقبِل فورًا ولا يفعل شيئًا، ويُستأنف الرفع حين يفتح المراسل التطبيق. | After a reboot on Android 10–13, `BootReceiver` resumes an unfinished upload the reporter started. From Android 14 the receiver returns immediately and does nothing; the upload resumes when the reporter next opens the app. | M؛ A:`upload/BootReceiver.kt` |

**صلاحيات غائبة عمدًا / Deliberately absent (M).** `ACCESS_FINE_LOCATION`، `ACCESS_COARSE_LOCATION`، `ACCESS_MEDIA_LOCATION`، `CAMERA`، `RECORD_AUDIO`، `READ_MEDIA_IMAGES`، `READ_MEDIA_VIDEO`، `READ_EXTERNAL_STORAGE`، `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`. اختيار الملف عبر منتقي النظام (`PickVisualMedia`) ومنتقي المستندات للمرفقات (`OpenMultipleDocuments`) لا يحتاجان صلاحية، فلا إعلان `READ_MEDIA_*` مطلوب (R صف «صلاحيات الصور والفيديو»). شاشة التهيئة تفتح صفحات إعدادات البطارية ولا تطلب الاستثناء (M تعليق؛ R صف «استثناء تحسين البطارية»). كما يحجب التطبيق لقطات الشاشة ومعاينة قائمة التطبيقات الأخيرة (`FLAG_SECURE` في `ui/MainActivity.kt`، P11)، و`allowBackup="false"` مع استثناء كل المجالات من النسخ السحابي ونقل الجهاز (`res/xml/data_extraction_rules.xml`).

## 5. نص إعلان الخدمة الأمامية في Play Console / Foreground service declaration text

| الحقل / Field | العربية | English |
| --- | --- | --- |
| النوع / Type | نقل البيانات (`dataSync`) | Data sync (`dataSync`) |
| الوصف / Description | رفع الفيديو أو الصورة التي اختارها المراسل بنفسه إلى خوادم المؤسسة على أجزاء قابلة للاستئناف بعد أن يضغط «إرسال». لا تبدأ الخدمة من تلقاء نفسها ولا تعمل إلا والطابور فيه عمل. | Uploads the video or photo the reporter chose, to the organization's servers in resumable chunks, after the reporter taps send. The service never starts by itself and runs only while the queue has work. |
| أثر التأجيل / Impact of deferral | يتأخر وصول المادة إلى غرفة الأخبار ولا يصدر إيصال الاستلام؛ والمراسل غالبًا في الميدان على شبكة ضعيفة. | The material reaches the newsroom late and no receipt is issued; the reporter is usually in the field on a weak network. |
| أثر المقاطعة / Impact of interruption | يتوقف النقل ويُستأنف من آخر بايت أكّده الخادم (`HEAD` ثم `PATCH`)، لا من البداية. | The transfer stops and resumes from the last byte the server confirmed (`HEAD` then `PATCH`), not from the start. |
| حالة الاستعمال / Use case | نقل بيانات بطلب صريح من المستخدم. على أندرويد 14+ يُستعمل نمط UIDT الذي توصي به Google لهذه الحالة. | Data transfer in response to an explicit user request. On Android 14+ the UIDT pattern Google recommends for this case is used. |
| مدة 6 ساعات / 6-hour limit | لا ينطبق: الخدمة الأمامية لا تُشغَّل على أندرويد 14 فأعلى. | Not applicable: the foreground service is not started on Android 14 and above. |
| الفيديو التوضيحي / Demo video | يسجّله المالك: اختيار ملف، ثم إرسال، ثم إشعار التقدم، ثم الإيصال (R). لا يوجد في المستودع. | The owner records it: pick a file, send, the progress notification, the receipt (R). It is not in the repo. **[OC-15]** |

المصادر / Sources: A:`upload/UploadScheduler.kt`، `upload/UploadForegroundService.kt`، `core/.../upload/UploadEngine.kt`؛ ADR61 البند 4؛ R صفوف «إعلان الخدمة الأمامية» و«`dataSync` مقابل UIDT» و«مهلة `dataSync`».

## 6. ما وجده الكود زيادةً على الحقائق المعروفة / What the code shows beyond the known facts

1. **F1.** الدخول يرسل كلمة مرور ورمز تحقق سداسيًا اختياريًا إلى جانب البريد؛ نص P2 يذكر البريد وحده. / Sign-in also sends a password and an optional 6-digit code; P2 names the email only.
2. **F2.** المحافظة والمدينة إلزاميتان وتُرسلان نصًّا: موقع تقريبي بمستوى المدينة. / Governorate and city are required and sent as text: approximate location at city level.
3. **F3.** خيار «اسم مستعار» يرسل نصًّا يكتبه المراسل (الاسم)، بينما يقول P2 وI2 إن التطبيق لا يطلب الاسم. / The "pseudonym" option sends reporter-typed text (a name), while P2 and I2 say the app does not ask for a name.
4. **F4.** الترخيص للمشترين يسلّم مشتقات الصور والفيديو، بنسبة إلى اسم الشبكة لا اسم المراسل؛ هذا «مشاركة» بتعريف النموذج، مع أن P4 يقول «لا نبيع البيانات». / Licensing delivers photo and video derivatives, credited to the network's name rather than the reporter's; that is "sharing" as the form defines it, even though P4 says "we do not sell data".
5. **F5.** أندرويد لا يرسل إحداثيات ولا يدعم حقل الموقع؛ P3 أوسع إذ يذكر «إحداثيات GPS الاختيارية إن أُدخلت»، وذلك لا يقع من هذا التطبيق. الإعلان لا يتغير لأن الموقع الدقيق يصل عبر بيانات الملف. / Android sends no coordinates and does not support the location field; P3 is broader ("optional GPS coordinates if entered"), which does not happen from this app. The declaration is unchanged because precise location arrives through the file's metadata.
6. **F6.** يُرسل اسم الملف ونوعه وحجمه (`UploadSessionCreate`). / The file name, type and size are sent.
7. **F7.** تسجيل الإشعارات يجري عند كل دخول دون إمكان إيقافه من التطبيق، ورفض صلاحية الإشعارات لا يلغيه. / Push registration happens on every sign-in with no off switch in the app, and denying the notification permission does not cancel it.
8. **F8.** المالية: لا بطاقة ولا بنك ولا قناة غير `sandbox`؛ لكن طلب الصرف يرسل مبلغًا وعملة (القسم 2.3). / Financial: no card, no bank, no channel other than `sandbox`; but the payout request does send an amount and currency (section 2.3).
9. **F9.** وثيقة iOS تشير إلى إفصاح Play «PR #349»؛ لم أجد وثيقة أمان بيانات لـPlay في المستودع قبل هذه. / The iOS document refers to a Play disclosure "PR #349"; I found no Play data-safety document in the repo before this one.

## 7. ما يحتاج تأكيد المالك في Play Console / Needs the owner's confirmation in Play Console

| الرمز | البند بالعربية | Item in English |
| --- | --- | --- |
| OC-1 | المشاركة: أعلنّا الصور والفيديو «مشاركةً» مع المؤسسات المشترية (P8)، ولا يُشارك اسم الظهور. يؤكد المالك الجواب وغرضه. وقد ثبت من العقد أن العنوان والوصف وقائمة اللقطات والمحافظة تظهر في الكتالوج (`CatalogItem`)، فأُعلنت مشاركةً. | Sharing: Photos and Videos are declared "shared" with buyer organizations (P8); the display name is not shared. Confirm the answer and purpose. The contract shows the title, description, shot list and governorate in the catalog (`CatalogItem`), so they are declared shared. |
| OC-2 | الموقع التقريبي: المحافظة والمدينة المكتوبتان تُجمعان، والمحافظة وحدها تُشارك مع المؤسسات المشترية. | Approximate location: the typed governorate and city are collected; only the governorate is shared with buyer organizations. |
| OC-3 | لا قياس في المستودع يثبت هل يصل موقع الكاميرا فعلًا في ملف اختير عبر منتقي أندرويد (التطبيق لا يملك `ACCESS_MEDIA_LOCATION`). الإعلان محافظ بالجمع كما في P3 («قد يحمل الأصل»)؛ يُقاس على جهاز ضمن الاختبار الميداني قبل أي ادعاء أدق. | No measurement in the repo shows whether the camera location actually arrives in a file picked through the Android picker (the app holds no `ACCESS_MEDIA_LOCATION`). The declaration stays conservative, as in P3 ("the original may carry"); measure on a device in the field test before any sharper claim. |
| OC-4 | الاسم: إدراج الاسم المستعار الاختياري تحت «Name» مع بقاء نص السياسة «لا يطلبان الاسم». يُراجَع نص P2 وI2. | Name: list the optional pseudonym under "Name" while the policy text says the apps do not ask for a name. P2 and I2 need a look. |
| OC-5 | كلمة المرور ورمز التحقق تحت «Other info»، ولا يذكرهما P2. | Password and verification code under "Other info"; P2 does not mention them. |
| OC-6 | معلومات مالية أخرى: مبلغ طلب صرف تجريبي. يُعاد النظر عند تفعيل قناة صرف حقيقية (ADR لكل قناة؛ K:`PayoutChannel`)، فحينها تتغير الإجابة. | Other financial info: a sandbox payout-request amount. Revisit when a real payout channel is enabled (an ADR per channel; K:`PayoutChannel`), when the answer changes. |
| OC-7 | الصوت: المسار الصوتي داخل الفيديو (P7 يذكر التفريغ النصي) هل يُعلن «Voice or sound recordings». | Audio: whether the soundtrack inside the video (P7 mentions transcription) should be declared as "Voice or sound recordings". |
| OC-8 | الملفات والمستندات: اسم الملف ونوعه وحجمه. | Files and docs: file name, type and size. |
| OC-9 | الفئة المناسبة لرمز Play Integrity ولرمز FCM، وإفصاحات مكتبات Google الخاصة بهما. كلاهما يتعطل بغياب خاصيات البناء (`-PfcmAppId` وأخواتها، و`-PplayCloudProjectNumber`)؛ يُعلن ما يحمله بناء الإنتاج الفعلي. رقم نسخة التطبيق المرفق بالتسجيل. | The right category for the Play Integrity token and the FCM token, and Google's disclosures for those libraries. Both are off without the build settings (`-PfcmAppId` and its siblings, `-PplayCloudProjectNumber`); declare what the actual production build carries. The app version number attached to registration. |
| OC-10 | معرّف الإعلانات: الجواب «لا» في App content، بعد فحص القائمة المدموجة في الحزمة المبنية (الصلاحيات التي تضيفها المكتبات). | Advertising ID: answer "No" in App content, after checking the merged manifest of the built bundle (permissions that libraries add). |
| OC-11 | بريد التواصل في سياسة الخصوصية يُنشر عبر متغير بيئة الخادم؛ حتى ينشر تعرض الصفحة «سيُنشر قريبًا» (`emailPending`)، فيتوقف جواب «الحذف بالطلب» عن أن يكون قابلًا للتنفيذ. ينشر قبل التقديم. وأيضًا هل ينطبق شرط حذف الحساب في Play (مسار داخل التطبيق ورابط ويب) والحسابات تصدرها الجهة المشغّلة ولا تسجيل ذاتيًا (P1؛ R قسم حذف الحساب وبند قائمة التحقق). | The contact email in the privacy policy is published through a server environment variable; until then the page shows "will be published soon" (`emailPending`), and the "deletion on request" answer is not actionable. Publish before submission. Also whether Play's account-deletion requirement (in-app path plus web link) applies, since accounts are issued by the Operator with no self-registration (P1; R account-deletion section and checklist item). |
| OC-12 | إن فعّلت الجهة قناة تنبيه خارجية (بريد أو رسائل نصية، P5) صار البريد مستعملًا لما بعد الدخول، وتُحدَّث الأغراض. | If the Operator turns on an external alert channel (email or text, P5), the email is used beyond login and the purposes need updating. |
| OC-13 | حقول نموذج المكتب يعرّفها الخادم؛ يُتأكد أنها لا تطلب نوعًا أُعلن «غير مجمَّع» (عنوان، هاتف، صحة…). | The desk form's fields are server-defined; make sure none asks for a type declared "not collected" (address, phone, health, and so on). |
| OC-14 | المعالجة الخارجية للمواد غير الحساسة: إن اعتُمدت سياسة مكتوبة وفُعّلت، يُعاد تقدير «المشاركة» (استثناء مزوّد الخدمة في R). | External processing of non-sensitive material: if a written policy is approved and turned on, reassess "sharing" (the service-provider exception in R). |
| OC-15 | تسجيل فيديو إعلان الخدمة الأمامية. | Record the foreground-service declaration video. |

## 8. متى تُراجَع هذه الوثيقة / When to re-review this document

عند: تفعيل قناة دفع أو صرف حقيقية؛ إضافة صلاحية أو مكتبة أو حقل ثابت؛ تفعيل FCM أو Play Integrity في بناء جديد؛ تفعيل مزوّد معالجة خارجي أو قناة تنبيه خارجية؛ تغيير نص سياسة الخصوصية أو `apps/ios/store/app-privacy.md`؛ أو إضافة حذف من داخل التطبيق.

When: a real payment or payout channel is enabled; a permission, library or fixed field is added; FCM or Play Integrity is enabled in a new build; an external processing provider or alert channel is turned on; the privacy policy text or `apps/ios/store/app-privacy.md` changes; or in-app deletion is added.
