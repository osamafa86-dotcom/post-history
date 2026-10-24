# مقارنة مشغّل الويب — #89

منصة محلية خلف WEB_PLAYER_BENCH=1 على عينات اصطناعية فقط، خارج مسارات تطبيق Next.js. تعتمد المقارنة على @videojs/react و@videojs/hlsjs-video 10.2.0 وshaka-player 5.3.2. تثبَّت الحزم المؤقتة في .artifacts/player-deps؛ التطبيق يعتمد Shaka وحده للمعاينة عبر BFF. لا نستعمل إضافات Video.js v8.

## الإعادة

من جذر المستودع، مع FFmpeg/ffprobe المتوافقين مع العامل:

```sh
PYTHONPATH=workers/media/src python3 tools/render-bench/web_fixtures/make_web_fixtures.py "$PWD/apps/web/.artifacts/player-fixtures"
cd apps/web
npm ci
WEB_PLAYER_BENCH=1 node scripts/player-bench/prepare.mjs
npx playwright install chromium
WEB_PLAYER_BENCH=1 npm run measure:player
```

يجب أن يدعم المتصفح H.264/AAC لعينات HLS؛ Chromium المرفق في بعض البيئات لا يدعمهما. لإعادة القياس المحفوظ استعمل Chrome Headless Shell 156.0.8078.47:

```sh
npx --yes @puppeteer/browsers install chrome-headless-shell@156.0.8078.47 --path .artifacts/browsers
WEB_PLAYER_BENCH=1 WEB_PLAYER_EXECUTABLE="$PWD/.artifacts/browsers/chrome-headless-shell/linux-156.0.8078.47/chrome-headless-shell-linux64/chrome-headless-shell" npm run measure:player
```

النتائج والصور في .artifacts/player-result. يُنتج السكربت measurement.json بمخطط العقود وchecks.json تفصيليًا، ويحفظ نسخة المتصفح وبصمة lock المؤقت ونسخة FFmpeg وأحجام المنصة المضغوطة. يخرج برمز غير صفري عند فشل فحص Shaka أو تسجيله اتصالات خارجية/مخالفات CSP/أخطاء صفحة أو HTTP. فشل مصغرات Video.js المسجّل متوقع، ولا يُخفى من النتيجة. افحص الصور قبل نسخ نتيجة نهائية إلى docs/measurements/web.

للتجربة التفاعلية على جهاز الاختبار:

```sh
WEB_PLAYER_BENCH=1 node --input-type=module -e 'const {serve}=await import("./scripts/player-bench/serve.mjs"); console.log((await serve()).origin)'
```

افتح الأصل المحلي المطبوع ثم /shaka?fixture=vfr-offset&locale=ar أو /videojs?fixture=hdr-hlg&locale=en. يرفض الخادم الحالات والمسارات غير المسموحة. يتلقى المشغّلان ملفات HLS وVTT نفسها دون تعديلها، ويستخدمان الموارد العربية والإنجليزية المحلية. تفعيل الترجمة في Video.js جزء من القياس لأن default track وحده لا يُظهرها في هذا المحوّل. لا CDN أو خطوط أو تحليلات خارجية.

## ما قيس

عينتان × مشغّلان × لغتان؛ 80 فحصًا. Shaka: 44/44؛ Video.js: 32/36، والفشل في صور sprite النسبية. يشمل القياس الإطارات الفعلية والترجمة وRTL المختلط والسطرين في Shaka، وتغيّر اقتصاص المصغرات، وSpace والبحث والصوت وTab ومفاتيح خارج المشغّل وملء الشاشة. تُعدّ الطلبات الخارجية وCSP وأخطاء الصفحة وHTTP لكل حالة.

النتيجة المحفوظة: docs/measurements/web/2026-10-24-player-choice.json، وقرار الاختيار ADR 0015. player-preliminary سجل تاريخي، وليس النتيجة الحالية. قياس Chrome Headless Shell على Linux ليس قياس Safari أو جهاز مكتبي تفاعلي؛ يبقى result=partial عند نجاح القياس المحلي بسبب البوابات غير المنفذة. WEB_PLAYER_BROWSER=webkit يصلح لتشخيص WebKit عند توافره، ولا يُسجّل بوصفه Safari فعليًا.

## قبول Safari والاعتماد بالخادم

على جهاز Apple فعلي، أعد توليد/نسخ العينات الاصطناعية وشغّل المنصة محليًا، وافحص الروابط الأربعة لكل مشغّل، والترجمة المختلطة والسطرين وتغيّر المصغرات والمفاتيح وملء الشاشة والشبكة. احفظ تقريرًا جديدًا بمخطط measurement.json مع جهاز Apple وmacOS/Safari الفعليين والنتائج غير المقيسة صراحةً؛ لا تعِد تسمية قياس Linux الحالي.

في التطبيق الحقيقي، لا يجيز توقيع download-url للكائن الواحد تحميل أعضاء HLS أو timeline. لذلك يستعمل MaterialPlayer مسار MP4 المصرّح به فقط. تفويض الأعضاء وTTL ومنع traversal مسؤولية عقد الخادم كما في تعليق #89 رقم 6376986201. لا اشتقاق للتوقيع ولا روابط تخزين مكشوفة، ولا تشغيل ملفات حقيقية ضمن منصة المقارنة.

فحوص التطبيق منفصلة: npm test وnpm run test:conformance وnpm run check:client وnpm run check:player وnpm run lint وnpm run typecheck وnpm run build وnpm run test:e2e؛ تتطلب اختبارات الجلسة Redis كما يوضح إعداد Playwright.
