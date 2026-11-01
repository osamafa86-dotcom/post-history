# نظام التصميم v2 — «إشارة»

**المرجع:** ملف Figma «Visual Library — Design System»، صفحات `v2 — Foundations` و`v2 — Components` و`v2 — Post Maydan`
(https://www.figma.com/design/U4OJG4hM6NoPt7SsFM7zkO). الرموز في `docs/design/tokens.v2.json`، ويولّدها
`docs/design/redesign-2026-11/tools/build-tokens-v2.mjs`. القرار: ADR 0085. Figma هو المرجع (ADR 0079): يتغيّر
الملف والرموز معًا.

النظام القديم (`design-system.md`) يبقى للويب حتى تصل مرحلته؛ تطبيق المراسل «بوست ميدان» يُبنى على v2 وحده.

## المبادئ

1. **المادة هي البطل.** الواجهة محايدة باردة، فالصور والفيديو تبرز.
2. **الفيروزي غالب، والتدرّج نادر.** التدرّج من الفيروزي إلى الأزرق في زرّ الإرسال الرئيسي وأيقونة التطبيق
   فقط. الإجراء الرئيسي في غير شاشة الإرسال فيروزي ثابت (`Button / Solid`).
3. **دوائر البثّ هي الهوية.** من شعار الشبكة: تنبض أثناء الرفع، وتهدأ في حالات الفراغ، وتمتلئ عند الوصول.
4. **يُقرأ في الشمس.** حدود الحقول ≥ 3:1، وسؤال الحساسية في صندوق ذهبي بإطار واضح.
5. **الحالة لا تُقال باللون وحده.** كل حالة كلمة وأيقونة. والحالات الثلاث (فنية، تحريرية، حقوق) شارات منفصلة.
6. **العربية أولًا والإنجليزية ندّ.** المكوّنات في Figma مرسومة RTL، والاتجاه في الكود بخصائص منطقية
   (`padding-inline`، `layoutDirection`)، والأرقام والبصمات والإيصالات LTR بأرقام جدولية.
7. **الفاتح أساس تطبيق المراسل، والداكن وجه المؤسسات** (المتجر والعرض)، والتبديل متاح في الاثنين.

## الرموز

| المجموعة في Figma | المفتاح في `tokens.v2.json` | الأوضاع |
|---|---|---|
| `v2 Primitives` (45، مخفية عن المنتقي) | `color.{neutral,brand,blue,accent.gold,red,green,amber}` | Value |
| `v2 Color` (23) | `color.{bg,text,border,action,priority,sensitivity,state}` | Light / Dark |
| `v2 Spacing` (12) | `space.1–12` = 2·4·8·12·16·20·24·32·40·48·64·80 | Value |
| `v2 Radius` (6) | `radius.{sm 14, chip 12, md 18, lg 28, phone 44, full}` | Value |

- اسم متغيّر الويب: `var(--v2-c-<المسار>)` للألوان الدلالية، و`var(--v2-<المسار>)` للبقية (مسجّل في Figma Code Syntax).
- **نغمات الحالات** في `color.material-state.{technical,editorial,rights}.*` تشير إلى `color.state.*`:
  فنية (جاهزة ok، تُعالَج muted، فشلت danger) · تحريرية (قيد المراجعة warn، معتمدة ok، مرفوضة danger) ·
  حقوق (داخلي muted، للعرض brand، مقيّد warn).
- **التباين:** `node docs/design/redesign-2026-11/tools/contrast-check.mjs docs/design/tokens.v2.json` يفحص 20 زوجًا
  بالوضعين (40) ويجب أن يخرج بـ 0. أي تغيير لون يمرّ به.

## الخط

| الدور | الخط | المقاس / السطر | الوزن |
|---|---|---|---|
| `v2/display` | Rubik (يغطي العربية) | 34 / 44 | 800 |
| `v2/title` | Rubik | 22 / 32 | 700 |
| `v2/headline` | Readex Pro | 17 / 26 | 700 |
| `v2/body` | Readex Pro | 16 / 26 | 400 |
| `v2/label` | Readex Pro | 13 / 20 | 600 |
| `v2/caption` | Readex Pro | 12 / 18 | 500 |
| `v2/num` | Rubik، `tabular-nums` | 15 / 22 | 600 |

Readex Pro بلا `tnum`، فكل رقم يُصطفّ (عدّاد، مدة، إيصال، حجم) بخط Rubik. الخطان OFL ومتاحان في Google Fonts وFigma
(Noto Kufi Arabic الذي ظهر في النموذج الأول غير متاح في Figma فاستُبدل).

## المكوّنات (صفحة `v2 — Components`)

| المكوّن | المتغيّرات | متى | الوصولية |
|---|---|---|---|
| `Button` | Style = Primary · Solid · Outline × Size = Large · Small | Primary لزرّ الإرسال وحده؛ Solid للإجراء الرئيسي؛ Outline للثانوي | ≥ 44 ارتفاعًا؛ النص 17 Bold |
| `Chip` | State = Default · Selected | نوع التغطية، الفلاتر، أجوبة الحساسية | المحدَّد بحبر داكن، لا لون وحده |
| `Tag` | Kind = Removable · Suggested | وسم المراسل (×) ومقترح الإدارة (منقّط) | زرّ الإزالة هدف لمس كامل |
| `Tag input` | — | حقل الوسوم مع اقتراح | يلتفّ ولا يدفع «أرسل» خارج الشاشة |
| `Text field` | State = Default · Focused · Error | عنوان التغطية (5–80) وأي حقل نصّي | عدّاد LTR؛ الخطأ نصّ لا لون |
| `Urgent toggle` | Pressed = Off · On | أولوية «عاجل» (الافتراض عادية) | `aria-pressed`؛ المفعّل مملوء |
| `Location chip` | — | المحافظة والمدينة المتذكَّرتان | لا إحداثيات أبدًا |
| `Sensitivity question` | Answer = Unanswered · No · Yes | قبل الإرسال دائمًا؛ «نعم» تفتح ثلاثة أسئلة | لا إرسال قبل جواب |
| `Broadcast rings` | State = Uploading · Paused · Done · Failed | تقدّم الرفع والإيصال | الحالة كلمة وأيقونة؛ النبض يتوقف مع تقليل الحركة |
| `Upload row` | State = Arrived · Uploading · Waiting · Failed | طابور الرفع | لا حذف بالسحب؛ الإلغاء زرّ بتأكيد |
| `Receipt` | — | ورقة الإيصال | أرقام LTR جدولية |
| `Media card` | Kind = Video · Photo | «موادي» | الحالات الثلاث شارات منفصلة |
| `State badge` | Tone = ok · warn · muted · brand · danger | داخل البطاقة وتفاصيل المادة | أيقونة + كلمة |
| `Player controls` | — | المشغّل ملء الشاشة | كل زر ≥ 44؛ إطار بإطار، السرعة، الجودة |
| `Empty state` | — | قوائم فارغة | يقول ما سيظهر وكيف |
| `icon/*` (16) | — | أيقونات خطّية 24 بخط 1.8 | تُلوَّن من متغيّر النص المناسب |

لوحة المراجعة `v2 Showcase` في الصفحة نفسها تعرض المكوّنات بالوضعين جنبًا إلى جنب (وضع المجموعة مضبوط صراحةً
على كل عمود).

## الحركة

`motion.fast` 120ms · `base` 200ms · `slow` 320ms · `pulse` 2400ms لنبض الدوائر. كلها تتوقف مع
`prefers-reduced-motion` / «تقليل الحركة»، والمعنى باقٍ (الرقم والكلمة).
