# infra — البنية التحتية

المالك: وكيل الرفع والبنية. يملك أيضًا `tools/netlab/` و`.github/workflows/`.

## المبدأ

Docker Compose على 3–4 خوادم أولًا؛ Kubernetes وOpenSearch وTemporal وKeycloak مؤجلة حتى يثبت القياس الحاجة. أدوات التشغيل تُختار بعد تصميم التوفر واختبار الفشل، لا قبلهما.

## compose (`infra/compose/`)

- Postgres 16، Redis 7 (بكلمة مرور)، MinIO (بديل S3 محليًا)، tusd. `.env.example` يوثّق المتغيرات بلا قيم؛ `.env` لا يُرفع.
- كل المنافذ مربوطة بـ `127.0.0.1` محليًا. الصور مثبّتة بوسم إصدار؛ MinIO وmc بناء مجتمعي (`pgsty/*`) بالوسم والبصمة (ADR 0004).
- tusd بلا منفذ منشور، خلف `tusd-proxy` (nginx، `infra/proxy/tusd.conf`) على شبكة `uploads` الداخلية؛ الخطّاف على شبكة `hooks` الداخلية.
- `-behind-proxy` لا يُفعَّل إلا خلف وكيل فعلي (عبر `TUSD_EXTRA_FLAGS`)، لأنه يجعل tusd يثق بترويسات `X-Forwarded-*`.
- أمر واحد يشغّل كل شيء من الصفر: `docker compose -f infra/compose/docker-compose.yml up -d`. والخادم معه: `--profile api` (من المصدر في `node:22`، مع `npm ci` والترحيل والبناء عند البدء)، ويُبنى له `REDIS_URL` و`DATABASE_URL` و`S3_*` من `.env` نفسه.

## tusd (`infra/tusd/`)

- R2 يشترط تساوي كل الأجزاء عدا الأخير وحدًا أدنى 5 MiB: `-s3-min-part-size` = `-s3-part-size`.
- `.part` المؤقت يحفظ ما دون الحد الأدنى؛ القرص المؤقت لخادم الرفع = الرفعات المتزامنة × حجم الجزء، ويُقاس في اختبار الحمل.
- خطّافات tusd (`pre-create`، `post-finish`) إلى `TUSD_HOOK_URL/TUSD_HOOK_SECRET` (ADR `SEC-06`). `infra/tusd/entrypoint.sh` يحجب الرمز من سجل tusd، والوكيل يحجب أجسام `500` لأن tusd يضع فيها عنوان الخطّاف.
- علم المسودة التجريبي (`EnableExperimentalProtocol`) خلف متغير بيئة لتجربة iOS فقط.
- نطاق الرفع: خلف وكيل Cloudflare افتراضيًا (الأجزاء 1–10 ميغابايت تحت حد جسم الطلب). خيار `ingest.` غير مُوكَّل بمصادقة App Attest/Play Integrity وJWT قصير يُقاس في النموذج الأولي مقابل كشفه لهجمات الحجب، ويُوثّق في ADR.

## الاستقلال عن المزوّد

- الحسابات والنطاقات ومفاتيح التشفير باسم الشبكة. نسخة احتياطية بقفل كائنات لدى مزوّد ثانٍ، ونسخة باردة لدى مزوّد ثالث. DNS ثانوي وشبكة توصيل احتياطية جاهزة. تجربة استعادة وخروج قبل الإطلاق.

## CI

<<<<<<< HEAD
- `contracts`: redocly lint + ajv compile. `secrets`: gitleaks. `compose`: config + pull + `infra/compose/smoke.sh`.
- `netlab` (`.github/workflows/netlab.yml`): فحص قصير لـ field-weak بوضع netem على كل PR يمس netlab أو compose، وقياس كامل يدويًا.
=======
- `contracts`: redocly lint + ajv compile. `secrets`: gitleaks. `compose`: config + pull + `infra/compose/smoke.sh` + `infra/compose/e2e-hooks.sh` (مسار الخطّاف مع الخادم). `api`: يشغّل MinIO المثبّت لاختبار محوّل S3.
>>>>>>> origin/main
- Dependabot (`.github/dependabot.yml`): `github-actions` وnpm أسبوعيًا.
- كل حزمة تضيف وظيفتها الخاصة حين يوجد كود.
