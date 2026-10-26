# بحث: متطلبات مراجعة المتاجر لتطبيق رفع مهني

- مسار العمل: Issue ‏#308 (بحث 4).
- تاريخ آخر تحقق من كل المصادر: **2026-10-26** ما لم يُذكر غيره.
- النطاق: ما تشترطه آبل وجوجل، وما ترفضان التطبيق بسببه عادة، في تطبيق مؤسسي «للمستخدمين المسجلين فقط»: حساب المراجع، وسياسة الخصوصية، وإعلان جمع البيانات (App Privacy / Data safety)، وحذف الحساب، وتصنيف المحتوى الإخباري الحساس، ومتطلبات أندرويد التقنية التي تمس نواة الرفع. **لا قرار ولا ADR**؛ القرار للمنسّق.
- السياق من الخطة (`docs/plan/الخطة-النسخة-الثالثة.md`): تطبيقان أصليان (Swift وKotlin) للمراسلين والطاقم في النسخة الأولى؛ رفع في الخلفية عبر جلسة `URLSession` خلفية في iOS، وUIDT في Android 14+ وخدمة أمامية `dataSync` في الأقدم؛ App Attest وPlay Integrity؛ تجنّب صلاحية استثناء تحسين البطارية؛ والشراء على الويب.
- المصدر الأساسي هو التوثيق الرسمي للمتجرين. لم يُرسَل أي تطبيق أو ملف للمراجعة أثناء هذا البحث، فلا يوجد هنا قياس ولا تجربة مراجعة فعلية.

## الخلاصة

1. **حساب المراجع شرط عند الطرفين.** آبل تطلب بيانات حساب تجريبي «وتشغيل الخادم» لأي تطبيق فيه تسجيل دخول. جوجل تطلب بيانات دخول متاحة دائمًا وقابلة لإعادة الاستعمال وصالحة من أي موقع، وتتجاوز OTP والتحقق بخطوتين، ومكتوبة بالإنجليزية. انتهاء صلاحية كلمة المرور قد يؤدي إلى الرفض.
2. **الخصوصية:** آبل تطلب رابط سياسة الخصوصية في بيانات المتجر وداخل التطبيق معًا. والطرفان يطلبان إعلانًا دقيقًا لكل ما يجمعه التطبيق ومكتباته. الصور والفيديو المرفوعة تُعلَن بنوعها عند آبل، و«الجمع» عند جوجل يعني أي نقل للبيانات خارج الجهاز.
3. **حذف الحساب:** إن كان التطبيق يتيح إنشاء حساب، فالطرفان يشترطان مسارًا لحذفه من داخل التطبيق، ويقبلان رابطًا إلى صفحة ويب. جوجل تشترط كذلك رابط ويب يمكن طلب الحذف منه دون تثبيت التطبيق من جديد.
4. **المحتوى الإخباري الحساس:** لم يُعثر في أي من المتجرين على استثناء نصي للأخبار من قواعد العنف. لدى آبل، العنف الواقعي المتكرر يرفع التصنيف إلى 18+، والعنف «المطوّل أو الدموي أو السادي» يجعل التطبيق «غير مصنف» فلا يُنشر. لدى جوجل استثناء «تعليمي أو وثائقي أو علمي أو فني» (EDSA) في سياستي التطرف العنيف والأحداث الحساسة، وليس في سياسة العنف نفسها.
5. **قيود أندرويد التقنية:**
   - من 31 أغسطس 2026 يجب أن تستهدف التطبيقات الجديدة والتحديثات API 36.
   - كل نوع خدمة أمامية يحتاج إعلانًا في Play Console مع فيديو توضيحي، و`dataSync` محدودة بست ساعات في كل 24 ساعة لمن يستهدف Android 15+.
   - صلاحيتا `READ_MEDIA_IMAGES` و`READ_MEDIA_VIDEO` تحتاجان إعلانًا وموافقة، والبديل هو منتقي النظام.
   - طلب استثناء تحسين البطارية ممنوع إلا في حالات محددة.
