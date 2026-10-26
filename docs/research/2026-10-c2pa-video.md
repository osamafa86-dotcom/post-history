# بحث: C2PA للفيديو الصحفي

- مسار العمل: Issue ‏#308 (بحث 3).
- تاريخ آخر تحقق من كل المصادر: **2026-10-26** ما لم يُذكر غيره.
- النطاق: حالة الأدوات المفتوحة لتوقيع MP4/MOV والتحقق منها وقيودها، وما نشرته مؤسسات إخبارية. **لا قرار ولا ADR**؛ القرار للمنسّق.
- السياق من الخطة: توقيع المواد بمعيار C2PA يثبت صدورها عن الشبكة ويسجّل التعديل، وكل تعديل آلي يُضمَّن لاحقًا في التوقيع؛ و«الأصل لا يُمس» و«لا بيانات كاشفة».
- لم يُوقَّع ولم يُرفع أي ملف أثناء هذا البحث؛ كل ما يلي من التوثيق المنشور.

## الخلاصة

1. الأدوات الثلاث (c2patool وc2pa-rs و`@contentauth/c2pa-node`) تدعم MP4 وMOV توقيعًا وقراءة، وكلها ما زالت **قبل الإصدار 1.0**، وواجهة c2pa-rs العامة «غير مستقرة».
2. حزمة `c2pa-node` القديمة **متقادمة ولا تُستعمل**؛ البديل `@contentauth/c2pa-node` في مستودع c2pa-js.
3. التوقيع بشهادة خاصة ممكن تقنيًا بأي شهادة X.509، لكن المحقق الخارجي لا يعرضها «موثوقة» إلا إن تسلسلت إلى **قائمة الثقة الرسمية لـ C2PA**، التي يحكمها برنامج المطابقة (Conformance). القائمة المؤقتة (ITL) **مجمّدة منذ 1 يناير 2026**.
4. أي إعادة ترميز أو قص بأداة لا تعرف C2PA تكسر الربط أو تحذف البيان؛ والمنصات الاجتماعية الكبرى تحذفه غالبًا. الحل في المعيار: بيان جديد يشير إلى السابق كمكوّن (ingredient)، و«الربط اللين» (علامة مائية/بصمة) لاستعادة البيان.
5. المؤسسات الإخبارية ما زالت في مرحلة تجارب للفيديو تحديدًا: BBC (2024)، Reuters/Sony (عرض سبتمبر 2026)، AFP/Dalet (إثبات مفهوم حتى الربع الأول 2027).

## حالة الأدوات المفتوحة

