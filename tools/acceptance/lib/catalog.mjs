// One entry per row of the acceptance table in docs/plan/الخطة-النسخة-الثالثة.md ("اختبارات القبول").
// `mode`: "automated" runs in CI or against a live server; "field" needs a physical device and a human
// (step-by-step sheet in field/); "pending" is a placeholder until its package exists.
export const CATALOG = [
  { name: "upload-resume", mode: "automated", criterion: "ملف 5 غيغابايت مع ثلاثة انقطاعات وتبديل شبكة؛ استكمال الأجزاء الناقصة وحدها وتطابق البصمة الكاملة على الخادم، دون تكرار" },
  { name: "field-network-upload", mode: "pending", criterion: "ملف 1 غيغابايت على رابط رفع بسرعة 0.5 ميغابت/ث مع فقد حزم 30% وانقطاع كل دقيقتين؛ يتقدم الرفع ويكتمل، ويُسجَّل توزيع نافذة الاتصال المتواصل لكل مسار (tusd والمباشر)" },
  { name: "force-quit-restart", mode: "field", criterion: "على أجهزة فعلية: استئناف من آخر ما وصل بعد إغلاق التطبيق قسرًا، ونفاد البطارية، وإعادة التشغيل، وهاتف بمساحة حرة أقل من 1 غيغابايت" },
  { name: "concurrent-load", mode: "pending", criterion: "60 رفعًا متزامنًا بملفات 2 غيغابايت؛ لا تدهور في زمن الإشعار ولا في القرص المؤقت لخادم الرفع إن وُجد" },
  { name: "invalid-file", mode: "pending", criterion: "رفض واضح دون تعليق النظام أو ضياع بقية ملفات الحزمة" },
  { name: "proxy-accuracy", mode: "automated", criterion: "قص على النسخة الخفيفة يُصدَّر من الأصل بفارق لا يتجاوز 40 مللي ثانية عند 10 نقاط عشوائية في ملف هاتف بمعدل إطارات متغير، ومصدر HDR يظهر بألوان صحيحة في النسخة الخفيفة" },
  { name: "receipt-notification", mode: "pending", criterion: "مهمة واحدة خلال 60 ثانية من التحقق الفني في 95% من الاختبارات، وتصعيد العاجل بعد المهلة" },
  { name: "dynamic-fields", mode: "pending", criterion: "نشر إصدار نموذج جديد مع بقاء سجلات الإصدار السابق قابلة للقراءة، وإكمال مسودات الهاتف القديمة، ونتيجة متطابقة لاختبار المطابقة على الواجهات الثلاث (الجزء المشترك: form-conformance/)" },
  { name: "tenant-isolation", mode: "automated", criterion: "فشل كل محاولة من مؤسسة للوصول إلى ملفات ونتائج بحث وفواتير مؤسسة أخرى، بما يشمل الفهارس والنسخ المؤقتة" },
  { name: "pii-leak", mode: "automated", criterion: "لا إحداثيات GPS ولا معرّفات جهاز ولا أسماء محمية في أي معاينة أو تصدير أو إشعار غير مخوّل، على كل القنوات الخارجية" },
  { name: "cut-export", mode: "pending", criterion: "مطابقة نقاط القص المرجعية في صيغ الاختبار، وفارق تزامن صوت لا يتجاوز 40 مللي ثانية، ومعالجة صحيحة لـ HDR والاتجاه" },
  { name: "duplicate-payment", mode: "pending", criterion: "إعادة إشعار البوابة عشر مرات وبترتيب مختلف دون تكرار ترخيص أو قيد مالي" },
  { name: "refund", mode: "pending", criterion: "قيد عكسي صحيح لكل مساهم قبل الصرف وبعده، وظهوره في تقريري الإدارة والمصور" },
  { name: "rights-exclusivity", mode: "pending", criterion: "منع بيع مادة محظورة أو مجهولة الحقوق أو مشتقة منها، ومنع بيع الحصرية مرتين بما يشمل الطلبات المتزامنة" },
  { name: "payout", mode: "pending", criterion: "وصول مبلغ حقيقي إلى مراسلين في غزة والضفة عبر قناة واحدة على الأقل خلال 7 أيام، برسوم ومتطلبات موثقة" },
  { name: "recovery", mode: "pending", criterion: "استعادة قاعدة البيانات وعينة أصول من النسخة المعزولة لدى المزوّد الثاني ضمن الهدفين: فقد لا يتجاوز 15 دقيقة، واستعادة خلال 4 ساعات" },
  { name: "availability", mode: "pending", criterion: "إسقاط خادم وقاعدة بيانات ونشر أثناء الحمل؛ زمن التعافي يثبت الهدف المعلن" },
  { name: "ai-eval", mode: "pending", criterion: "تقييم على مجموعة الـ 100 مادة: لا تحريف وقائعي جسيم، وتوثيق نسبة الرفض لكل مزوّد على العينة الصادمة، ونسبة الأسماء المختلقة، وزمن التصحيح البشري وكلفة الدقيقة، وتحوّل المادة المرفوضة إلى المسار غير السحابي تلقائيًا" },
  { name: "performance", mode: "pending", criterion: "معاينة مقطع 10 دقائق بدقة 1080p ضمن الهدف المقيس في التأسيس، وبحث نصي أقل من ثانيتين في 95% من الطلبات على فهرس وحمل متفق عليهما" },
  { name: "urgent-template-export", mode: "pending", criterion: "تركيب طبقات الهوية على مقطع دقيقتين بدقة 1080p في زمن أقل من مدة المقطع على خادم التصدير المعتمد" },
  { name: "task-killers", mode: "field", criterion: "رفع 1 غيغابايت على جهازي Xiaomi وSamsung بعد قفل الشاشة 30 دقيقة يكتمل دون تدخل بعد شاشة التهيئة" },
  { name: "timestamp-alignment", mode: "field", criterion: "محاذاة صوتية بين النسخة الخفيفة والأصل بإزاحة لا تتجاوز 40 مللي ثانية على عشرة ملفات هاتف بمعدل إطارات متغير وفجوات زمنية" },
];

// Acceptance tests that come from the security decisions (docs/security/threat-model.md, SEC-01..SEC-07), not from a row of
// the plan's table. They have scripts and results like any other, but are not counted in the 22-row status table.
export const EXTRA = [
  { name: "session-revocation", mode: "automated", source: "SEC-01", criterion: "رمز مبطَل (جلسة أو كل الجلسات) يُرفض على الخادم وعلى مسار الرفع خلال ثوانٍ، والرفع الجاري يتوقف عند الجزء التالي" },
  { name: "field-upload-1gb", mode: "field", source: "plan stage (b)", criterion: "رفع 1 غيغابايت على شبكة ميدانية فعلية على iPhone وXiaomi وSamsung: يكتمل ببصمة خادم مطابقة وصفر بايت مفقود وبلا تدخل بشري بعد البدء" },
  { name: "emergency-wipe", mode: "field", source: "SEC-01", criterion: "على جهاز فعلي بعد المسح الطارئ: لا شيء من المخازن الموثّقة يبقى، ويتم المسح بلا اتصال خلال ثوانٍ، ويعمل الدخول من جديد" },
];

export const NAMES = [...CATALOG, ...EXTRA].map((t) => t.name);
export const byName = (name) => [...CATALOG, ...EXTRA].find((t) => t.name === name);
