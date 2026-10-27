# 0079 — ملف Figma مرجعًا للخطوط والألوان: Vazirmatn وReem Kufi ولوحة الألوان الجديدة

- الحالة: مقبول (قرار المالك 2026-10-27)
- التاريخ: 2026-10-27
- المسؤول: المنسّق (`docs/design/tokens.json` ومولّداته في الويب وiOS وأندرويد)
- بند ملحق القرارات: قرار المالك 2026-10-27 — «ملف Figma هو المرجع للخطوط والألوان، فوق `docs/design/tokens.json` الحالي»
- المصدر: ملف Figma «Visual Library — Design System»، صفحات الأسس («الألوان» 6:3 وَ«الطباعة» 6:4 وَ«المسافات والشبكات» 6:5) وصفحة «الشاشات» (193:590 وَ193:862 وَ185:330 وَ186:423 وَ186:472)، مقروءة بمتغيّرات Figma نفسها (`get_variable_defs`) لا بالنقل من اللقطات.
- يحلّ محل: بند «خطا Vazirmatn وReem Kufi» وبند «فرق لوحة الألوان… ورموز `bg/slate` وَ`track-state/*`» في جدول «ما لا يُنقل الآن» في 0078؛ ويعدّل ADR 0076 في بند الخطوط (Noto Sans Arabic وInter).

## السياق

رسمت المصمّمة الملف بخطي Vazirmatn (النص) وReem Kufi (العرض) ولوحة ألوان مختلفة عن `tokens.json` (أخضر العلامة `#146B45` بدل `#1F6049`، وسلّم رمادي مائل إلى الأخضر، وخلفية بيضاء للصفحة الفاتحة، وشريط داكن `bg/slate` وحالات `track/state/*` لخط المسارات). ذكر 0078 هذه الفروق وأرجأها لأن تعديل الرموز يمس iOS وأندرويد. قرر المالك أن Figma هو المرجع، فيُحدَّث `tokens.json` ليطابقه، لا العكس.

## القرار

1. **الألوان.** كل قيم `color.primitive.*` (51 لونًا) من متغيّرات Figma حرفيًا. وكل رمز دلالي بوضعيه يشير إلى الرمز الخام الذي يطابق قيمة Figma؛ لم يبقَ رمز دلالي بلا مقابل خام، وتبقى **أسماء الرموز كلها كما هي**. تغيّرت إحالات تسعة منها: `bg/canvas` فاتح (إلى `neutral/0`)، `bg/subtle` وَ`bg/sunken` فاتحان (إلى `neutral/50`)، `text/secondary` وَ`border/strong` وَ`icon/default` فاتحة (إلى `neutral/700`)، وَ`tone/urgent/{bg,fg,border}` داكنة (إلى `red/500` وَ`neutral/0` وَ`red/300`).
2. **ثمانية رموز دلالية جديدة** لما رسمه Figma ولا رمز له: `bg/slate`، `text/on-slate`، `border/on-slate`، `track/state/{done,progress,attention,blocked,empty}` (المجموع 63). أسماء متغيّرات CSS كما في Figma (`--vl-color-bg-slate`…).
3. **الطباعة.** `font.family.arabic` وَ`font.family.latin` = Vazirmatn (أنماط `EN/*` في Figma بـ Vazirmatn أيضًا، فلا يبقى Inter)، وعائلة جديدة `font.family.display` = Reem Kufi، وIBM Plex Mono للأحادي كما هو. أدوار `display/*` وَ`heading/h1` وَ`board/number` وَ`board/title` بـ Reem Kufi Bold؛ والبقية بـ Vazirmatn. تغيّرت الأحجام والأوزان: `display/xl` 64/76، `display/lg` 48/58، `display/md` 40/48، `heading/h1` 32/40، `heading/h2` وزن 700، `overline/md` وزن 500، `board/title` 32/40، `board/card` 32/40، `board/meta` 24/32. أما نصوص التسمية في إطار الطباعة (28/36 وَ22/30 وَ18/24) فقديمة في Figma نفسه، واعتُمدت الأنماط الفعلية التي تستعملها شاشة اللوحة.
4. **ملفات الخطوط.** Vazirmatn بأوزان 400 و500 و600 و700، وReem Kufi بوزن 700 وحده (كل ما تستعمله الأدوار)، TTF ساكنة مع نص OFL بجانبها، في `apps/ios/App/Resources/Fonts` وَ`apps/android/app/src/main/res/font` (+ `assets/licenses`) وَ`apps/web/public/fonts`. حُذف Noto Sans Arabic وInter من التطبيقين. بقيت نسخ Noto وInter (WOFF) في `docs/design/store-assets/fonts` لأن مولّد لقطات المتجر يستعملها ولم يُعاد توليد اللقطات.
5. **الويب** يضيف مولّد `scripts/design-tokens.mjs` كتل `@font-face` إلى `src/generated/tokens.css` من `font.family.*` (الخطوط من `/fonts/` على الأصل نفسه فيبقى CSP `font-src 'self'`)، ويصدر `--vl-font-family-display`. وتخزين `/fonts/*` مؤقتًا أسبوعًا في `next.config.ts` (الباقي `no-store`).

