# أصول متجر App Store

- `icon/AppIcon-1024.png` (+ `AppIcon.svg` المصدر): أيقونة التطبيق 1024×1024 بلا شفافية. مالك iOS ينسخها إلى `App/Resources/Assets.xcassets/AppIcon.appiconset/`.
- `metadata/{ar,en-US}/`: `name.txt` (≤30)، `subtitle.txt` (≤30)، `promotional_text.txt` (≤170)، `description.txt`، `keywords.txt` (≤100)، و`screenshots/iphone-6.9/` (1320×2868) و`screenshots/ipad-13/` (2064×2752) — خمس لقطات لكل لغة.
- كل لقطات الشاشة تعرض **بيانات اصطناعية** موسومة بذلك على الصورة؛ لا مواد حقيقية ولا مواقع ولا أسماء ولا معرّفات.
- التوليد: `node docs/design/store-assets/generate.cjs` (يقرأ `docs/design/tokens.json`؛ يحتاج Playwright وChromium). لا روابط ولا نطاقات في هذه الملفات؛ `privacy_url` و`support_url` يضيفهما المنسّق في App Store Connect.