6. **قنوات توزيع محدودة:**
   - آبل: التوزيع «غير المدرج» (Unlisted) والتطبيقات المخصصة (Custom Apps)، وكلاهما يمر بالمراجعة.
   - جوجل: التطبيقات الخاصة في Managed Google Play. لم تذكر صفحتها الرسمية هل تخضع هذه التطبيقات لمراجعة السياسات.
   - الحسابات الشخصية الجديدة في Play عليها شرط اختبار مغلق (12 مختبِرًا لمدة 14 يومًا). الصفحة لا تذكر حسابات المؤسسات.

## آبل (App Store)

### حساب المراجع واكتمال النسخة

| المتطلب | النص أو المضمون | المصدر |
| --- | --- | --- |
| حساب تجريبي | الإرشاد 2.1(a): «include demo account info (and turn on your back-end service!) if your app includes a login». ويُسمح بوضع تجريبي مدمج بدل الحساب فقط «with prior approval by Apple» إذا منعت التزامات قانونية أو أمنية تقديم حساب | [App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/) |
| نسخة مكتملة | النسخ غير المكتملة أو التي تتعطل تُرفض (2.1) | المصدر نفسه |
| ملاحظات المراجعة | 2.3.1(a): الميزات الجديدة توصف بالتحديد في Review Notes | المصدر نفسه |
| لقطات الشاشة | 2.3.3: تُظهر التطبيق قيد الاستعمال، لا صفحة الدخول وحدها | المصدر نفسه |
| تسجيل الدخول | 4.8: يُشترط بديل دخول مكافئ عند استعمال دخول اجتماعي أو من طرف ثالث. ولا يلزم البديل إذا اقتصر التطبيق على نظام حسابات الشركة نفسها، أو كان «education, enterprise, or business app that requires the user to sign in with an existing education or enterprise account» | المصدر نفسه |
| الدخول الإلزامي | 5.1.1(v): «If your app doesn’t include significant account-based features, let people use it without a login» | المصدر نفسه |
| خدمات الخلفية | 2.5.4: تُستعمل خدمات الخلفية لأغراضها فقط: «VoIP, audio playback, location, task completion, local notifications, etc.» | المصدر نفسه |
| التسجيل بالكاميرا | 2.5.14: موافقة صريحة ومؤشر مرئي أو مسموع عند التسجيل بالكاميرا أو الميكروفون | المصدر نفسه |
| الوصول | 5.1.1(iv): لا يُفرض وصول غير لازم. مثال الإرشاد: رفع الصور لا يُشترط له إذن الميكروفون | المصدر نفسه |
| الشراء | 3.1.3(c) «Enterprise Services»: التطبيق الذي يُباع مباشرة لمؤسسات أو مجموعات لموظفيها يجوز أن يتيح الوصول إلى محتوى أو اشتراكات اشتُريت سابقًا | المصدر نفسه |

آخر تحديث معلن لصفحة الإرشادات: **16 أكتوبر 2026** ([App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/)).

### الخصوصية وإعلان البيانات

