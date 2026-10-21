# render-bench

قياس زمن تصدير القالب العاجل. يملكه وكيل الوسائط.

- المقارنة: (أ) طبقات Remotion قصيرة بقناة شفافية (شريط اسم، عنوان، شارة) يركّبها FFmpeg فوق مقطع دقيقتين 1080p بـ NVENC؛ (ب) رسم الفيديو كاملًا بـ Remotion؛ (ج) libass لرسم النصوص العربية.
- المقياس: زمن التصدير مقابل مدة المقطع، واستهلاك المعالج، وجودة تشكيل العربية في كل خيار (فحص بصري موثق).
- معيار القبول: تركيب الطبقات في زمن أقل من مدة المقطع على خادم التصدير المعتمد.
- المخرج بمخطط `contracts/schemas/measurement.json` في `docs/measurements/render-bench/`.

## تزامن الصوت والصورة في النسخة الخفيفة (`av_sync.py`)

يقيس ما يضيفه خط النسخة الخفيفة (`workers/media`، `make_proxy`) إلى تزامن الصوت والصورة. المعيار 40 ms.

- **المقاطع:** اصطناعية بعلامات تزامن معروفة: ومضة بيضاء في الصورة ونبضة 1 kHz في الصوت، في اللحظة نفسها، كل ثانيتين. الحالات:
  - 10 ث و2 دقيقة، 1080p30.
  - 10 ث بمعدل إطارات متغير وبداية عند 3.5 ث، كما تسجّل الهواتف.
  - 10 ث HDR (HEVC 10 بت BT.2020) بـ HLG وبـ PQ: النسخة تمر بخريطة الألوان إلى SDR، ويُشترط أيضًا كشف HDR في المصدر وأن تكون النسخة SDR 8 بت.
- **الكشف:** ffmpeg واحد لكل ملف، بـ `-copyts`، فالصورة والصوت على خط زمني واحد.
  - الصورة: أول إطار في كل ومضة، بـ `signalstats`.
  - الصوت: بداية كل نبضة بدقة العينة، بـ `silencedetect`.
- **المقاييس:**
  - الإزاحة المضافة: صوت − صورة في الناتج، ناقص المقدار نفسه في المصدر.
  - انزياح العلامات بين المصدر والناتج.
  - انحراف المدة.
- **النتيجة:** `pass` فقط إن قيست المجموعة كلها ونجحت كل حالة، وإلا `partial` أو `fail`. تُكتب في `docs/measurements/render-bench/` (`tools/CLAUDE.md`).
- **الاختبار:** `test_av_sync.py` يشغّل الحالتين القصيرتين، ويتحقق من أن الكاشف يرى تأخيرًا مصطنعًا قدره 100 ms، فلا يمر القياس لأن الكاشف أعمى.
- **التحصين:** القراءة كما في العامل (`INPUT_GUARD`، `-nostdin`، بيئة نظيفة). لا ملفات حقيقية ولا مزوّد خارجي.

```bash
docker build --target base -t media-worker:base workers/media
docker run --rm -v "$PWD":/repo -w /repo -e PYTHONPATH=/repo/workers/media/src --entrypoint python \
  media-worker:base tools/render-bench/av_sync.py --out docs/measurements/render-bench/<date>-proxy-av-sync.json
```

## القص والتصدير (`cut_export.py`)

اختبار القبول «القص والتصدير» على `media_worker.render`. مصادر بعلامات ومضة/نغمة (`av_sync.make_source`)، وثلاثة مقاطع بنقاط قص عشوائية ثابتة البذرة.

- **المرجع:** من طوابع إطارات المصدر الفعلية.
- **المعيار:** خطأ القص إطار واحد على الأكثر، والتزامن 40 ms، وHDR يخرج SDR، والعمودي بأبعاد العرض.
- **الاختبار:** `test_cut_export.py` حالة قصيرة، ويتحقق من أن المرجع يرى قصًا منزاحًا.

```bash
docker run --rm -v "$PWD":/repo -w /repo -e PYTHONPATH=/repo/workers/media/src:/repo/tools/render-bench --entrypoint python \
  media-worker:base tools/render-bench/cut_export.py --out docs/measurements/render-bench/<date>-cut-export.json
```
