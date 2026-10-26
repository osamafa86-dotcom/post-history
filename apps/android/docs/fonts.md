# الخطوط المضمّنة في التطبيق

نظام التصميم (`docs/design/design-system.md`، `font.family.*` في `docs/design/tokens.json`) يسمّي ثلاثة خطوط بترخيص مفتوح.

- **مكانها:** `app/src/main/res/font/`، ملفات TTF ثابتة بالأوزان التي تستعملها أدوار النص فقط.
- **لماذا مضمّنة:** تعمل دون شبكة في الميدان، ولا تعتمد على مزوّد خطوط خارجي وقت التشغيل.

| الخط | الأوزان | الاستعمال | المصدر | الترخيص |
| --- | --- | --- | --- | --- |
| Noto Sans Arabic | 400، 500، 600، 700 | نصوص الواجهة بالعربية | Google Fonts (`notosansarabic` v33) | SIL Open Font License 1.1 |
| Inter | 400، 500، 600، 700 | نصوص الواجهة بالإنجليزية | Google Fonts (`inter` v20) | SIL Open Font License 1.1 |
| IBM Plex Mono | 400، 500 | أرقام الإيصالات والبصمات والأوقات | Google Fonts (`ibmplexmono` v20) | SIL Open Font License 1.1 |

- **إعادة التنزيل:** من `https://fonts.googleapis.com/css2?family=Noto+Sans+Arabic:wght@400;500;600;700&family=Inter:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500`، بوكيل مستخدم لا يدعم WOFF2، فتعود روابط TTF.
- **الحجم:** نحو 2.3 ميغابايت، تزيد AAB الإصدار من 5.9 إلى 7.5 ميغابايت.
- **الترخيص:** نص OFL 1.1 في https://openfontlicense.org. لا تُعدَّل الملفات ولا تُعاد تسميتها داخليًا، فلا يمس ذلك شرط «الاسم المحجوز».
