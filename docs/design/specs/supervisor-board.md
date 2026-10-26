# مواصفة التسليم — التدفق (ج): لوحة غرفة الأخبار على شاشة كبيرة

**المصدر:** Figma › `Flow C · Supervisor board (1920)` (AR ثم EN). **الرموز:** `docs/design/tokens.json`. **القرارات:** `docs/design/flows/supervisor-board.md`.
**المالك:** الويب (الوكيل 6) — `apps/web/src/components/newsroom-board.tsx` و`app/[locale]/(workspace)/board/page.tsx`. وضع العرض عبر `?display=1` (أو مسار `/board/display`): بلا رأس ولا شريط جانبي، الوضع الداكن افتراضيًا، `cursor: none` بعد 3 ثوانٍ من السكون.

## 1. البنية (1920×1080، حشو 48/32، فجوة عمودية 24)

| القسم | المحتوى | الرموز |
| --- | --- | --- |
| الصف العلوي | يمين: `board/meta` «غرفة الأخبار · <النطاق>» بلون `text/brand`، `display/md` «لوحة الإنتاج الحية»، سطر الساعة `board/title` + «آخر لقطة HH:MM:SS · تتحدث كل 5 ثوانٍ» `board/meta`. يسار: 3 عدّادات | `bg/canvas` داكن |
| العدّاد | بطاقة `tone/<tone>/bg` بحد 2px `tone/<tone>/border`، `radius.2xl`، حشو 32/16؛ الرقم `board/number` (96) `tone/<tone>/fg`؛ العنوان `board/title`؛ سطر توضيحي `board/meta` + أيقونة. عاجل مفتوح = `urgent` وينبض (opacity 1→0.85→1 كل 2s) ما دام > 0؛ متأخر عن الإقرار = `attention` مع «أقدمها mm:ss»؛ محجوز للإنتاج = `progress` | من `NewsroomDashboard.urgent_open`, `overdue_acknowledgements`, `reserved.length` |
| الوارد الآن | شريط `bg/surface` بحد `border/default` `radius.xl`: تسمية + «رفع جارٍ · n» + نقطة `tone/good/fg`؛ لكل رفع (حد أقصى 3، والباقي «+n») بطاقة `bg/sunken` بعرض متساوٍ: العنوان القصير · النوع `board/card`، `Priority Badge`، النسبة والمنقضي `board/meta` (LTR)، شريط 12px (`tone/urgent/bg` للعاجل وإلا `bg/brand`)؛ العاجل بحد بداية 3px | `uploads_in_progress` |
| الأعمدة الستة | `grid-template-columns: repeat(6, minmax(0,1fr))` فجوة 16؛ العمود `bg/subtle` `radius.xl` حشو 12؛ رأس: الاسم `board/title` + عدّاد في كبسولة `bg/surface` `board/title`؛ البطاقة `bg/surface` `radius.lg` حشو 16/14: الأولوية + المنقضي (`board/meta`، `text/danger` للعاجل)، العنوان `board/card` (سطران، قص بـ…)، ذيل: كبسولة «حجز: <اسم>» `tone/progress` و/أو «متأخرة mm:ss» `tone/attention` + أيقونة ساعة. العاجل بحد بداية 4px `tone/urgent/bg` | `GET /materials?editorial_state=…&limit=8` لكل عمود كل 15 ثانية |
| الذيل | يسار: «لا أسماء مصادر ولا مواقع دقيقة على هذه الشاشة · اسم الظهور فقط» `board/meta` `text/muted`؛ يمين: حالة الصوت + أيقونة الجرس | |

الترتيب داخل العمود: عاجل → مهم → الأقدم؛ أكثر من 8 → «+n» وتدوير كل 20 ثانية (انتقال تلاشٍ 320ms؛ بلا حركة مع `prefers-reduced-motion`).

## 2. الاستجابة

| العرض | التغيير |
| --- | --- |
| 1920+ | كما النماذج (مقياس 1) |
| 1440–1919 | المقياس نفسه مع تقليص الحشو إلى 32/24؛ الأعمدة 6 بعرض أدنى 200؛ العدّاد `display/lg` بدل `board/number` |
| 1000–1439 | وضع المكتب العادي الحالي (`/board` بلا display) — هذه المواصفة لا تنطبق |
| 4K (3840) | `zoom: 2` عبر CSS أو `device-pixel-ratio`؛ لا إعادة تخطيط |

## 3. الصوت والحالات
- تنبيه قصير (≤ 1 ثانية، ملف في `public/`) عند: مادة عاجلة جديدة، تجاوز مهلة إقرار. يُفعَّل بعد أول نقرة (قيد المتصفحات)؛ قبلها أيقونة مكتومة ونص «انقر لتفعيل الصوت».
- انقطاع الاتصال: شريط علوي `tone/bad/bg` «اللوحة غير محدّثة منذ mm:ss» والمحتوى بتعتيم 0.6.
- لا عاجل ولا متأخر: شريط رفيع علوي `tone/good/bg` «كل شيء ضمن المهلة».
- عمود فارغ: «لا شيء هنا الآن» `board/meta` `text/muted` متوسّط.

## 4. سهولة الوصول
- التباين ≥ 7:1 للأرقام/العناوين على الداكن (`text/primary` على `bg/canvas` الداكن = 16.5:1، `tone/urgent/fg` على `tone/urgent/bg` داكن = 7.1:1).
- اللوحة `aria-live="polite"` على العدّادات فقط؛ البطاقات ليست تفاعلية في وضع العرض.
- الحركة الوحيدة: نبض العاجل والتدوير؛ كلاهما يتوقف مع `prefers-reduced-motion`.

## 5. ما يُقاس
- قابلية القراءة من 3 أمتار على شاشة 55 بوصة: حجم العنوان `board/card` 22px ≥ 0.6° زاوية رؤية — يُتحقق ميدانيًا ويُسجَّل في `docs/measurements/web/`.
