# أصول متجر App Store

- `icon/AppIcon-1024.png` (+ `AppIcon.svg` المصدر): أيقونة التطبيق 1024×1024 RGB بلا شفافية. مالك iOS ينسخها إلى `App/Resources/Assets.xcassets/AppIcon.appiconset/`.
- `metadata/{ar-SA,en-US}/`: `name.txt` (≤30)، `subtitle.txt` (≤30)، `promotional_text.txt` (≤170)، `description.txt`، `keywords.txt` (≤100). رمز العربية في App Store Connect هو `ar-SA` لا `ar`.
- `screenshots/{ar-SA,en-US}/iphone69-1.jpg … iphone69-5.jpg` (iPhone 6.9″، 1320×2868؛ الترتيب بالاسم): بنية `fastlane deliver` — مجلد اللغة مباشرة تحت `screenshots/` بلا مجلدات فرعية، و`deliver` يستنتج الجهاز من المقاس.
- **لا لقطات iPad:** التطبيق لـ iPhone فقط (`TARGETED_DEVICE_FAMILY: "1"` في `apps/ios/project.yml`)، فلا تُرفع لقطات iPad ولا تُولَّد.
- كل لقطات الشاشة تعرض **بيانات اصطناعية** موسومة بذلك على الصورة؛ لا مواد حقيقية ولا مواقع ولا أسماء ولا معرّفات.
- النصوص لا تدّعي ما لم يُقَس (`CLAUDE.md` §5): النسخة الخفيفة «تصل قبل الأصل» لا «خلال دقائق»، والرفع «يستأنف من آخر جزء مؤكَّد عند عودة الاتصال أو فتح التطبيق من جديد» لا «بعد إغلاق التطبيق أو إعادة تشغيل الجهاز»، وملاحظات المشرف بلا «على التوقيت».
- التوليد: `node docs/design/store-assets/generate.cjs` (يقرأ `docs/design/tokens.json`؛ يحتاج Playwright وChromium). لا روابط ولا نطاقات في هذه الملفات؛ `privacy_url` و`support_url` يضيفهما المنسّق في App Store Connect، و«App Privacy» هناك يطابق نص الوصف.
