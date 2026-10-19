# infra — البنية التحتية

المالك: وكيل الرفع والبنية. يملك أيضًا `tools/netlab/` و`.github/workflows/`.

## المبدأ

Docker Compose على 3–4 خوادم أولًا؛ Kubernetes وOpenSearch وTemporal وKeycloak مؤجلة حتى يثبت القياس الحاجة. أدوات التشغيل تُختار بعد تصميم التوفر واختبار الفشل، لا قبلهما.

## compose (`infra/compose/`)

- Postgres 16، Redis 7، MinIO (بديل S3 محليًا)، tusd. `.env.example` يوثّق المتغيرات بلا قيم؛ `.env` لا يُرفع.
- أمر واحد يشغّل كل شيء من الصفر: `docker compose -f infra/compose/docker-compose.yml up -d`.

## tusd (`infra/tusd/`)

- R2 يشترط تساوي كل الأجزاء عدا الأخير وحدًا أدنى 5 MiB: `-s3-min-part-size` = `-s3-part-size`.
- `.part` المؤقت يحفظ ما دون الحد الأدنى؛ القرص المؤقت لخادم الرفع = الرفعات المتزامنة × حجم الجزء، ويُقاس في اختبار الحمل.
- hook الاكتمال إلى `POST /v1/uploads/{id}/complete` بترويسة `X-Hook-Secret`.
- علم المسودة التجريبي (`EnableExperimentalProtocol`) خلف متغير بيئة لتجربة iOS فقط.
- نطاق الرفع: خلف وكيل Cloudflare افتراضيًا (الأجزاء 1–10 ميغابايت تحت حد جسم الطلب). خيار `ingest.` غير مُوكَّل بمصادقة App Attest/Play Integrity وJWT قصير يُقاس في النموذج الأولي مقابل كشفه لهجمات الحجب، ويُوثّق في ADR.

## الاستقلال عن المزوّد

- الحسابات والنطاقات ومفاتيح التشفير باسم الشبكة. نسخة احتياطية بقفل كائنات لدى مزوّد ثانٍ، ونسخة باردة لدى مزوّد ثالث. DNS ثانوي وشبكة توصيل احتياطية جاهزة. تجربة استعادة وخروج قبل الإطلاق.

## CI

- `contracts`: redocly lint + ajv compile. `secrets`: gitleaks. `compose`: config.
- كل حزمة تضيف وظيفتها الخاصة حين يوجد كود.
