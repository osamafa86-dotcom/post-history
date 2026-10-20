# infra — البنية التحتية

المالك: وكيل الرفع والبنية. يملك أيضًا `tools/netlab/` و`.github/workflows/`.

## المبدأ

Docker Compose على 3–4 خوادم أولًا؛ Kubernetes وOpenSearch وTemporal وKeycloak مؤجلة حتى يثبت القياس الحاجة. أدوات التشغيل تُختار بعد تصميم التوفر واختبار الفشل، لا قبلهما.

## compose (`infra/compose/`)

- Postgres 16، Redis 7 (بكلمة مرور تمر من البيئة إلى ملف إعداد، لا في سطر الأوامر)، MinIO (بديل S3 محليًا)، tusd. `.env.example` يوثّق المتغيرات بلا قيم؛ `.env` لا يُرفع.
- الأسرار في الإنتاج (SEC-05): SOPS بمفاتيح age في مستودع تشغيل خاص، تُفك على الخادم إلى tmpfs وتُقرأ بـ `env_file:`؛ لا قيمة في ملف compose ولا في سطر الأوامر. التدوير والاستعادة الطارئة في `docs/ops/runbook.md`، وتمرين التدوير `infra/secrets/rotate_hook_secret.py`.
- `tusd-proxy` يعيد حل اسم `tusd` عبر DNS الخاص بـ Docker (`resolver 127.0.0.11`): الاسم الثابت في `proxy_pass` يُحل مرة عند البدء، فيعيد 502 إن تغيّر عنوان tusd بعد إعادة إنشائه.
- كل المنافذ مربوطة بـ `127.0.0.1` محليًا. كل صورة في compose والتجربة وصورة النسخ بالوسم والبصمة (ADR 0004)، و`infra/compose/check-pinned.sh` في CI يحرس ذلك. سجلات الوكلاء تكتب `/files/-` مكان معرّف الرفع.
- tusd بلا منفذ منشور، خلف `tusd-proxy` (nginx، `infra/proxy/tusd.conf`) على شبكة `uploads` الداخلية؛ الخطّاف على شبكة `hooks` الداخلية.
- شبكة `media` الداخلية (ADR 0006): عامل الوسائط بعنوان ثابت `172.30.251.2`، والخادم وMinIO وRedis بعناوين ديناميكية من `.8/29`. Docker يأخذ البوابة من داخل `ip_range`، فلا يُضيَّق النطاق تحت حاجة الحاويات. مستخدم MinIO للعامل (`infra/minio/init.sh`) يقرأ بادئة الرفع ويكتب `derived/` في حاوية الوسائط فقط، ويُتحقق منه في CI (`infra/minio/check-media-policy.sh`).
- عامل الوسائط `media-worker` (profile `media`، صورة `workers/media`): جذر للقراءة فقط و`cap_drop: [ALL]` و`no-new-privileges` ومستخدم غير جذر، وحدود `MEDIA_WORKER_MEM_LIMIT`/`MEDIA_WORKER_CPUS`/`pids_limit`، وشبكة `media` وحدها. الخادم يحتاج معه `UPLOAD_VERIFIER=external` و`MEDIA_WORKER_TOKEN`. `/scratch` حجم لا tmpfs لأن الأصل قد يبلغ غيغابايتات. التحقق: `infra/compose/smoke-media.sh`.
- `-behind-proxy` لا يُفعَّل إلا خلف وكيل فعلي (عبر `TUSD_EXTRA_FLAGS`)، لأنه يجعل tusd يثق بترويسات `X-Forwarded-*`.
- أمر واحد يشغّل كل شيء من الصفر: `docker compose -f infra/compose/docker-compose.yml up -d`. والخادم معه: `--profile api` (من المصدر في `node:22`، مع `npm ci` والترحيل والبناء عند البدء)، ويُبنى له `REDIS_URL` و`DATABASE_URL` و`S3_*` من `.env` نفسه.

## بيئة التجربة (`infra/field-trial/`، `infra/backup/`، ADR 0013)