- **سياسة الخصوصية (5.1.1(i)):** «All apps must include a link to their privacy policy in the App Store Connect metadata field and within the app in an easily accessible manner». ويجب أن تبيّن السياسة البيانات المجموعة وطريقة جمعها وكل استعمالاتها ([App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/)).
- **دقة البيانات الوصفية (2.3):** معلومات الخصوصية جزء من البيانات الوصفية التي يجب أن تكون دقيقة (المصدر نفسه).
- **App Privacy details** ([App Privacy Details](https://developer.apple.com/app-store/app-privacy-details/)):
  - تُعلَن كل البيانات التي تجمعها أنت أو مكتبات الطرف الثالث، حتى ما يُستعمل لوظيفة التطبيق وحدها.
  - الصور والفيديو التي يرفعها المستخدم تُعلَن بنوعها.
  - الموقع الدقيق الذي يُخفَّض دقته قبل التخزين يُعلَن «موقعًا تقريبيًا» (Coarse Location).
  - عنوان IP يُعلَن بحسب طريقة استعماله.
  - بيانات الدفع المُدخلة في خدمة دفع خارجية لا تُعد «مجموعة» من التطبيق.
- **ملف بيان الخصوصية (Privacy Manifest):** يُعلَن فيه استعمال الواجهات ذات الأسباب المطلوبة عبر المفتاح `NSPrivacyAccessedAPITypes`. ومكتبات الطرف الثالث المدرجة في قائمة آبل تحتاج ملف بيان وتوقيعًا ([Privacy manifest files](https://developer.apple.com/documentation/bundleresources/privacy-manifest-files)).

### حذف الحساب

[Offering account deletion in your app](https://developer.apple.com/support/offering-account-deletion-in-your-app/):

- التطبيق الذي يتيح إنشاء حساب يجب أن يتيح بدء حذفه من داخل التطبيق، ويُقبل رابط مباشر إلى صفحة ويب.
- يشمل الحذف كل البيانات، ومنها المحتوى الذي شاركه المستخدم. التعطيل وحده لا يكفي.
- يُبلَّغ المستخدم بالبيانات التي يُلزم القانون بالاحتفاظ بها.
- يُقبل الحذف اليدوي أو المؤجل إن أُبلغ المستخدم بالمدة وتلقى تأكيدًا.
- المسار عبر الهاتف أو البريد مقصور على الصناعات شديدة التنظيم (5.1.1(ix)).

### المحتوى الحساس والتصنيف العمري

- **الإرشاد 1.1.2:** يمنع «Realistic portrayals of people or animals being killed, maimed, tortured, or abused, or content that encourages violence» ([App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/)).
- **الإرشاد 1.1.7:** يمنع «Harmful concepts which capitalize or seek to profit on recent or current events, such as violent conflicts, terrorist attacks, and epidemics» (المصدر نفسه).
- **الإرشاد 1.2 (المحتوى الذي ينشئه المستخدمون):** التطبيقات التي تتيح للمستخدمين رفع المحتوى أو مشاركته يجب أن توفر:
  - تصفية المحتوى المسيء.
  - آلية إبلاغ مع استجابة في وقت مناسب.
  - حظر المسيئين.
  - معلومات تواصل منشورة.

  لم يُعثر في النص على ما يحدد هل ينطبق هذا على رفع داخلي إلى طاقم التحرير دون عرض عام (المصدر نفسه).
- **التصنيف العمري** ([Age ratings values and definitions](https://developer.apple.com/help/app-store-connect/reference/age-ratings-values-and-definitions/)):
  - المستويات: 4+ و9+ و13+ و16+ و18+.
  - العنف الواقعي غير المتكرر يعطي 13+، والمتكرر يعطي 18+.
  - «Prolonged graphic or sadistic realistic violence» يجعل التطبيق Unrated، ولا يُنشر التطبيق غير المصنف في المتجر.
  - «Mature/Suggestive themes» تشمل «real-world crimes… war or political strife».
  - الصفحة لا تذكر استثناء للأخبار، والقيم مرتبطة بأنظمة الإصدار 26.
- **صدق الإجابة (2.3.6):** يُجاب عن أسئلة التصنيف العمري بصدق ([App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/)).

### قنوات التوزيع المحدودة

| القناة | ما تقوله آبل | المصدر |
| --- | --- | --- |
| التوزيع غير المدرج (Unlisted) | مناسب لموارد الموظفين والجماهير المحدودة، ولا يُوصل إليه إلا برابط مباشر. يمر بمراجعة التطبيقات (ملاحظة في Review Notes ثم تقديم طلب). يُرفض الطلب للتطبيقات التجريبية (beta) | [Unlisted app distribution](https://developer.apple.com/support/unlisted-app-distribution/) |
| التطبيقات المخصصة عبر Apple Business Manager | توزيع خاص لمؤسسات محددة، ومنها الاستعمال الداخلي. «If your app contains sensitive data, provide sample data and authentication for the App Store Review team». ولا يُختار التوزيع الخاص إلا قبل الموافقة على التطبيق | [Custom apps](https://developer.apple.com/custom-apps/) |

## جوجل (Google Play)

### حساب المراجع (App access)

[Requirements for providing sign in details for review](https://support.google.com/googleplay/android-developer/answer/15748846?hl=en):

- تُقدَّم معلومات تمكّن الفريق من «log in and access all app functionality»: حساب تجريبي جاهز، أو رموز QR، أو تعليمات للوصول إلى الأقسام المقيدة.
- «Your sign-in details must be accessible at all times, reusable, and valid regardless of user location».
- إن كان التطبيق يطلب رمزًا لمرة واحدة أو تحققًا بخطوتين، تُقدَّم «reusable login credentials that can bypass these requirements».
- إن انتهت صلاحية كلمة المرور فقد لا تتم المراجعة «and, therefore, the app may be rejected».
- إن كان الدخول مقيدًا بالموقع الجغرافي، تُقدَّم بيانات صالحة من أي موقع.
- تُكتب البيانات بالإنجليزية. والبيانات غير النصية (QR أو باركود) تُرفع عبر رابط ثابت.
- تُضاف التعليمات في صفحة App content في Play Console ([Prepare your app for review](https://support.google.com/googleplay/android-developer/answer/9859455?hl=en)).

### إعلان البيانات (Data safety) وسياسة الخصوصية

- **إلزامية الإعلان:** يجب إكمال قسم Data safety لكل تطبيق، والإبقاء عليه دقيقًا ([User Data policy](https://www.support.google.com/googleplay/android-developer/answer/9888076)).
- **سياسة الخصوصية:** تشترط سياسة بيانات المستخدم «a valid privacy policy»، وموافقة المستخدم، والتعامل الآمن مع البيانات (المصدر نفسه).
- **تعريف «الجمع»:** «‘Collect’ means transmitting data from your app off a user’s device»، ويشمل ما تنقله المكتبات ([Data safety section](https://support.google.com/googleplay/android-developer/answer/10787469?hl=en)).
- **تعريف «المشاركة»:** نقل البيانات إلى طرف ثالث، ومنه النقل بين الخوادم (المصدر نفسه).
- **ما لا يُعلَن:**
  - المعالجة على الجهاز وحده.
  - البيانات المشفرة طرفًا لطرف التي لا يقرؤها المطوّر.
  - النقل إلى «service provider» يعالج البيانات نيابة عن المطوّر وبتعليماته لا يُعد مشاركة.
  - المعالجة العابرة (ephemeral) تُذكر في النموذج لكنها لا تظهر في القسم إن استوفت شرطها.

  (المصدر نفسه)
- **البيانات المستعارة:** «User data collected pseudonymously must be disclosed» (المصدر نفسه).

### حذف الحساب

[Account deletion requirements](https://support.google.com/googleplay/android-developer/answer/13327111?hl=en):

- التطبيق الذي يتيح إنشاء حساب، ولو بتوجيه المستخدم إلى إنشائه خارج التطبيق، يجب أن يوفر أمرين:
  - مسارًا داخل التطبيق لحذف الحساب وبياناته.
  - **و**رابط ويب يُطلب منه الحذف «without sending the user back to the app».
- يجوز أن يكون المسار الداخلي رابطًا إلى صفحة الحذف على الويب.
- يجب أن تذكر صفحة الويب اسم التطبيق أو المطوّر كما يظهر في المتجر.
- «When you delete an app account based on a user’s request, you must also delete the user data associated with that app account».
- يجوز الاحتفاظ ببعض البيانات «for legitimate reasons such as security, fraud prevention or regulatory compliance» مع إبلاغ المستخدم بوضوح، في سياسة الخصوصية مثلًا.

### التصنيف والمحتوى الإخباري الحساس

- **التصنيف:** كل تطبيق يحتاج تصنيف IARC عبر استبيان Play Console. والتطبيقات غير المصنفة «will be removed from the Play Store». ويُعاد الاستبيان إذا تغيّر المحتوى بما يمس الإجابات ([Content Ratings](https://support.google.com/googleplay/android-developer/answer/9898843?hl=en)).
- **العنف:** يُمنع «Graphic depictions or descriptions of realistic violence or violent threats to any person or animal»، ولم يُذكر في قسم العنف استثناء للأخبار أو استثناء EDSA ([Violence policy](https://support.google.com/googleplay/android-developer/answer/9878810?hl=en)).
- **التطرف العنيف:** «You must provide EDSA context to attain an exception» (المصدر نفسه).
- **الأحداث الحساسة:**
  - يُمنع ما «capitalize on or are insensitive toward a sensitive event»، ومن الأمثلة النزاعات والوفيات.
  - تُستثنى عمومًا المواد ذات قيمة EDSA أو التي تهدف إلى «alert users to or raise awareness for the sensitive event».
  - الصفحة معلَّمة «effective September 30, 2026».

  ([Sensitive Events](https://support.google.com/googleplay/android-developer/answer/17517561?hl=en))
- **إعلان تطبيقات الأخبار** ([Requirements for news and magazine apps](https://support.google.com/googleplay/android-developer/answer/10523915?hl=en)):
  - يلزم الإعلان كل تطبيق صُنّف سابقًا تطبيق أخبار، أو مدرج في فئة News & Magazines، أو يصف نفسه بـ«news» في عنوانه أو أيقونته أو اسم مطوّره أو وصفه. أما غيرها فـ«out of scope».
  - على التطبيق المشمول أن يعرض معلومات التواصل عبر رابط يوجد داخل التطبيق، ولا تكفي روابط وسائل التواصل الاجتماعي وحدها.
  - محتوى الأحداث الجارية لا يزيد عمره على 30 يومًا، ويحمل كل مقال تاريخ نشر واضحًا.
  - هذه شروط تطبيق يعرض أخبارًا. تطبيق رفع داخلي لا يحمل وصف «news» قد يقع خارج النطاق بحسب المعايير الثلاثة، والتحقق منه للمنسّق.

### متطلبات أندرويد التي تمس نواة الرفع

| المتطلب | النص أو المضمون | المصدر |
| --- | --- | --- |
| مستوى API المستهدف | «Starting August 31, 2026: New apps and app updates must target Android 16 (API level 36) or higher». التطبيقات القائمة تحتاج API 35 على الأقل كي تبقى متاحة للمستخدمين الجدد | [Target API level requirements](https://support.google.com/googleplay/android-developer/answer/11926878?hl=en) |
| إعلان الخدمة الأمامية | لمن يستهدف Android 14+: إعلان كل نوع في App content، مع وصف الوظيفة، وأثر التأجيل أو المقاطعة، و«a link to a video demonstrating each foreground service feature»، واختيار حالة الاستعمال | [Foreground service requirements](https://support.google.com/googleplay/android-developer/answer/13392821?hl=en) |
| `dataSync` مقابل UIDT | تقول جوجل: «If your use case is for transferring data over a network… in response to an explicit user request, we recommend using the user-initiated data transfer job instead of the dataSync foreground service type» | المصدر نفسه |
| مهلة `dataSync` | لمن يستهدف Android 15+: «The system permits `dataSync` and `mediaProcessing` foreground services to run for a total of 6 hours in a 24-hour period» | [Foreground service timeouts](https://developer.android.com/develop/background-work/services/fgs/timeout) |
| UIDT | من Android 14 (API 34). تحتاج صلاحية `RUN_USER_INITIATED_JOBS`، وتُجدول والتطبيق ظاهر للمستخدم (أو في حالات مسموحة)، وتشترط إشعارًا عبر `setNotification()`. لا حد زمني ثابت معلن | [User-initiated data transfer](https://developer.android.com/develop/background-work/background-tasks/uidt) |
| صلاحيات الصور والفيديو | لمن يستهدف API 33+: لا تُطلب `READ_MEDIA_IMAGES` و`READ_MEDIA_VIDEO` إلا إن كان منتقي النظام غير كافٍ للوظيفة الأساسية، ويُقدَّم إعلان في Play Console. والاستعمال لمرة واحدة أو المتقطع ينتقل إلى منتقي النظام. منتقي Android ليس إلزاميًا بعينه | [Permissions policy](https://support.google.com/googleplay/android-developer/answer/9888170)، [Photo and video permissions](https://support.google.com/googleplay/android-developer/answer/14115180?hl=en-GB) |
| استثناء تحسين البطارية | «Google Play policies prohibit apps from requesting direct exemption from Power Management features… unless the core function of the app is adversely affected». والحالات المقبولة: المراسلة الفورية أو الاتصال، وتطبيقات السلامة، وأتمتة المهام، والأجهزة الملحقة | [Optimize for Doze and App Standby](https://developer.android.com/training/monitoring-device-state/doze-standby) |

### الحسابات وقنوات التوزيع

- **شرط الاختبار:** الحسابات الشخصية المنشأة بعد 13 نوفمبر 2023 تحتاج اختبارًا مغلقًا مع «a minimum of 12 testers who have been opted in continuously for at least 14 days» قبل طلب النشر للعموم. لا تذكر الصفحة حسابات المؤسسات ([App testing requirements](https://support.google.com/googleplay/android-developer/answer/14151465?hl=en)).
- **التطبيقات الخاصة في Managed Google Play:** «only available to users in the organization(s) you specify»، وتُوزَّع بالتثبيت عن بعد أو عبر متجر Managed Play. لم تذكر الصفحة هل تمر بمراجعة السياسات، ولا حدودًا رقمية ([Private apps overview](https://support.google.com/googleplay/work/answer/9563481)).
- **التحقق من هوية المطوّر:**
  - من 30 سبتمبر 2026 لا تُثبَّت تطبيقات المطوّرين غير المتحقق منهم من المتاجر المشاركة في مناطق محددة، ويُتوقع التعميم في 2027.
  - «If a developer distributes apps on Google Play, their apps across all form factors must be registered».
  - التطبيقات التي تستعمل Play App Signing تدخل في التسجيل التلقائي إن كانت مؤهلة.

  ([Developer verification FAQ](https://developer.android.com/developer-verification/guides/faq))

## قائمة تحقق قابلة للتنفيذ

بنود معلّقة تُستكمل قبل أول إرسال لكل متجر، وكل بند يحيل إلى القسم الذي فيه مصدره أعلاه.

### مشترك

- [ ] حساب مراجع لكل متجر، بدور مراسل وعيّنة بيانات اصطناعية لا تحوي مادة حقيقية، والخادم يعمل وقت المراجعة (آبل 2.1(a)، جوجل App access).
- [ ] الحساب يتجاوز OTP والتحقق بخطوتين وأي قيد جغرافي، ولا تنتهي صلاحيته طوال المراجعة، والتعليمات بالإنجليزية (جوجل).
- [ ] ملاحظات المراجعة تشرح أن التطبيق للمراسلين المعتمدين فقط، وكيف يُختبر الرفع في الخلفية، دون أي نطاق أو سر في النص المرسَل (آبل 2.3.1(a)).
- [ ] قرار مسجَّل: هل يُعتمد App Attest وPlay Integrity في بيئة المراجعة، وكيف يدخل المراجع إن رُفض الجهاز؟ (لم يُعثر على نص صريح من المتجرين؛ يحتاج تحققًا).
- [ ] رابط سياسة خصوصية عام في بيانات المتجر وداخل التطبيق، يغطي ما يُجمع وطريقة جمعه واستعمالاته ومدة الاحتفاظ (آبل 5.1.1(i)، جوجل User Data).
- [ ] جرد لكل بيانات تخرج من الجهاز، ومنها ما ترسله المكتبات: الصور والفيديو، والموقع (تقريبي أم دقيق)، والمعرّفات، وعنوان IP بحسب استعماله، وسجلات الأعطال. يُستعمل الجرد لتعبئة App Privacy وData safety.
- [ ] التأكد من أن «لا بيانات كاشفة» في الخطة يتطابق مع الإعلان: إن أُزيلت بيانات الموقع قبل الرفع، فما الذي يُعلَن فعلًا؟
- [ ] حذف الحساب: مسار داخل التطبيق (أو رابط ويب منه)، وصفحة ويب مستقلة لطلب الحذف (جوجل)، وإبلاغ المستخدم بما يُحتفظ به قانونًا أو تحريريًا وبالمدة.
- [ ] إن كان إنشاء الحساب بيد الإدارة لا المستخدم، يُتحقق هل ينطبق شرط الحذف؛ نص آبل يربطه بـ«supports account creation»، ونص جوجل يربطه بالإنشاء داخل التطبيق أو بالتوجيه إليه.
- [ ] استبيان التصنيف يُجاب عنه بحسب ما يُعرض داخل التطبيق فعلًا، لا بحسب ما يُرفع فقط. يُحدَّد هل يعرض التطبيق مواد مرفوعة (معاينة أو أرشيف) قد تحوي عنفًا واقعيًا.
- [ ] لقطات شاشة بمحتوى اصطناعي محايد، تُظهر التطبيق قيد الاستعمال لا شاشة الدخول وحدها (آبل 2.3.3).

### آبل

- [ ] ملف بيان خصوصية للتطبيق، والتحقق من بيانات كل مكتبة طرف ثالث مدرجة في قائمة آبل.
- [ ] نصوص أذونات الكاميرا والميكروفون والصور واضحة، ولا يُطلب إذن لا تحتاجه الوظيفة (5.1.1(iv)، 2.5.14).
- [ ] وضع الخلفية المستعمل هو جلسة `URLSession` خلفية لإتمام النقل فقط (2.5.4).
- [ ] إن استُعمل دخول من طرف ثالث، يُراجع الاستثناء في 4.8 الخاص بحسابات المؤسسة.
- [ ] لا يظهر داخل التطبيق أي رابط أو دعوة للشراء (3.1.3(c) والمقطع العام في 3.1.3).
- [ ] قرار القناة: عامة، أو غير مدرجة (Unlisted)، أو مخصصة عبر Apple Business Manager. والمخصصة لا تُختار إلا قبل الموافقة الأولى.

### جوجل

- [ ] `targetSdk` = 36 على الأقل لأي إرسال بعد 31 أغسطس 2026.
- [ ] إعلان الخدمة الأمامية `dataSync` (للأجهزة الأقدم) مع فيديو يُظهر بدء المستخدم للرفع، ووصف أثر التأجيل أو المقاطعة.
- [ ] التأكد من أن مسار UIDT يُجدول والتطبيق ظاهر للمستخدم، ويعرض إشعارًا.
- [ ] مراعاة حد الست ساعات في `dataSync` عند Android 15+.
- [ ] اختيار الوسائط عبر منتقي النظام، وعدم إدراج `READ_MEDIA_IMAGES` و`READ_MEDIA_VIDEO` إلا مع إعلان وتبرير.
- [ ] عدم إدراج `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`، كما تنص الخطة؛ فالحالات المقبولة لا تشمل رفع الملفات صراحة.
- [ ] تحديد نوع حساب المطوّر: الحساب الشخصي الجديد يحتاج 12 مختبِرًا لمدة 14 يومًا. والتأكد من التحقق من هوية المطوّر وتسجيل التطبيق.
- [ ] تقرير هل يحمل التطبيق وصف «news» أو يُدرج في فئة News & Magazines، لأن ذلك يُدخله في إعلان تطبيقات الأخبار وشروطه.
- [ ] قرار القناة: عامة، أو اختبار مغلق، أو تطبيق خاص في Managed Google Play.

## ما لم يُحسم بالمصادر

- كيف يتعامل المراجعون مع App Attest وPlay Integrity على أجهزتهم: لم يُعثر على نص رسمي.
- هل ينطبق إرشاد آبل 1.2 على رفع داخلي لا يُعرض للعموم: لا نص صريح.
- هل تخضع التطبيقات الخاصة في Managed Google Play لمراجعة السياسات نفسها: الصفحة الرسمية لا تذكر ذلك.
- هل ينطبق شرط الاختبار (12 مختبِرًا لمدة 14 يومًا) على حسابات المؤسسات: الصفحة تذكر الحسابات الشخصية فقط.
- المصادر هنا توثيق رسمي. لم تُجمع حالات رفض فعلية موثقة لتطبيقات صحفية، وما يُتداول في المنتديات لم يُعتمد مصدرًا.
