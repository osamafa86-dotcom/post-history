# workers/media

عامل الوسائط (Python 3.12 + FFmpeg 8.0.1). الاتفاقيات في `CLAUDE.md`، والواجهة مع الخادم في ADR 0006.

## البصمة الرخيصة (`client_fingerprint`)

ما يحسبه العامل وما يجب أن يحسبه تطبيقا الهاتف حرفيًا حتى تتطابق القيم:

- `size_bytes`: حجم الملف بالبايت.
- `head_sha256`: SHA-256 لأول **1 MiB = 1,048,576 بايت** (لا 1,000,000).
- `tail_sha256`: SHA-256 لآخر 1 MiB.
- ملف أصغر من 1 MiB: الرأس والذيل كلاهما الملف كله.
- القيم بأحرف hex صغيرة.

البصمة الرخيصة ترشّح المكررات فقط ولا تمنح حقًا؛ الربط بملف موجود لا يتم إلا بتطابق SHA-256 الكاملة على الخادم. «ميغابايت» في العقد تعني 1 MiB، ويُثبَّت ذلك في `contracts/` بعد التجميد.

## المشتقات في حاوية الوسائط

كلها في `S3_BUCKET_MEDIA` تحت `derived/<material_id>/<file_id>/`، و`file_id` هو ملف الأصل المتحقق منه:

| الملف | ما هو | التسجيل في الخادم |
| --- | --- | --- |
| `proxy-480p.mp4` | النسخة الخفيفة: الضلع القصير 480، إطار مفتاحي كل ثانية، `-copyts`، HDR يُحوَّل إلى SDR | `kind=proxy` |
| `poster.jpg` | إطار الملصق: الضلع القصير 720، عند 1 ث أو أول إطار غير أسود (2 ث، ثم ربع المدة، ثم البداية) | `kind=thumbnail` حين يقبله الخادم |
| `contact-sheet.jpg` | صفيحة اتصال: 10 إطارات متساوية التباعد، 5×2، عرض الخانة 320 | لا يُسجَّل؛ اسمه ثابت بجوار الملصق |
| `waveform.json` | موجة الصوت: ذروات مطبّعة 0–1 بنحو 100 نقطة/دقيقة، بلا بيانات وصفية | `kind=audio` حين يقبله الخادم |
| `hls/index.m3u8` (+ `init.mp4`، `seg_*.m4s`) | HLS fMP4 بمقاطع ~4 ث من النسخة الخفيفة بلا ترميز ثانٍ؛ خلف `MEDIA_ENABLE_HLS` | `kind=hls` (عقد #58) |
| `export.zip` | حزمة المونتاج: `clip.<ext>` (نسخ تيارات الأصل بلا ترميز إلى ملف جديد بلا أي وسوم ولا مسارات بيانات أو ترجمة؛ الأصل المخزَّن لا يدخل الحزمة)، `proxy.mp4`، `metadata.json` (قائمة بيضاء بلا بيانات كاشفة)، `sequence.fcpxml` (1.9) و`sequence.edl` (CMX3600) بلقطة واحدة، `SHA256SUMS`؛ خلف `MEDIA_ENABLE_EXPORT` | `kind=export` حين يقبله العقد |
| حزمة تسليم المشتري (`delivery.build_delivery`) | بنود قالب الترخيص: `original` (نسخ تيارات بلا وسوم)، `audio` (WAV 48 kHz)، `stills` (خمس صور بالدقة الكاملة)، و`produced`/`transcript` إن مُرِّرا وإلا `not_available`؛ `manifest.json` و`SHA256SUMS` | ينتظر حدث التسليم ونوعه في العقد |

المصغّرات بلا وسوم ولا EXIF. هي ونسخة الخادم `proxy-480p.mp4` تُصنع لكل أصل مرئي، حتى حين تصل النسخة الخفيفة من الهاتف؛ العمّال اللاحقون يقرؤون نسخة الخادم.

## التشغيل

```bash
docker build --target test -t media-worker:test workers/media && docker run --rm media-worker:test
python -m media_worker {probe,digest,proxy} FILE [OUT]   # داخل الصورة
python -m media_worker requeue-dead config_error          # يعيد أحداث media:dead بسبب معيّن إلى الطابور
```