- `trial.sh` يجمع compose الأساسي و`docker-compose.trial.yml` والـ profiles (`api` `media` `ingest` `edge` `backup`) وملفي البيئة: `.env.example` ثم الأسرار من tmpfs (`/run/post-history/trial.env`).
- نسخة Caddy لكل نطاق (`Caddyfile.main` على MAIN_IP، و`Caddyfile.ingest` على INGEST_IP)، على شبكة المضيف. نسختان لا واحدة: مخزن الشهادات واحد للعملية، فنسخة واحدة تقدّم شهادة أي اسم على أي عنوان (رسب في الاختبار).
- النسخ: `infra/backup/backup.sh` يشفّر بشهادة المستلم (CMS، AES-256-GCM)، بمستخدم MinIO للقراءة فقط ودور Postgres `backup_reader` للقراءة فقط. التمرين `infra/backup/restore-drill.sh`، والاستعادة الفاشلة نتيجة `fail` لا انهيار، والناجحة `partial` لا `pass` (المرآة وفاصل النسخ غير مقيسة).
- عنوان العميل: شبكة `default` ثابتة (`172.30.240.0/24`)، والخادم والبوابة يثقان ببوابتها `172.30.240.1` وحدها، وCaddy الرئيسي يقبل `CF-Connecting-IP` من `CLOUDFLARE_CIDRS` وحدها. الدخان يثبت أن عنوانين لا يتشاركان سلة حد الدخول.
- النشر: `infra/deploy/bootstrap.sh` (أمر واحد على Ubuntu 24.04؛ الأسرار مختومة بـ age لمفتاحي المضيف والمالك، والصريح على tmpfs فقط عبر `unseal.sh`)، و`update.sh` (نسخة قبلية، إعادة تشغيل متدرجة، تراجع). الفحص الجاف `infra/deploy/test-dry-run.sh` في وظيفة compose بلا شبكة.
- المراقبة: `infra/observability/healthcheck.sh` (مؤقّت كل دقيقة، تنبيه بسجل وبريد محلي اختياري)، و`health-endpoint.py` (`/health` على 127.0.0.1:9180)، و`status.sh` (لوحة عربية للمشرف). السجلات: Caddy يرشّح سجلي الوصول والأخطاء معًا، والدخان يبحث عن وسم مزروع في كل السجلات.
- الفحص: `smoke-trial.sh` (CI، على 127.0.0.1 و127.0.0.2 بشهادات محلية، ومعه حزمة القبول عبر الحافة)، و`preflight.sh` على المضيف. ما يوفّره المالك في `docs/ops/field-trial-hosting.md`.

## tusd (`infra/tusd/`)

- R2 يشترط تساوي كل الأجزاء عدا الأخير وحدًا أدنى 5 MiB: `-s3-min-part-size` = `-s3-part-size`.
- `.part` المؤقت يحفظ ما دون الحد الأدنى؛ القرص المؤقت لخادم الرفع = الرفعات المتزامنة × حجم الجزء، ويُقاس في اختبار الحمل.
- خطّافات tusd (`pre-create`، `post-finish`) إلى `TUSD_HOOK_URL/TUSD_HOOK_SECRET` (ADR `SEC-06`). `infra/tusd/entrypoint.sh` يحجب الرمز من سجل tusd، والوكيل يحجب أجسام `500` لأن tusd يضع فيها عنوان الخطّاف.
- علم المسودة التجريبي (`EnableExperimentalProtocol`) خلف متغير بيئة لتجربة iOS فقط.
- نطاق الرفع: خلف وكيل Cloudflare افتراضيًا (الأجزاء 1–10 ميغابايت تحت حد جسم الطلب). خيار `ingest.` غير المُوكَّل نموذج أولي في `infra/ingest/` (ADR 0011): بوابة nginx+njs تتحقق في `auth_request` من رمز ES256 قصير (≤ 15 دقيقة) يصدره الخادم بعد شهادة الجهاز، ومربوط بجلسة الرفع. البوابة تحمل المفتاح العام وحده. الاختبار `infra/ingest/test-gate.sh`، ومحاكاة الحجب `tools/netlab/blocking.py`.

## الاستقلال عن المزوّد

- الحسابات والنطاقات ومفاتيح التشفير باسم الشبكة. نسخة احتياطية بقفل كائنات لدى مزوّد ثانٍ، ونسخة باردة لدى مزوّد ثالث. DNS ثانوي وشبكة توصيل احتياطية جاهزة. تجربة استعادة وخروج قبل الإطلاق.

## CI

- `contracts`: redocly lint + ajv compile. `secrets`: gitleaks. `compose`: config + pull + `infra/compose/smoke.sh` + `infra/compose/e2e-hooks.sh` (مسار الخطّاف مع الخادم) + `infra/compose/smoke-media.sh` (تحصين العامل وعزله) + `infra/ingest/test-gate.sh` (بوابة ingest). `api`: يشغّل MinIO المثبّت لاختبار محوّل S3، و`npm audit --audit-level=high` (وكذلك `acceptance`).
- `field-trial` (`.github/workflows/field-trial.yml`): `infra/field-trial/smoke-trial.sh` على كل PR يمس `infra/**` أو `apps/api/src/db/**`.
- `netlab` (`.github/workflows/netlab.yml`): فحص قصير لـ field-weak بوضع netem ومحاكاة الحجب (`blocking.py`) على كل PR يمس netlab أو compose أو ingest، وقياس كامل يدويًا.
- Dependabot (`.github/dependabot.yml`): طلب أسبوعي لـ minor+patch لكل مجلد، والإصدارات الرئيسية مُتجاهلة حتى ما بعد التجربة الميدانية. لذلك يحرس `npm audit` الثغرات العالية، وتُراجَع تنبيهات Dependabot أسبوعيًا ويُبلَّغ المنسّق بما يستدعي ترقية رئيسية.
- كل حزمة تضيف وظيفتها الخاصة حين يوجد كود.
