# الخطوط المضمّنة في التطبيق

الهوية v2 «إشارة» (ADR 0085، `font.family.*` في `docs/design/tokens.v2.json`) تسمّي خطّين بترخيص مفتوح، ويبقى خط أحادي لرقم الإيصال والبصمة وحدهما كما في iOS (ADR 0088).

- **مكانها:** `app/src/main/res/font/`، ملفات TTF ساكنة بالأوزان التي تستعملها أدوار النص فقط.
- **لماذا مضمّنة:** تعمل دون شبكة في الميدان، ولا تعتمد على مزوّد خطوط خارجي وقت التشغيل.

| الخط | الأوزان | الاستعمال | المصدر | الترخيص |
| --- | --- | --- | --- | --- |
| Rubik | 600، 700، 800 (`rubik_*.ttf`) | العناوين (`display` و`title`) والأرقام المصطفّة (`num`: النسب والأوقات والأحجام والعدّادات) | Google Fonts، المجلد `static/` (Rubik v31) | SIL Open Font License 1.1 |
| Readex Pro | 400، 500، 600، 700 (`readex_pro_*.ttf`) | نصوص الواجهة بالعربية والإنجليزية (`headline` و`body` و`label` و`caption`، والزرّ) | Google Fonts، المجلد `static/` (Readex Pro v27) | SIL Open Font License 1.1 |
| IBM Plex Mono | 500 (`ibm_plex_mono_500.ttf`) | رقم الإيصال والبصمة وحدهما (خط أحادي لا يلتبس فيه حرف برقم) | Google Fonts (`ibmplexmono` v20) | SIL Open Font License 1.1 |

- **الملفات:** ملفات Rubik وReadex Pro هي نفسها التي يشحنها تطبيق iOS (`apps/ios/App/Resources/Fonts/`، فُحصت هناك: ترويسة TrueType، وبلا `fvar`، و`usWeightClass` مطابق، وتغطية العربية والأرقام)، منسوخة بلا تعديل ومسمّاة بأسماء موارد أندرويد.
- **ما أُزيل:** Vazirmatn بأوزانها الأربعة وReem Kufi وIBM Plex Mono Regular ونصوص ترخيصها (هوية v1، ADR 0079)؛ لا يقرأ التطبيق `tokens.json` بعد اليوم.
- **الترخيص:** نص OFL 1.1 مع إشعار حقوق كل خط يُشحن داخل التطبيق في `app/src/main/assets/licenses/OFL-{Rubik,ReadexPro,IBMPlexMono}.txt`، كما يشترط الترخيص عند إعادة التوزيع. ترخيص Readex Pro يحجز اسم «RevReading Lexend» لا اسمه، والملفات غير معدَّلة.
