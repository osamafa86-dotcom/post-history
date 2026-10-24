# مقارنة مشغّل الويب — #89

منصة قياس محلية خلف `WEB_PLAYER_BENCH=1`، لا مسار إنتاج ولا بيانات مستخدمين. لا تحمل حزمة التطبيق أيًا من المشغّلين نتيجة هذه التجربة: اعتماديات المقارنة معزولة في `.artifacts/player-deps`. الإصدار الفعلي الذي تحقق منه npm: `@videojs/react@10.2.0`، `@videojs/hlsjs-video@10.2.0`، `shaka-player@5.3.2`. حزمة `video.js@10.2.0` موجّه تثبيت؛ لا نستعمل واجهة v8 القديمة.

## الإعادة

من جذر المستودع، باستخدام FFmpeg/ffprobe المتوافقين مع العامل:

```sh
PYTHONPATH=workers/media/src python3 tools/render-bench/web_fixtures/make_web_fixtures.py "$PWD/apps/web/.artifacts/player-fixtures"
cd apps/web
WEB_PLAYER_BENCH=1 node scripts/player-bench/prepare.mjs
WEB_PLAYER_BENCH=1 node --input-type=module -e 'const {serve}=await import("./scripts/player-bench/serve.mjs"); console.log((await serve()).origin)'
```

افتح الأصل المحلي المطبوع ثم `/videojs?fixture=vfr-offset` أو `/shaka?fixture=hdr-hlg`. الحالتان مسموحتان مع المشغّلين. التنفيذ يثبّت الحزم داخل مجلد مؤقت؛ لا يغيّر package.json/lock للتطبيق. سجل package-lock المؤقت مع القياس عند إعادة الاختبار.

المشغّلان يتلقيان ملفات العامل نفسها دون إعادة كتابة VTT أو تغيير مقاطعه. إعداد Video.js يستعمل محوّل HLS.js مع تعطيل العامل Blob للمحافظة على CSP. Shaka يستعمل واجهته المحلية مع حذف تعريف الخط الخارجي من CSS أثناء بناء التجربة. لا خطوط ولا CDN ولا تحليلات خارجية.

## ما يجب قياسه قبل اعتماد ADR 0015

- تشغيل HLS، فك إطارات فعلية، والتنقل في حالتي VFR/HLG على Chrome وSafari فعليين، مع الإصدار والجهاز.
- ترجمة عربية بثلاث إشارات، نص مختلط مع 10:30 وReuters، وسطرين؛ مراجعة الاتجاه بصريًا وعدم تغطية أدوات التحكم للنص.
- ظهور صورة شريط الزمن من VTT وصفيحة العامل، بما في ذلك اقتصاص خانات مختلفة.
- Space للتشغيل والإيقاف، الأسهم للتنقل والصوت، Tab للوصول، وملء الشاشة، دون اختطاف مفاتيح الصفحة.
- تعداد الاتصالات الخارجية ومخالفات CSP والأخطاء؛ اختبار إنهاء المشغّل عند مغادرة الصفحة وإبطال الجلسة عند ربطه بالـBFF.

النتائج الأولية في `docs/measurements/web/2026-10-24-player-preliminary.json` **partial**، وليست قبولًا نهائيًا. Chrome Headless Shell ليس تجربة متصفح مكتبي تفاعلية، وWebKit الآلي ليس Safari. التذكرة لم تنجز بعد، ولم يُستبدل مشغّل صفحة المادة.

## اعتماد الخادم

على main `c6df46c`، توقيع download-url لكائن واحد لا يجيز ملفات HLS التابعة. العامل لا يسجّل init/segments أو timeline كملفات مستقلة. نحتاج عقدًا وتفويضًا لقراءة الأعضاء قبل دمج HLS/المصغرات في صفحة مادة حقيقية؛ التفاصيل في تعليق #89 رقم 6376986201. لا اشتقاق لتوقيع جديد ولا كشف لتوقيع التخزين في المتصفح.
