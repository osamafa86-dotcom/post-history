# emergency-wipe — ما يبقى على الجهاز بعد المسح الطارئ (SEC-01)

**المعيار (من threat-model وSEC-01):** جهاز بعد المسح لا يُظهر شيئًا؛ ورمز مبطَل يُرفض خلال ثوانٍ. هنا الشطر الأول على جهاز فعلي، والثاني على الخادم يقيسه `scripts/session-revocation.mjs` حيًّا.

**من ينفّذه:** المشرف الميداني مع مشغّل الجودة (يفحص الخادم و`adb`/Xcode). **بطاقة لكل جهاز** من قالب منصته: `emergency-wipe.ios.card.template.json` أو `emergency-wipe.android.card.template.json`. يعبر المعيار حين تنجح بطاقة iPhone فعلي وبطاقة جهاز أندرويد فعلي على الأقل؛ بطاقة واحدة نتيجة جزئية. حدّ زمن المسح في الحاكم `WIPE_MAX_S = 5` ثوانٍ (الإبطال البعيد بأفضل جهد ≤ 3 ث ولا يؤخر المحلي).

## قبل البدء (مشغّل الجودة)

1. حساب مراسل تجريبي على بيئة الاختبار، وتطبيق نظيف مثبَّت، وجهاز ثانٍ (أو `curl`) لقراءة `GET /auth/sessions` بحساب المراسل نفسه.
2. ملف اصطناعي (`node tools/acceptance/field/make-sample.mjs 1024 synthetic-1gib.bin`)؛ لا مواد حقيقية.
3. سجّل الدخول، أنشئ مادة بالملف وابدأ الرفع حتى 10٪ على الأقل (`setup.upload_progress_pct_at_wipe`).

## أ. المسح متصلًا (`online_wipe`)

1. نفّذ المسح الطارئ بتأكيده الصريح؛ **سجّل الثواني من الضغط حتى شاشة النتيجة** (`online_wipe.seconds`).
2. من الجهاز الثاني: `GET /auth/sessions` لا تُظهر جلسة الهاتف (`server_sessions_listed_empty`)، وطلب `GET /auth/me` برمز وصول الهاتف القديم (إن التُقط قبل المسح) يرد 401 (`old_access_token_refused`). إن أخفق الإبطال البعيد (رمز وصول منتهٍ) فهذا فشل مسجَّل لا يُخفى.

## ب. المسح بلا اتصال (`offline_wipe`)

وضع الطيران، رفع جارٍ، ثم المسح؛ **الثواني حتى شاشة النتيجة** في `offline_wipe.seconds` (يجب ألا يتأخر المسح المحلي بمهلة الإبطال البعيد).

## ج. ما يبقى بعد المسح (`stores`)

لكل مخزن من قائمة منصته: `empty` (true/false) و`checked_with` (الأمر أو الشاشة المستعملة، نصًا بلا أسماء ولا مسارات ولا معرّفات). **ما لا يمكن فحصه خارجيًا يُكتب كما هو** ولا يُعلن فارغًا بالتخمين.

### iOS (المخازن: `server_sessions`, `session`, `upload_tokens`, `upload_state`, `chunks`, `imported_originals`, `caches`, `temporary`, `url_cache`, `defaults`, `background_transfers`)

| المخزن | الفحص |
| --- | --- |
| `server_sessions` | الخطوة (أ-2). |
| `session` | إعادة فتح التطبيق تعرض شاشة الدخول. |
| `upload_tokens` | لا يُقرأ Keychain على جهاز غير مكسور؛ الدليل غير مباشر: لا استئناف تلقائي للرفع بعد 60 ثانية (`watch-offset.mjs <رابط-الرفع>`) ولا مادة في قائمة الرفع. **لا تعتمد على `HEAD` برمز قديم**: tusd لا يتحقق من الرمز إلا عند الإنشاء (SEC-06)، فـ`HEAD` يعيد 200 مهما كان. |
| `upload_state` / `chunks` / `imported_originals` | Xcode ← Window ← Devices and Simulators ← التطبيق ← Download Container: `Application Support/UploadState` و`Caches/UploadChunks` و`Documents/Uploads` فارغة. |
| `caches` / `temporary` / `url_cache` | المجلدان `Library/Caches` و`tmp` فارغان في الحاوية؛ `url_cache` لا يُرى منفصلًا، فيُسجَّل «فارغ بفراغ Caches». |
| `defaults` | الخيار `deleteLocalAfterReceipt` يعود إلى الافتراضي. |
| `background_transfers` | بعد دقيقة لا تقدّم على رابط الرفع (`watch-offset.mjs`). |

### أندرويد (المخازن: `server_sessions`, `transfers`, `session`, `upload_queue`, `file_grants`, `preferences`, `caches_and_files`) على بناء debug

```bash
P=net.palpost.library
adb shell run-as $P ls -la shared_prefs databases cache code_cache files no_backup 2>&1   # session, preferences, upload_queue, caches_and_files: فارغة أو غير موجودة
adb shell run-as $P ls -la databases/ 2>&1 | grep -c uploads                                # upload_queue: 0
adb shell dumpsys jobscheduler | grep -c "$P"                                               # transfers: لا مهمة مجدولة
adb shell dumpsys notification --noredact | grep -c "$P"                                    # transfers: لا إشعارات
adb shell dumpsys activity services | grep -c UploadForegroundService                       # transfers: 0
adb shell cmd uri_grants list 2>/dev/null | grep -c "$P" || adb shell dumpsys activity permissions | grep -c "$P"   # file_grants: لا أذونات دائمة
```

انسخ ناتج كل أمر إلى `observations` كما هو. `server_sessions`: الخطوة (أ-2).

## د. الدخول من جديد (`relogin`)

بلا إعادة تشغيل التطبيق: سجّل الدخول وأنشئ مادة جديدة (`works_without_restart`, `new_material_works`).

## ما لا يُمسح بتصميم (`preserved_by_design`)

سجّل أنه ظل كما هو، لا أنه فشل: مكتبة الصور وملفات المراسل الأصلية (`photo_library_untouched`)، وأن لقطة مبدّل التطبيقات لا تعرض محتوى (`task_switcher_content_hidden`: افحصها بالمبدّل بعد المسح). ما وصل إلى الخادم لا يمسحه المسح.

## بعد الملء

```bash
node tools/acceptance/field/record-card.mjs <البطاقة.json>
```

يرفض الحاكم بطاقة ناقصة (فراغ رفض لا فشل)، أو فيها بيانات كاشفة، أو فيها مخزن ليس من منصتها. نتيجة بطاقة واحدة `partial` دائمًا؛ تفشل إن بقي مخزن غير فارغ أو تجاوز المسح 5 ث أو بقي رمز الوصول القديم مقبولًا أو لم يعمل الدخول بلا إعادة تشغيل.
