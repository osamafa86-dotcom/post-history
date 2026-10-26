# نظام التصميم — المكتبة المرئية

**ملف Figma:** «Visual Library — Design System» — https://www.figma.com/design/U4OJG4hM6NoPt7SsFM7zkO
**مصدر الرموز للكود:** `docs/design/tokens.json` (صيغة W3C Design Tokens؛ الألوان بوضعين `light`/`dark` داخل `$value`، وكل رمز لوني يحمل اسم متغيّر CSS في `$extensions.vl.css` ونطاقات Figma في `$extensions.vl.figmaScopes`).
**المالك:** تصميم المنتج (الوكيل 11). التعديل على الرموز يمر عبر هذا الملف والملف الـJSON معًا في PR واحد.

## 1. المبادئ

1. **العاجل يُرى من بعيد.** الأولوية شارة مصمتة لا تعليقًا بحجم 10px؛ لوحة غرفة الأخبار لها مقياس طباعة خاص (`board/*`).
2. **الحالات الثلاث مستقلة دائمًا.** لكل مسار (فنية/تحريرية/حقوق) أيقونة ولون مسار ثابتان، ولكل حالة نبرة (tone) تحمل أيقونة أيضًا؛ لا يُدمج المساران في شارة واحدة، ولا يُعتمد على اللون وحده.
3. **العربية أولًا، والإنجليزية ندًّا.** كل مكوّن له متغيّر `Direction=RTL` و`Direction=LTR`؛ «البداية» في RTL هي اليمين. الأيقونات الاتجاهية (`chevron-start/end`) تنعكس، وأيقونات المعنى (ساعة، درع) لا تنعكس. الأرقام والإيصالات والبصمات بخط أحادي المسافة واتجاه `ltr`.
4. **الطمأنة في الميدان.** مؤشر الرفع يقول دائمًا ثلاثة أشياء: أين وصلنا، وأن الانقطاع آمن، وما الخطوة التالية. الإيصال حدث احتفالي لا سطر صغير.
5. **لا بيانات كاشفة.** لا مكوّن يعرض إحداثيات أو معرّف جهاز أو اسم مصدر محمي؛ بطاقات المعاينة والكتالوج تعرض المحافظة ويوم التصوير فقط واسم الظهور.
6. **سهولة الوصول WCAG 2.1 AA** قيد لا خيار: تباين النص ≥ 4.5:1 (النص الكبير ≥ 3:1)، هدف اللمس ≥ 44px، حلقة تركيز مرئية (`Focus/Ring`)، وحجم نص أدنى 14px على الويب و16px في حقول الإدخال على الهاتف.

## 2. الألوان

**المجموعات في Figma:** `Primitives` (51 لونًا خامًا بنطاقات مخفية) ← `Color` (55 رمزًا دلاليًا بوضعي Light/Dark عبر aliases). الكود يستهلك الطبقة الدلالية فقط.

| المجموعة | الاستعمال | أمثلة |
| --- | --- | --- |
| `bg/*` | خلفيات: `canvas` (الصفحة)، `surface` (بطاقة/لوحة)، `subtle` (مرشحات ورؤوس جداول)، `brand`، `danger`، `media` (خلفية المشغّل، داكنة في الوضعين) | `--vl-color-bg-surface` |
| `text/*` | `primary`، `secondary`، `muted` (≥ 4.5:1 على `surface`)، `on-brand`، `brand`، `danger`، `disabled`، `on-media` | `--vl-color-text-primary` |
| `border/*` | `default` (فواصل)، `strong` (حقول)، `brand`، `danger`، `focus` | `--vl-color-border-focus` |
| `icon/*` | `default`، `muted`، `brand`، `on-brand` | |
| `tone/{neutral,progress,good,attention,bad,urgent}/{bg,fg,border}` | شارات الحالة والتنبيهات والتوست. `urgent` وحدها مصمتة (نص أبيض على أحمر) | `--vl-color-tone-urgent-bg` |
| `track/{technical,editorial,rights}/{accent,subtle}` | لون المسار في الخط الزمني للمادة وأيقونة الشارة: أزرق للفنية، أخضر للتحريرية، بنفسجي للحقوق | `--vl-color-track-rights-accent` |

**الأخضر** (`green/600` = `#1F6049`) هو لون العلامة وزر الإجراء الأساسي، و**الأحمر** (`red/600` = `#A93428`) محجوز للعاجل والخطر فقط؛ لا يُستعمل للزخرفة. الوضع الداكن يعكس السلّم (الخلفية `neutral/950`، النص `neutral/50`) ويرفع درجة ألوان النبرات لتبقى ≥ 4.5:1.

تباينات مُتحقَّق منها حسابيًا (فاتح): `text/muted` على `bg/surface` 4.6:1، `text/secondary` على `bg/canvas` 6.5:1، `tone/urgent/fg` على `tone/urgent/bg` 7.1:1، `text/on-brand` على `bg/brand` 7.6:1.

