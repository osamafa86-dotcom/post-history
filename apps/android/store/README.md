# أصول متجر Google Play

- `metadata/android/{ar,en-US}/images/`: `icon.png` 512×512 (PNG 32 بت RGBA بألفا معتمة كلها، كما تشترط Play)، `featureGraphic.jpg` 1024×500، `phoneScreenshots/1..5.jpg` 1080×1920 (بنية fastlane supply المعتمدة هنا).
- `icon/`: `play-store-icon-512.png` (RGBA معتمة)، و`ic_launcher_foreground-432.png` (RGBA، العلامة داخل منطقة الأمان 264px) و`ic_launcher_background-432.png` (معتمة) للأيقونة التكيفية. مالك أندرويد يحوّلهما إلى `mipmap-anydpi-v26`/`drawable`.
- **مجموعة أندرويد بلا نسخة خفيفة:** الوسيط بـ Media3 Transformer مؤجَّل، ولقطة متجر بميزة غير موجودة مخالفة لسياسة Play؛ فاللقطات 1 و2 و4 لا تذكر النسخة الخفيفة، وشريط الحالة بنمط أندرويد.
- كل لقطات الشاشة تعرض **بيانات اصطناعية** موسومة بذلك على الصورة؛ لا مواد حقيقية ولا مواقع ولا أسماء ولا معرّفات.
- التوليد: `node docs/design/store-assets/generate.cjs` (يقرأ `docs/design/tokens.json`).
