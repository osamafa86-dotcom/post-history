# قالب المواد المتداولة — التحريك (Remotion)

تحريك القالب المرسوم في Figma (صفحة `Video Template · مواد متداولة`)، ومواصفته في `docs/design/specs/video-template.md`. مشروع تصميم مرجعي يملكه دور تصميم المنتج: يُبنى منه خط التصدير، ولا يُستدعى من الخادم كما هو.

## التشغيل

```bash
cd docs/design/redesign-2026-11/motion/circulated-template
npm ci
npm run studio            # المعاينة في Remotion Studio وتعديل المعاملات
npm run typecheck
```

## التركيبات

| المعرّف | المقاس | الخلفية |
|---|---|---|
| `Circulated-Vertical` | 1080×1920 | صورة تجريبية |
| `Circulated-Vertical-ThreeLines` | 1080×1920 | صورة تجريبية |
| `Circulated-Horizontal` | 1920×1080 | صورة تجريبية |
| `Circulated-Square` | 1080×1080 | صورة تجريبية |
| `Overlay-Vertical` | 1080×1920 | شفافة، تُركَّب فوق المقطع |
| `Check-LongLine` | 1080×1920 | صورة تجريبية؛ سطر من 39 حرفًا يصغر ثم يلتفّ |

النصوص في كل التركيبات نصّ تجريبي ظاهر («عنوان تجريبي للمادة المتداولة»، «مدينة، محافظة»)، لا عناوين أخبار ولا أماكن حقيقية.

## المعاملات

| المعامل | النوع | القاعدة |
|---|---|---|
| `titleLines` | `string[]` | سطر إلى ثلاثة؛ ما زاد يُهمل. يقسمها المحرّر على معنى الجملة. السطر الأطول من عرضه يصغر حتى 80% ثم يلتفّ (`fitText` من `@remotion/layout-utils`) |
| `location` | `string` | المدينة والمحافظة وحدهما، بلا إحداثيات |
| `tag` | `string` | «مشاهد متداولة» افتراضيًا |
| `layout` | `vertical` · `horizontal` · `square` | المقاسات من إطارات Figma |
| `background` | `plate` · `none` | `none` لطبقة شفافة |
| `reducedMotion` | `boolean` | تلاشٍ وحده، بلا انزلاق ولا مسح ولا موجات ولا تكبير للصورة |
| `durationInSeconds` | `number` | طول المقطع المتداول؛ الخروج في آخر 0.6 ث |

## التصدير

المعاينة:

```bash
npx remotion render src/index.ts Circulated-Vertical out/vertical.mp4 --codec=h264 --crf=20
```

الطبقة الشفافة، ثم تركيبها فوق المقطع بـ FFmpeg (المسار نفسه المعتمد في `tools/render-bench/urgent_template`):

```bash
npx remotion render src/index.ts Overlay-Vertical out/overlay.mov \
  --codec=prores --prores-profile=4444 --pixel-format=yuva444p10le --image-format=png \
  --props='{"titleLines":["…","…"],"location":"…","tag":"مشاهد متداولة","layout":"vertical","background":"none","reducedMotion":false,"durationInSeconds":42}'
```

```bash
ffmpeg -i clip.mp4 -i out/overlay.mov \
  -filter_complex "[0:v][1:v]overlay=format=auto,format=yuv420p" -c:a copy out/final.mp4
```

القياس في `docs/measurements/render-bench/2026-11-02-circulated-template.json`: 240 إطارًا (8 ثوانٍ) على 4 أنوية:

- المعاينة بـ H.264 في 26.2 ثانية، وذروة الذاكرة 1.7 غيغابايت.
- الطبقة الشفافة في 40.7 ثانية، وخرجت `yuva444p12le` (يُكتب ProRes 4444 بعمق 12 بت ولو طُلب 10). حجمها نحو 58 ميغابايت للثانية.
- التركيب بـ FFmpeg في 11.4 ثانية.

ومعه تباين الشعار فوق الأبيض.

## ما في `public/`

- `fonts/`: Rubik Bold وReadex Pro SemiBold من تطبيق iOS، ورخصتا OFL. لا خط من الشبكة ولا من النظام.
- `brand/palpost-logo-white.png`: الشعار الأبيض من `docs/design/redesign-2026-11/brand/`.
- `plates/`: خلفيات اصطناعية يرسمها `docs/design/redesign-2026-11/tools/make-plates.py` من الصفر (تدرّج سماء، وخط أبنية، وأضواء مموّهة، وتظليل، وحبيبات)، فلا صورة ولا لقطة ولا مادة من طرف ثالث، ولا مصدر ولا رخصة تُنسب. الناتج ثابت لكل تشغيل، وPillow لا يكتب EXIF: في الملفات ترويسة JFIF وحدها (فُحصت بـ exiftool). وإطارات Figma رُسمت على تشغيل أقدم للمولّد نفسه، قبل أن تصير الحبيبات بذرة ثابتة.

```bash
python3 docs/design/redesign-2026-11/tools/make-plates.py docs/design/redesign-2026-11/motion/circulated-template/public/plates
```

ومخرجات التصدير والصور الثابتة في `out/`، وهو خارج المستودع (`.gitignore`).