## 3. الطباعة

- **العربية:** Noto Sans Arabic (ترخيص SIL OFL؛ IBM Plex Sans Arabic بديل مكافئ إن فُضِّل في الويب — لكنه غير متاح في Figma فاعتُمد Noto). **الإنجليزية:** Inter. **الأرقام والأكواد:** IBM Plex Mono (الإيصالات، البصمات، الأزمنة).
- أنماط النص في Figma مزدوجة: `AR/<role>` و`EN/<role>` بالقياس نفسه؛ ارتفاع السطر للعربية ≈ 1.6× لحجم النص في المتن.

| الدور | الحجم/السطر | الوزن | الاستعمال |
| --- | --- | --- | --- |
| `display/xl` `lg` `md` | 64/80 · 48/60 · 40/52 | Bold | صفحة الدخول، الكتالوج العام |
| `heading/h1`…`h4` | 32/44 · 24/34 · 20/30 · 18/28 | Bold/SemiBold | عناوين الصفحات والبطاقات |
| `body/lg` `md` `sm` | 18/30 · 16/26 · 14/22 | Regular | المتن؛ `sm` حدّ أدنى للجداول |
| `label/lg` `md` `sm` | 16/24 · 14/20 · 12/16 | Medium | الأزرار والحقول والشارات |
| `caption/md` `overline/md` | 12/18 · 12/16 | Regular/SemiBold | نص مساعد، رؤوس أعمدة |
| `board/number` `title` `card` `meta` | 96/104 · 28/36 · 22/30 · 18/24 | Bold/SemiBold/Medium | لوحة غرفة الأخبار على شاشة كبيرة (تُقرأ من 3 أمتار) |
| `mono/md` `lg` | 14/20 · 18/24 | Regular/Medium | إيصال، بصمة، زمن |

## 4. المسافات والشبكة والأبعاد

- **المسافات** `space/0…12` = 0, 2, 4, 8, 12, 16, 20, 24, 32, 40, 48, 64, 80. القاعدة: 4px داخل المكوّن، 8/12 بين عناصر المكوّن، 16/24 بين المكوّنات، 32/48 بين الأقسام.
- **الزوايا** `radius/sm 4 · md 8 · lg 12 · xl 16 · 2xl 24 · full`. الحقول والأزرار `md`، البطاقات `lg`، الشارات `full`.
- **الأبعاد** `size/touch-min 44`، `control-sm 36 · md 44 · lg 52`، `icon-sm 16 · md 20 · lg 24`، `thumb 160×90`، `sidebar-w 240`، `content-max 1440`، `board-card-min 280`.
- **الحدود** `border/hairline 1 · regular 2 · emphasis 3` (الشريط الجانبي للعاجل والمسار النشط).
- **الشبكة:** هاتف 390 → 4 أعمدة، هامش 16، فجوة 16؛ لوح 768 → 8 أعمدة، 24؛ مكتب ≥ 1200 → 12 عمودًا، فجوة 24، هامش 32، أقصى عرض محتوى 1440؛ لوحة 1920 → 12 عمودًا، فجوة 32، هامش 48.
- **الارتفاعات (Effect styles):** `Elevation/1` (صف/حقل)، `Elevation/2` (بطاقة مرفوعة، قائمة)، `Elevation/3` (نافذة حوار)، `Focus/Ring` (حلقة تركيز 3px بلون `border/focus`).

## 5. الحركة

| الرمز | القيمة | الاستعمال |
| --- | --- | --- |
| `motion/duration/fast` | 120ms | تغيّر حالة زر/شارة |
| `motion/duration/base` | 200ms | ظهور قائمة، توست |
| `motion/duration/slow` | 320ms | فتح لوحة جانبية، انتقال صفحة |
| `motion/duration/progress` | 600ms | تحديث شريط الرفع (خطي) |
| `motion/easing/standard` | cubic-bezier(0.2, 0, 0, 1) | الافتراضي |
| `motion/easing/emphasized` | cubic-bezier(0.3, 0, 0, 1) | وصول إيصال، مادة عاجلة جديدة |

تُحترم `prefers-reduced-motion`: تُستبدل الحركة بتغيّر فوري مع إبقاء النبض على شارة «عاجل» ثابتًا.

## 6. المكوّنات

كل مكوّن مجموعة متغيّرات في صفحته، بمحور `Direction=RTL|LTR`، وكل خاصية بصرية مربوطة برمز. القيم الافتراضية لخصائص النص بالعربية (العربية أولًا)، وتُبدَّل في المثيل.

