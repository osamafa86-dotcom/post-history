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

## مواد مشغّل الويب (`web_fixtures/`)

لاختبار المشغّل في `apps/web` (#89) بلا أي ملف حقيقي. `make_web_fixtures.py` يولّد بكود العامل نفسه حالتين: 1080p بمعدل متغير وبداية 2 ث، وHEVC 10 بت HLG محوّلًا إلى SDR. لكل حالة:

- `hls/index.m3u8` بمقاطع fMP4، و`proxy.mp4`.
- `timeline/sprite.jpg` و`timeline/thumbnails.vtt` بإشارات `#xywh`، كما يكتبها العامل خلف `MEDIA_ENABLE_HLS`.
- `captions.ar.vtt`: ترجمة عربية فيها أرقام وكلمة لاتينية وسطران في إشارة واحدة.
- `manifest.json`: الأبعاد والمدة و`start_pts_us` وعدد الإشارات المتوقع.

يُشغَّل في وظيفة `media`، والمساران الملفان يقرؤهما Chrome مسارَي `<track>` صالحين (3 إشارات و7).

```bash
docker run --rm -v "$PWD/tools/render-bench/web_fixtures:/wf:ro" -v /tmp/wf:/out media-worker:test python /wf/make_web_fixtures.py /out
```
