# الخطوط المضمّنة في التطبيق

نظام التصميم (`docs/design/design-system.md`، `font.family.*` في `docs/design/tokens.json`) يسمّي ثلاثة خطوط بترخيص مفتوح، والمرجع فيها ملف Figma (ADR 0079).

- **مكانها:** `app/src/main/res/font/`، ملفات TTF ثابتة بالأوزان التي تستعملها أدوار النص فقط.
- **لماذا مضمّنة:** تعمل دون شبكة في الميدان، ولا تعتمد على مزوّد خطوط خارجي وقت التشغيل.

| الخط | الأوزان | الاستعمال | المصدر | الترخيص |
| --- | --- | --- | --- | --- |
| Vazirmatn | 400، 500، 600، 700 (`vazirmatn_*.ttf`) | نصوص الواجهة بالعربية والإنجليزية | Google Fonts (`ofl/vazirmatn`) | SIL Open Font License 1.1 |
| Reem Kufi | 700 (`reem_kufi_700.ttf`) | العناوين الكبيرة وأرقام اللوحة (`display/*`، `heading/h1`، `board/number`، `board/title`) | Google Fonts (`ofl/reemkufi`) | SIL Open Font License 1.1 |
| IBM Plex Mono | 400، 500 | أرقام الإيصالات والبصمات والأوقات | Google Fonts (`ibmplexmono` v20) | SIL Open Font License 1.1 |

- **الاستبدال:** حلّ Vazirmatn محل Noto Sans Arabic وInter، لأن ملف Figma يسند به أنماط `AR/*` وَ`EN/*` معًا. حُذفت ملفات الخطين القديمين وتراخيصهما من التطبيق.
- **إعادة الإنتاج:** يوفّر Google Fonts خطّي Vazirmatn وReem Kufi متغيّرين فقط (محور `wght`). النسخ الساكنة مولَّدة منهما بـ `fonttools varLib.instancer --update-name-table <الملف المتغيّر> wght=<الوزن>` دون أي تعديل آخر على الخط، ثم سُمّيت `vazirmatn_<الوزن>.ttf` وَ`reem_kufi_700.ttf`. أما IBM Plex Mono فمن `https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500` بوكيل مستخدم لا يدعم WOFF2، فتعود روابط TTF.
- **الترخيص:** نص OFL 1.1 مع إشعار حقوق كل خط يُشحن داخل التطبيق في `app/src/main/assets/licenses/OFL-{Vazirmatn,ReemKufi,IBMPlexMono}.txt`، كما يشترط الترخيص عند إعادة التوزيع. النسخ الساكنة مشتقة تقنيًا (تثبيت محور الوزن) وتحمل الاسم الأصلي للخط؛ لا يحجز أيٌّ من نصّي الترخيص اسم الخط، فلا يمس ذلك شرط «الاسم المحجوز».
