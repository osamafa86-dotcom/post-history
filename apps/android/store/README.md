# أصول متجر Google Play

- `metadata/android/{ar,en-US}/images/`: `icon.png` 512×512، `featureGraphic.jpg` 1024×500، `phoneScreenshots/1..5.jpg` 1080×1920 (بنية fastlane supply المعتمدة هنا).
- `icon/`: `play-store-icon-512.png`، و`ic_launcher_foreground-432.png` و`ic_launcher_background-432.png` للأيقونة التكيفية (العلامة داخل منطقة الأمان 264dp). مالك أندرويد يحوّلهما إلى موارد `mipmap`/`drawable`.
- كل لقطات الشاشة تعرض **بيانات اصطناعية** موسومة بذلك على الصورة؛ لا مواد حقيقية ولا مواقع ولا أسماء ولا معرّفات.
- التوليد: `node docs/design/store-assets/generate.cjs` (يقرأ `docs/design/tokens.json`).