## مصدر الخطوط والتحقق

الملفان `Vazirmatn[wght].ttf` وَ`ReemKufi[wght].ttf` من مستودع Google Fonts (`ofl/vazirmatn` وَ`ofl/reemkufi`) بنص OFL 1.1 لكل منهما. لا يوجد هناك سوى الخط المتغيّر، فولِّدت الأوزان الساكنة بـ `fonttools varLib.instancer --update-name-table` (تثبيت محور الوزن دون تعديل آخر)، وفُحصت: TTF صالحة بلا جدول `fvar`، `usWeightClass` صحيح، أسماء PostScript `Vazirmatn-{Regular,Medium,SemiBold,Bold}` وَ`ReemKufi-Bold` (يعتمد عليها iOS)، وتغطية الحروف العربية واللاتينية والأرقام الهندية والفارسية. نصا الترخيص لا يحجزان اسم الخط (إشعار Reem Kufi يذكر اسمًا محجوزًا لخط آخر)، فتحمل النسخ الساكنة الاسم الأصلي.

## التباين WCAG 2.1 AA

كل أزواج النص (فاتح وداكن) ≥ 4.5:1، وهي المفحوصة في `apps/web/tests/design-tokens.test.ts`؛ وأضعفها داكنًا `text/muted` على `bg/subtle` 4.65:1. تحسّن `text/muted` الفاتح (كان 4.21:1 على `bg/canvas` و3.91:1 على `bg/subtle`، أي دون AA). **لم يُرفض أي لون نصي.** وما دون 3:1 في عناصر غير نصية ملتزم به كما رسمه Figma ومبلَّغ عنه للمصمّمة:

| اللون | على | النسبة | الملاحظة |
| --- | --- | --- | --- |
| `track/state/attention` فاتح `#D39200` | `bg/surface` و`bg/canvas` (أبيض) | 2.66 | قطعة خط المسارات؛ الشكل (تخطيط كهرماني) يحمل الدلالة، والويب يستعمل مزيجًا ≥ 3:1 حتى يُعتمد |
| `border/strong` داكن `#49524B` | `bg/surface` / `bg/canvas` | 2.08 / 2.30 | حدّ حقل الإدخال (كان 2.46 / 2.69)؛ يحتاج 3:1 لمعيار 1.4.11 |
| `border/on-slate` | `bg/slate` | 1.46 فاتح / 1.61 داكن | فاصل زخرفي داخل البطاقة الداكنة |
| `track/state/{done,progress,blocked}` فاتحة | `bg/slate` الفاتح | 2.58 / 2.58 / 2.64 | تركيب غير مرسوم (اللوحة داكنة) |

## لم يُنقل

- **أنصاف الأقطار**: Figma بـ 2/4/6/8/12 (`sm…2xl`) و`tokens.json` بـ 4/8/12/16/24. وحلقة `Focus/Ring` في Figma خضراء (`#146B45`) بينما `border/focus` أزرق. خارج نطاق القرار (خطوط وألوان فقط)؛ تُقرَّر بقرار مستقل.
- **قيمتان استُنتجتا**: لم يظهر `border/on-slate` في الوضع الفاتح ولا `track/state/progress` في الداكن في أي إطار؛ أُخذتا من الوضع المقابل (`neutral/700` وَ`green/300`) وتؤكدهما المصمّمة.
- **استعمال الخطين في مكوّنات الويب** (`h1` بـ Reem Kufi، وبطاقة اللوحة بأحجام `board/*` الجديدة، وقطع خط المسارات من `track/state/*`) لا يدخل هنا: يغيّر الشريط العلوي وأعمدة اللوحة التي يعدّلها PR آخر. الرموز والمتغيّرات جاهزة لها.
- **IBM Plex Mono على الويب** ما زال بديل النظام (غير مستضاف).

## النتائج

- توليد: `node apps/ios/scripts/generate-design-tokens.mjs` (ألوان `DesignTokens.xcassets` و`DesignTokens.generated.swift`، 63 لونًا و21 دورًا)، وَ`npm run generate:tokens` في `apps/web`؛ وأندرويد يولّد وقت البناء (`VlFontKind.DISPLAY` جديد، `DesignTokensTest` يغطي الرموز الجديدة والأدوار).
- `UIAppFonts` في `project.yml` يسرد خمسة ملفات جديدة بدل ثمانية؛ وحجم الخطوط في أندرويد ينخفض نحو 1.5 ميغابايت (من 2.07 إلى 0.60).
- لا تغيير في العقد ولا في API.
