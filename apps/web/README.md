# نواة الويب — التذكرة #81

Next.js للقراءة بالعربية RTL والإنجليزية: الدخول، الوارد المرقّم، تفاصيل المادة، ومعاينة النموذج والتحقق المحلي. القرار والحدود في `docs/plan/decisions/0014-web-bff-generated-client.md`.

## التشغيل

Node.js 22، API الحالي، وRedis. من `apps/web`:

```bash
npm ci
cp .env.example .env.local
# املأ WEB_SESSION_KEY بقيمة عشوائية: openssl rand -base64 32
# واضبط API_BASE_URL وWEB_REDIS_URL وWEB_ORIGIN وWEB_MEDIA_ORIGINS.
npm run dev
```

يفتح `http://127.0.0.1:3100` العربية افتراضيًا. `npm run build && npm start` لبناء الإنتاج. إعداد HTTP المحلي لا يعمل إلا مع loopback؛ النشر يحتاج HTTPS، وإلغاء `WEB_ALLOW_INSECURE_LOCALHOST`، ومفتاح من خزنة الأسرار. لا متغير `NEXT_PUBLIC` يحمل بيانات اعتماد. لا تضع `.env.local` في Git.

الرمز الوحيد في المتصفح معرّف جلسة ويب داخل كوكي `HttpOnly`، ورموز API مشفّرة في Redis. قراءة البيانات عبر BFF تضيف مصادقة الخادم ولا تقبل عنوان API من المستخدم. لا localStorage ولا حفظ نماذج محلي ولا اتصال بخطوط أو تحليلات خارجية.

## الفحوص

بناءً على توجيه المنسّق في #81، العميل مولّد مؤقتًا من فرع `agent/contracts/v0.1-post-freeze` في #58 عند `fc9e627514ade2e9857f3da8358de074f462e768`، لاحتوائه نقطة روابط المشتقات. لا توجد نسخة يدوية من المخطط داخل الحزمة. من جذر المستودع:

```bash
git fetch origin agent/contracts/v0.1-post-freeze
git worktree add --detach ../post-history-contracts fc9e627514ade2e9857f3da8358de074f462e768
export WEB_CONTRACT_ROOT="$(pwd)/../post-history-contracts/contracts"
cd apps/web
```

CI يقرأ الرأس نفسه في checkout مستقل. بعد دمج #58 يُحذف checkout المؤقت ومتغيره من وظيفة `web`، ويُعاد التوليد من `main` دون `WEB_CONTRACT_ROOT`. استخدام عقد `main` القديم الآن يجعل فحص المطابقة يفشل عمدًا.

```bash
npm run lint
npm run typecheck
npm run check:client
WEB_TEST_REDIS_URL=redis://127.0.0.1:6379/1 npm test
npm ci --prefix ../../tools/acceptance
npm run test:conformance
npm run build
npx playwright install chromium --only-shell
WEB_TEST_REDIS_URL=redis://127.0.0.1:6379/1 npm run test:e2e
node scripts/validate-measurements.mjs
```

اختبار Redis وحده يُتخطى إذا غاب عنوان الاختبار محليًا؛ CI يمرره ويشغّله إلزاميًا. اختبارات المتصفح تحتاج Redis أيضًا؛ Playwright يبدأ API اصطناعيًا على 3201 وNext.js على 3100، ويستعمل بيانات مخترعة فقط. النصوص المشتركة للنماذج تُقرأ من موضعها، ولا يشغّل الويب التنفيذ المرجعي بدل مدققه.

`tests/media-fixture.json` عينة هندسية مولّدة محليًا بـ FFmpeg: مستطيلان ملونان لمدة ثانيتين وPNG، دون أي محتوى مراسلين. ملف MP4 الاختباري بترميز VP9 لأن Chromium المفتوح المصدر في Playwright لا يدعم H.264؛ الاختبار يثبت تشغيل HTML5 ومسار BFF وتجديد الرابط، ولا يثبت توافق خرج العامل H.264 مع كل المتصفحات. يلزم اختبار ذلك في Chrome/Safari/Firefox المستهدفين مع API والعامل الفعليين قبل النشر.

`npm run generate:client` يعيد توليد المصدر الملتزم عند تغيير العقد من مالكه. `check:client` يولّد إلى مجلد مؤقت ويفشل عند أي فرق، ولا يصلح الفرق تلقائيًا.

## إعادة القياس

شغّل Redis، ثم `node --import tsx scripts/fixture-api.ts`، واضبط `API_BASE_URL=http://127.0.0.1:3201/v1` وإعدادات BFF المحلية، وابنِ وشغّل `npm start`. من نافذة أخرى: `npm run measure`. يستخدم السكربت حساب الاختبار الاصطناعي فقط؛ لا يُشغَّل ضد API الإنتاج. اجتياز أربع صفحات يثبت وجود 200 مادة؛ زمن العرض الأول يخص أول 50 صفًا، كما يصرّح ملف القياس. يمكن تغيير مسار الملف الناتج بـ `WEB_MEASUREMENT_OUTPUT`.

## حدود العقد الحالي

- `getDerivativeUrl` يستهلك `/materials/{id}/files/{file_id}/download-url` المضاف في #58. يعرض MP4 والمصغّرات `verified` عبر BFF من النطاق نفسه؛ لا يُرسل رابط التخزين إلى المتصفح. كل طلب Range يعيد فحص الجلسة والمادة ويأخذ رابطًا جديدًا بعمر ≤10 دقائق. إعادة محاولة واحدة عند فشل الوسائط، ثم رسالة غير متاح وزر إعادة المحاولة.
- `WEB_MEDIA_ORIGINS` قائمة أصول تخزين المشتقات التابعة للمشروع فقط؛ الفراغ يمنع المعاينات. لا redirects ولا Authorization أو Cookie نحو التخزين؛ MIME مقيد بـ MP4 وJPEG/PNG/WebP. الأصل والملاحظة الصوتية وHLS ليست مسارات عرض متاحة في هذه التذكرة. الترويسات مهلة 8 ثوانٍ، والجسم يُبث دون تجميع بمهلة 120 ثانية لكل طلب؛ يلزم ضبط المهلة والبنية للروابط البطيئة قبل النشر.
- تشغيل الخادم الحقيقي يعتمد على دمج وتنفيذ نقطة العقد الجديدة؛ عند غيابها تظهر المعاينة غير متاحة. الاختبارات تثبت المسار على بيانات اصطناعية ولا تدّعي جاهزية API المنشور.
- اسم `real_name` غير متاح؛ يستخدم الاسم المستعار أو اسم الشبكة أو بديلًا عامًا.
- الفرز محلي للصفحة فقط؛ المرشحات المرسلة للخادم أعمدة صريحة من العقد.
- GPS writeOnly؛ لا حقول location/sensitive منشورة في v0. الحجب على BFF والراسم احترازي ويُختبر بالصلاحيتين منفصلتين.
- API اصطناعي في اختبارات المتصفح والقياس؛ ليس اختبار نشر كامل على PostgreSQL أو أجهزة الفريق الفعلية.
- اختبار المرفق يطابق القيمة المجردة `{mime, size_bytes}` للحَكَم المشترك؛ لا يرسلها إلى API ولا ينفذ رفع المرفقات. قيمة الحفظ النهائية يحددها `attachment-value.json` عند بناء مسار الكتابة لاحقًا.