| الأداة | آخر إصدار عند التحقق | دعم الفيديو | التوقيع | الحالة | المصدر |
| --- | --- | --- | --- | --- | --- |
| c2patool (سطر أوامر) | `c2patool-v0.27.22` بتاريخ 2026-09-10 | MP4 ‏(`video/mp4`) وMOV ‏(`video/quicktime`) وAVI؛ «MP4 المجزأ (DASH) مدعوم فقط للعمليات على الملفات من مكتبة Rust»؛ أمر `fragment` مع `--fragments_glob` لمقطع التهيئة ومقاطع `.m4s` | مفتاح خاص وسلسلة شهادات PEM؛ الخوارزميات `es256` (افتراضي) و`es384` و`es512` و`ps256` و`ps384` و`ps512` و`ed25519`؛ خادم ختم زمني اختياري `tsa_url`؛ وفي الإنتاج «موقّع عبر عملية فرعية أو خدمة توقيع بعيدة كي لا يمر المفتاح بالأداة» | قبل 1.0 | [Releases](https://github.com/contentauth/c2pa-rs/releases)، [Supported formats](https://opensource.contentauthenticity.org/docs/sdk-repos/c2patool/docs/supported-formats/)، [Usage](https://opensource.contentauthenticity.org/docs/sdk-repos/c2patool/docs/usage/)، [Signing](https://opensource.contentauthenticity.org/docs/sdk-repos/c2patool/docs/signing/) |
| c2pa-rs (مكتبة Rust) | `c2pa-v0.91.6` بتاريخ 2026-10-24 (معلَّم pre-release على GitHub) | MP4 وMOV؛ وضع `BmffHash` للربط الصلب، و«صيغ BMFF تتطلب دائمًا حجزًا مسبقًا (placeholder)» عبر صندوق `uuid`؛ ويمكن تمرير بصمات Merkle لأجزاء `mdat` المحسوبة أثناء الكتابة أو الترميز لتجنب إعادة قراءة الملفات الكبيرة | كما في c2patool | «إصدار تجريبي (0.x.x)… وواجهته العامة غير مستقرة» | [Releases](https://github.com/contentauth/c2pa-rs/releases)، [Embeddable API](https://opensource.contentauthenticity.org/docs/c2pa-rs/docs/embeddable-api/)، [README](https://github.com/contentauth/c2pa-rs/blob/main/README.md) |
| `@contentauth/c2pa-node` | `0.9.10` بتاريخ 2026-10-16 (npm) | يقرأ ويتحقق ويضيف بيانات موقّعة «في الصيغ المدعومة» (نفس صيغ مكتبة Rust) | `LocalSigner` بشهادة ومفتاح، و`CallbackSigner` لتوقيع مخصص (يصلح لخزنة مفاتيح) | قبل 1.0؛ ثنائيات جاهزة لـ Linux ‏x86_64 وaarch64 وmacOS وWindows | [Node landing](https://opensource.contentauthenticity.org/docs/node-landing/)، npm ‏`npm view @contentauth/c2pa-node` (2026-10-26) |
| `c2pa-node` (القديمة) | `0.5.26`، آخر تعديل 2025-08-16 | — | — | «متقادمة ولا تُحدَّث ولا تُدعم. لا تستعملها» | [Node landing](https://opensource.contentauthenticity.org/docs/node-landing/)، npm (2026-10-26) |

## المعيار للفيديو

- الإصدار الحالي من المواصفة **2.4 (أبريل 2026)**، ويضيف دعم صيغ وتأكيدات جديدة وتسلسلًا بصيغة JSON وتحسينات للبث الحي ([C2PA 2.4](https://spec.c2pa.org/specifications/specifications/2.4/specs/C2PA_Specification.html)).
- الربط الصلب لملفات BMFF ‏(MP4/MOV) عبر تأكيد `c2pa.hash.bmff.v3` مع قائمة استثناءات، ويدعم أشجار Merkle للتحقق من أجزاء دون الملف كاملًا. وفي MP4 المجزأ يلزم `initHash` لمقطع التهيئة وصندوق `uuid` خاص؛ غيابه يعطي `assertion.bmffHash.malformed` (المصدر نفسه).
- البيان يُضمَّن في صندوق `uuid` خاص بـ C2PA داخل الملف (المصدر نفسه)، ويمكن بديلًا وضعه في ملف جانبي `.c2pa` (‏`--sidecar`) أو مرجع بعيد (‏`--remote`) ([c2patool usage](https://opensource.contentauthenticity.org/docs/sdk-repos/c2patool/docs/usage/)).
- الحجم والأداء: لم يُعثر على حد حجم منشور في الأدوات المفتوحة. الكلفة العملية أن التوقيع يتطلب تجزئة كل البايتات المغطاة، والإدراج يزيح مواضع الأجزاء داخل الحاوية؛ لذلك يوفر c2pa-rs تمرير بصمات محسوبة سلفًا ([Embeddable API](https://opensource.contentauthenticity.org/docs/c2pa-rs/docs/embeddable-api/)). أداة التحقق في Gemini مثال على قيود طرف ثالث: 100 ميغابايت ومقاطع أقل من 90 ثانية ([Google Gemini Help](https://support.google.com/gemini/answer/16722517)). أي رقم أداء لنا يحتاج قياسًا في `docs/measurements/`.

## التحقق من طرف ثالث

- **أداة Verify** من مبادرة أصالة المحتوى تقبل AVI وMOV وMP4 بين صيغ أخرى؛ حد الحجم غير منشور ([Verify](https://verify.contentauthenticity.org/inspect)).
- **سطر الأوامر:** `c2patool <file>` يطبع البيان، و`--info` يذكر هل تحقق البيان أم يعرض أخطاء التحقق ([Usage](https://opensource.contentauthenticity.org/docs/sdk-repos/c2patool/docs/usage/)).
- **Google:** بدأ التحقق من C2PA في تطبيق Gemini في 19 مايو 2026، ويصل إلى البحث وChrome «في الأشهر القادمة»، ويفحص هل المحتوى «أصلي غير معدّل من كاميرا أو عُدّل وبأي أدوات» ([Google Blog](https://blog.google/innovation-and-ai/products/identifying-ai-generated-media-online/?ref=ppc.land)).
- **«صالح» مقابل «موثوق»:** بحسب إرشادات النشر من C2PA ‏(يوليو 2026): «موثوق» تعني بيانًا سليمًا وموقّعه على قائمة الثقة الرسمية، و«صالح» تعني سليمًا تشفيريًا وقد لا يكون الموقّع على القائمة ([Deployment Guidance](https://c2pa.org/wp-content/uploads/sites/33/2026/07/Content-Credentials-Deployment-Guidance.pdf)).

## الشهادة الخاصة وقائمة الثقة

- قائمتان رسميتان: قائمة الثقة (جهات إصدار شهادات المولّدات المطابقة وفق سياسة شهادات C2PA) وقائمة الختم الزمني (TSA). شهادة المولّد يجب أن تتسلسل إلى القائمة الأولى، والختم الزمني يثبت أن التوقيع تم أثناء صلاحية الشهادة حتى بعد انتهائها أو إلغائها ([Trust lists](https://opensource.contentauthenticity.org/docs/conformance/trust-lists/)).
- القائمة المؤقتة (ITL) «مجمّدة منذ 1 يناير 2026»: لا شهادات جديدة، والقائم صالح للدعم القديم (المصدر نفسه).
- برنامج المطابقة انطلق في 4 يونيو 2025، وحتى 14 مايو 2026 اجتاز المطابقة 54 منتجًا من 31 شركة، مع طابور انتظار وأكثر من 120 شركة أبدت اهتمامًا ([Deployment Guidance](https://c2pa.org/wp-content/uploads/sites/33/2026/07/Content-Credentials-Deployment-Guidance.pdf))؛ وتفاصيل البرنامج على [صفحة المطابقة](https://c2pa.org/conformance/). خطوات الحصول على شهادة على القائمة غير مفصّلة في الصفحة.
- المعنى العملي: شهادة ذاتية التوقيع أو من جهة غير مدرجة تكفي للاختبار الداخلي وستظهر «صالحة» لا «موثوقة» عند الغير. ظهورنا «موثوقين» يتطلب منتجًا مطابقًا وشهادة من جهة مدرجة.
- أداة c2patool تحذّر: المفاتيح في ملفات الإعداد «للتطوير والاختبار فقط»، والشهادة المدمجة «لا تُستعمل في الإنتاج» ([Signing](https://opensource.contentauthenticity.org/docs/sdk-repos/c2patool/docs/signing/)).

## القيود: إعادة الترميز والتعديل وفقد البيان

- أي تعديل «مقصود أو عرضي» يكسر الربط التشفيري ويُظهر العبث ([C2PA FAQ](https://c2pa.org/faqs/)). وإعادة الترميز دون تحديث البيان تفشل في التحقق، والبث المتكيّف (HLS/DASH) يعيد الترميز وقد يحذف صناديق JUMBF ([IdenticAPI](https://www.identicapi.com/blog/ai-video-content-provenance)، طرف ثالث).
- المُرمِّز الذي لا يعرف C2PA قد يحذف البيان عند إعادة التغليف إلى MP4 أو MXF أو HLS؛ والممارسة الموصى بها: قراءة البيانات السابقة وتوليد بيان موقّع جديد يسجل فعل الترميز ويشير إلى السابق «مكوّنًا أبًا» ([SSL.com](https://www.ssl.com/article/preserving-c2pa-manifests-across-the-media-production-workflow/)، 9 يوليو 2026، جهة إصدار شهادات).
- المنصات (منتصف 2026، طرف ثالث): Instagram يحذف البيان من الملفات المعروضة، وYouTube يعيد ترميز كل شيء فلا يبقى بيان الملف في البث، وX يحذف البيانات الوصفية، وTikTok كان يحذف وأعلن إعادة إرفاقه لمحتوى التطبيق، وLinkedIn يعرض أيقونة الاعتماد ([Lumethic](https://www.lumethic.com/en/articles/content-credentials-social-media-platforms)).
- الاستعادة: المعيار يدعم «اعتمادات دائمة» عبر ربط لين (علامة مائية غير مرئية أو بصمة) لإعادة إيجاد البيان بعد حذفه ([C2PA FAQ](https://c2pa.org/faqs/)، [Guidance 2.4](https://spec.c2pa.org/specifications/specifications/2.4/guidance/Guidance.html)).
- **الخصوصية (ذو صلة بقاعدة «لا بيانات كاشفة»):** البيان قد يحمل تأكيدات بيانات وصفية تتضمن الموقع ومعلومات الجهاز. المواصفة تسمح بـ«حذف» (redaction) تأكيدات عند استعمال الأصل مكوّنًا، مع تسجيل الحذف في `redacted_assertions` وفعل `c2pa.redacted`، ومثالها الصريح حذف بيانات الموقع وإبقاء معلومات الكاميرا؛ لكن **لا يجوز حذف تأكيدات الأفعال** `c2pa.actions` ([C2PA 2.4](https://spec.c2pa.org/specifications/specifications/2.4/specs/C2PA_Specification.html)). وكذلك هوية الموقّع جزء من البيان المعروض ([Deployment Guidance](https://c2pa.org/wp-content/uploads/sites/33/2026/07/Content-Credentials-Deployment-Guidance.pdf)). أي بيان قادم من كاميرا المراسل يحتاج إذن فحصًا قبل أي معاينة أو تصدير.

## ممارسات منشورة لمؤسسات إخبارية

| الجهة | التاريخ | ما نُشر | المصدر |
| --- | --- | --- | --- |
| BBC | 4 مارس 2024 | ميزة «Content Credentials» على محتوى BBC Verify (صور وفيديو) في موقع BBC News وتطبيقه، بزر «كيف تحققنا من هذا» يعرض خطوات التحقق، مع تضمين الأصل وتاريخ التعديل في الوسائط. وBBC R&D شاركت في تأسيس C2PA عام 2019 | [BBC Media Centre](https://www.bbc.com/mediacentre/2024/content-credentials-bbc-verify) |
| BBC R&D | مارس 2024 | C2PA «لا يمكن استعماله آلية تحقق من الحقيقة»، بل يُظهر ما جرى على المادة؛ كل تعديل يوقّعه من أجراه فتتكون سلسلة؛ و«ما زال الطريق طويلًا» خاصة للفيديو والصوت | [BBC R&D](https://www.bbc.com/rd/blog/2024-03-c2pa-verification-news-journalism-credentials) |
| Reuters | 30 أغسطس 2023 (إعلان) | إثبات مفهوم بكاميرا Canon نموذجية توقّع كل صورة بمفتاح خاص بالجهاز، مع Starling Lab، والحفاظ على C2PA عبر تحرير مكتب الصور حتى النشر؛ والدرس: التوقيع أضاف زمن معالجة وأثّر على سرعة التسليم | [Reuters](https://www.reuters.com/media-center/reuters-new-proof-of-concept-employs-authentication-system-to-securely-capture-store-and-verify-photographs/)، [Reuters Agency](https://reutersagency.com/authenticity-poc) |
| Sony وReuters | 8 سبتمبر 2026 (عرض في IBC ‏11–14 سبتمبر) | سير عمل «شبه حي» لغرفة الأخبار يحفظ C2PA من التصوير حتى التوزيع لمقاطع MP4 مجزأة، مع علامة مائية لاستعادة البيان إن حُذف؛ ويؤكد أن C2PA لا يثبت صحة الحدث نفسه | [PTTL](https://www.pttl.gr/en/sony-reuters-c2pa-near-live-newsroom-workflow/) (ناقل خبر) |
| Canon | مايو 2026 | نظام Authenticity Imaging System متوافق مع C2PA للمؤسسات الإخبارية، يبدأ في أوروبا والشرق الأوسط وأفريقيا، لكاميرات EOS R1 وEOS R5 Mark II | [Canon UK](https://www.canon.co.uk/press-centre/press-releases/2026/05/canon-introduces-c2pa-compliant-authenticity-imaging-system-for-news-organisations/) |
| AFP وDalet | 23 سبتمبر 2026 | شراكة لدمج C2PA في سير عمل ترميز الفيديو الإخباري وتوزيعه إلى المذيعين، وإثبات مفهوم كامل «مقرر إنجازه في الربع الأول من 2027»؛ وسبقها إثبات مفهوم لقسم الصور في انتخابات أمريكا 2024 | [AFP](https://www.afp.com/en/agency/inside-afp/press-release/afp-and-dalet-partner-strengthen-provenance-and-authenticity-news) |
| Google | 19 مايو 2026 | Pixel 10 أول هاتف يضيف Content Credentials لصور الكاميرا الأصلية، مع توسيع إلى الفيديو على Pixel 8 و9 و10 «في الأسابيع القادمة»؛ وSynthID علامة مائية للمحتوى المولَّد؛ وتحقق C2PA في Gemini | [Google Blog](https://blog.google/innovation-and-ai/products/identifying-ai-generated-media-online/?ref=ppc.land) |
| AP | — | لم يُعثر على مصدر رسمي من AP عن تطبيق C2PA حتى تاريخ التحقق | بحث على الويب (2026-10-26) |

## أسئلة مفتوحة للمنسّق (بلا توصية)

- هل الهدف «صالح» (شهادة خاصة، للاستعمال الداخلي) أم «موثوق» (منتج مطابق وشهادة من جهة مدرجة)؟ الثاني مسار مطابقة له طابور.
- أين يُوقَّع: على الأصل عند الاستلام، أم على كل نسخة مشتقة، أم الاثنين بسلسلة مكوّنات؟ قاعدة «الأصل لا يُمس» تعني أن الإدراج داخل الأصل يغيّر بايتاته؛ الملف الجانبي `.c2pa` يحافظ عليه.
- كيف تُفحص بيانات C2PA القادمة من أجهزة المراسلين (موقع، جهاز) قبل أي تصدير.

## ما لم يُتحقق منه

- لم يُشغَّل أي توقيع أو تحقق؛ لا أرقام أداء أو حجم مقاسة. أي تجربة لاحقة تستعمل مقاطع اصطناعية فقط وتُحفظ نتيجتها في `docs/measurements/`.
- سلوك المنصات من مصدر طرف ثالث وقد تغيّر.
- لم يُعثر على حد حجم ملف رسمي في الأدوات المفتوحة.