| المكوّن | الصفحة في Figma | المحاور | الخصائص | ملاحظات الاستعمال |
| --- | --- | --- | --- | --- |
| **Button** | Button (`node-id=24-98`) | Variant: Primary/Secondary/Ghost/Danger × State: Default/Hover/Disabled × Direction | Label، Show icon، Icon (swap) | زر أساسي واحد لكل شاشة؛ ارتفاع 44؛ التركيز عبر `Focus/Ring` |
| **Form Field** | Input & Form Field (`34-186`) | Type: Text/Select/Textarea × State: Default/Focus/Error/Disabled × Direction | Label، Required، Message، Value | رسالة الخطأ تستبدل نص المساعدة ولا تُضاف تحته؛ قيمة الحقل 16px على الهاتف |
| **State Badge** | Status Badge (`43-152`) | Track: Technical/Editorial/Rights × Tone: Neutral/Progress/Good/Attention/Bad × Direction | — (النص هو اسم الحالة المحلّي) | الشارات الثلاث تُعرض معًا دائمًا وبالترتيب فنية → تحريرية → حقوق |
| **Priority Badge** | Status Badge (`43-183`) | Priority: Urgent/Important/Normal × Direction | — | عاجل مصمت أحمر وبأيقونة؛ لا يُستعمل كنص 10px |
| **Material Card** | Material Card (`48-170`) | Variant: Inbox row/Board card/Catalog card × Direction | Urgent، Title | الواجهات الثلاث للمادة؛ بطاقة الكتالوج تعرض الحقول العامة فقط |
| **Alert** | Alert & Toast (`52-178`) | Tone: Progress/Good/Attention/Bad/Urgent × Kind: Inline/Toast × Direction | Title، Body، Action، Show action، Dismissible | التوست العاجل لا يُغلق تلقائيًا ويصدر صوتًا مرة واحدة |
| **Table Row** | Table (`56-250`) | Kind: Header/Row × State: Default/Hover/Selected × Direction | — | صف 48px ونص 14px؛ دون 760px يتحول إلى بطاقات Inbox row |
| **Player** | Player (`62-142`) | State: Playing/Paused/Light copy/Unavailable × Direction | — | علامة مائية دائمة، وسم النسخة الخفيفة، تعليق مثبّت على ثانية |
| **Dynamic Field** | Dynamic Form (`68-248`) | Type: الأنواع العشرة في `upload-form.json` × Direction | — | قفل عند الحقل الحساس؛ الحقول الشرطية تظهر بتلاشٍ 200ms |
| **Icon** | Icon | 16 أيقونة خطية على شبكة 24 | — | `chevron-start/end` تنعكس في RTL؛ اللون من `icon/*` |

### قيد معروف في Figma

خصائص النص المشتركة (Label، Title…) لها قيمة افتراضية واحدة (بالعربية)، فتظهر في متغيّرات LTR على اللوحة نصوص عربية حتى تُبدَّل في المثيل. ليس خطأً في المكوّن؛ المواصفات والتدفقات تحمل النص الإنجليزي.

## 7. كيف يستهلك الكود الرموز

- **الويب (`apps/web`):** يولَّد من `tokens.json` ملف CSS متغيّرات على `:root` (`--vl-*`) وآخر داخل `[data-theme="dark"]` أو `@media (prefers-color-scheme: dark)`، ويُستبدل بها ما في `globals.css` (`--ink`, `--muted`, `--green`…). الخطوط: `Noto Sans Arabic` للعربية و`Inter` للإنجليزية عبر `next/font` بترخيص مفتوح، و`IBM Plex Mono` للإيصالات.
- **iOS (`apps/ios`):** `Color` و`Font` extensions مولَّدة من JSON (أسماء Swift: `Color.vl.bgSurface`)، ووضعان عبر `UITraitCollection`.
- **أندرويد (`apps/android`):** `lightColorScheme()`/`darkColorScheme()` في `Theme.kt` تُملأ من الرموز، و`Typography` بـ Noto Sans Arabic/Inter من Google Fonts.
- قاعدة التوليد: الرموز الدلالية فقط تخرج إلى الكود؛ لا تُستعمل قيم `color.primitive.*` مباشرة في أي واجهة.

## 8. مرجع سهولة الوصول

- التباين ≥ 4.5:1 للنص، ≥ 3:1 للنص الكبير والأيقونات والحدود المعنوية؛ أزواج الرموز المعتمدة في القسم 2.
- حلقة التركيز 3px بلون `border/focus` على كل عنصر تفاعلي، لا تُلغى.
- اللمس ≥ 44×44؛ المسافة بين أهداف اللمس ≥ 8px.
- `prefers-reduced-motion` و`prefers-contrast` محترمان؛ لا يُعتمد على اللون وحده (أيقونة أو نص مع كل حالة).
- ترتيب قراءة RTL صحيح في DOM؛ الأرقام والإيصالات `dir="ltr"` داخل سياق RTL.
