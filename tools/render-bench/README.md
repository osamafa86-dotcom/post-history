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

## تصدير القالب العاجل (`urgent_template/` و`urgent_bench.py`)

اختبار القبول «تصدير القالب العاجل»: تركيب طبقات الهوية على مقطع دقيقتين 1080p في زمن أقل من مدة المقطع.

- **الطبقات:** `urgent_template/` مشروع Remotion (شريط الاسم وشارة «عاجل») بخلفية شفافة، والنص العربي بخط Noto Naskh Arabic من الحزمة لا من النظام.
- **المسار المعتمد:** طبقات ProRes 4444 يركّبها FFmpeg فوق الفيديو بين مقدمة وخاتمة جاهزتين، في ترميز واحد.
- **الاحتياطي:** libass بالنصوص والتوقيتات والخط نفسها.
- **الناتج:** زمن كل مسار، وإطار من كل منهما للمقارنة (`--frames`).

```bash
cd tools/render-bench/urgent_template && npm ci
npx remotion render src/index.ts LowerThird /tmp/ut/lower.mov --codec=prores --prores-profile=4444 --pixel-format=yuva444p10le --image-format=png
npx remotion render src/index.ts Breaking /tmp/ut/breaking.mov --codec=prores --prores-profile=4444 --pixel-format=yuva444p10le --image-format=png
mkdir -p /tmp/ut/fonts && cp node_modules/@fontsource/noto-naskh-arabic/files/noto-naskh-arabic-arabic-{400,700}-normal.woff /tmp/ut/fonts/
docker run --rm -v "$PWD/..:/bench:ro" -v /tmp/ut:/ut -w /bench --entrypoint python media-worker:base urgent_bench.py \
  --overlays /ut --font-dir /ut/fonts --remotion-render-s <زمن الرسم> --out /ut/urgent.json
```

ترخيص Remotion مجاني حتى 3 موظفين (الخطة)، ثم ترخيص شركة.
