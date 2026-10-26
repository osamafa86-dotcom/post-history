# infra — البنية التحتية

المالك: وكيل الرفع والبنية. يملك أيضًا `tools/netlab/` و`.github/workflows/`.

## المبدأ

Docker Compose على 3–4 خوادم أولًا؛ Kubernetes وOpenSearch وTemporal وKeycloak مؤجلة حتى يثبت القياس الحاجة. أدوات التشغيل تُختار بعد تصميم التوفر واختبار الفشل، لا قبلهما.

## compose (`infra/compose/`)

- Postgres 16، Redis 7 (بكلمة مرور تمر من البيئة إلى ملف إعداد، لا في سطر الأوامر)، MinIO (بديل S3 محليًا؛ أجزاء الرفع المتعدد المتروكة تُحذف بعد 24 ساعة، وكائنات tus للجلسة الملغاة أو المنتهية يحذفها الخادم)، tusd. `.env.example` يوثّق المتغيرات بلا قيم؛ `.env` لا يُرفع.
- الأسرار في الإنتاج (SEC-05): SOPS بمفاتيح age في مستودع تشغيل خاص، تُفك على الخادم إلى tmpfs وتُقرأ بـ `env_file:`؛ لا قيمة في ملف compose ولا في سطر الأوامر. التدوير والاستعادة الطارئة في `docs/ops/runbook.md`، وتمرين التدوير `infra/secrets/rotate_hook_secret.py`.
- `tusd-proxy` يعيد حل اسم `tusd` عبر DNS الخاص بـ Docker (`resolver 127.0.0.11`): الاسم الثابت في `proxy_pass` يُحل مرة عند البدء، فيعيد 502 إن تغيّر عنوان tusd بعد إعادة إنشائه.
- المستودع عام: لا نطاق تجربة أو إنتاج ولا عنوان IP عام لخادم في ملفات التشغيل؛ `infra/compose/check-no-hosts.sh` يفحص `infra/` و`docs/ops/` و`.github/` و`tools/netlab/` وكل `*.env.example` مع فحص الأسرار في كل PR. النطاقات والعناوين في الأسرار المختومة على المضيف وحدها.
- كل المنافذ مربوطة بـ `127.0.0.1` محليًا. كل صورة في compose والتجربة وصورة النسخ بالوسم والبصمة (ADR 0004)، و`infra/compose/check-pinned.sh` في CI يحرس ذلك. سجلات الوكلاء تكتب `/files/-` مكان معرّف الرفع.
- tusd بلا منفذ منشور، خلف `tusd-proxy` (nginx، `infra/proxy/tusd.conf`) على شبكة `uploads` الداخلية؛ الخطّاف على شبكة `hooks` الداخلية.
- شبكة `media` الداخلية (ADR 0006): عامل الوسائط بعنوان ثابت `172.30.251.2`، والخادم وMinIO وRedis بعناوين ديناميكية من `.8/29`. Docker يأخذ البوابة من داخل `ip_range`، فلا يُضيَّق النطاق تحت حاجة الحاويات. مستخدم MinIO للعامل (`infra/minio/init.sh`) يقرأ بادئة الرفع ويكتب `derived/` في حاوية الوسائط فقط، ويُتحقق منه في CI (`infra/minio/check-media-policy.sh`).
- عامل الوسائط `media-worker` (profile `media`، صورة `workers/media`): جذر للقراءة فقط و`cap_drop: [ALL]` و`no-new-privileges` ومستخدم غير جذر، وحدود `MEDIA_WORKER_MEM_LIMIT`/`MEDIA_WORKER_CPUS`/`pids_limit`، وشبكة `media` وحدها. الخادم يحتاج معه `UPLOAD_VERIFIER=external` و`MEDIA_WORKER_TOKEN`. `/scratch` حجم لا tmpfs لأن الأصل قد يبلغ غيغابايتات. التحقق: `infra/compose/smoke-media.sh`.
- عامل التفريغ المحلي (profile `ai`، ADR 0019، 0020): `ai-models` ينزّل الأوزان مرة ببصماتها من `infra/ai/models.lock` ويخرج (وحده على شبكة لها خروج)، و`ai-worker` على صورة `workers/ai` (faster-whisper large-v3-turbo افتراضيًا) يستهلك `media:events` بمجموعة `ai`، بتحصين عامل الوسائط وحدوده (`AI_WORKER_MEM_LIMIT`/`AI_WORKER_CPUS`)، والأوزان للقراءة فقط، وشبكة `media` وحدها بعنوان `172.30.251.3` (في `INTERNAL_ALLOWED_CIDRS`). التفريغ خلف `AI_ENABLE_TRANSCRIPT=true`. مستخدم MinIO للعامل (`S3_AI_*`) يقرأ `derived/*/*/proxy-480p.mp4` و`derived/*/*/audio-16k.m4a` ويقرأ `derived/*/*/{transcript.json,transcript.vtt,shots.json,shot_list.json}` ويكتبها فقط، ويُتحقق منه في `check-media-policy.sh`. الفحص `infra/ai/smoke-ai.sh` (سير `ai-runtime`، بنموذج tiny المثبّت)، والتفريغ طرفًا لطرف `transcript-draft` في وظيفة media e2e. المعالج الرسومي مؤجل (صورة العامل للمعالج).
- `-behind-proxy` لا يُفعَّل إلا خلف وكيل فعلي (عبر `TUSD_EXTRA_FLAGS`)، لأنه يجعل tusd يثق بترويسات `X-Forwarded-*`.
- أمر واحد يشغّل كل شيء من الصفر: `docker compose -f infra/compose/docker-compose.yml up -d`. والخادم معه: `--profile api` (من المصدر في `node:22`، مع `npm ci` والترحيل والبناء عند البدء)، ويُبنى له `REDIS_URL` و`DATABASE_URL` و`S3_*` من `.env` نفسه.

## بيئة التجربة (`infra/field-trial/`، `infra/backup/`، ADR 0013)

- `trial.sh` يجمع compose الأساسي و`docker-compose.trial.yml` والـ profiles (`api` `media` `ingest` `edge` `backup`) وملفي البيئة: `.env.example` ثم الأسرار من tmpfs (`/run/post-history/trial.env`).
- نسخة Caddy لكل نطاق (`Caddyfile.main` على MAIN_IP، و`Caddyfile.ingest` على INGEST_IP)، على شبكة المضيف. نسختان لا واحدة: مخزن الشهادات واحد للعملية، فنسخة واحدة تقدّم شهادة أي اسم على أي عنوان (رسب في الاختبار).
- النسخ: `infra/backup/backup.sh` يشفّر بشهادة المستلم (CMS، AES-256-GCM)، بمستخدم MinIO للقراءة فقط ودور Postgres `backup_reader` للقراءة فقط. التمرين `infra/backup/restore-drill.sh`، والاستعادة الفاشلة نتيجة `fail` لا انهيار، والناجحة `partial` لا `pass` (المرآة وفاصل النسخ غير مقيسة).
- عنوان العميل: شبكة `default` ثابتة (`172.30.240.0/24`)، والخادم والبوابة يثقان ببوابتها `172.30.240.1` وحدها، وCaddy الرئيسي يقبل `CF-Connecting-IP` من `CLOUDFLARE_CIDRS` وحدها. الدخان يثبت أن عنوانين لا يتشاركان سلة حد الدخول.
- الخادم في التجربة من صورة `post-history-api:<commit>` (ADR 0050) لا من المصدر: `trial.sh` يضبط `API_IMAGE` من الالتزام الحالي، و`NODE_ENV=production`، وبلا `npm ci` ولا بناء عند البدء. تُبنى في CI عند نشر إصدار (`api-image.yml`) وتُرفق به، و`infra/deploy/api-image.sh --tag` يتحقق من البصمة والالتزام قبل `docker load` (و`--build` لـ `--main`). الفحص `infra/deploy/test-api-image.sh` في وظيفة compose، وCI التجربة يبنيها من التزام الطلب.
- النشر: `infra/deploy/bootstrap.sh` (أمر واحد على Ubuntu 24.04؛ الأسرار مختومة بـ age لمفتاحي المضيف والمالك، والصريح على tmpfs فقط عبر `unseal.sh`)، و`update.sh` (نسخة قبلية، إعادة تشغيل متدرجة، تراجع). الفحص الجاف `infra/deploy/test-dry-run.sh` في وظيفة compose بلا شبكة، ويثبت أيضًا أن دليل المالك `docs/ops/deploy-guide.md` يطابق السكربتات (مساراتها وخطوات bootstrap ومفاتيح host.env).
- المراقبة: `infra/observability/healthcheck.sh` (مؤقّت كل دقيقة، تنبيه بسجل وبريد محلي اختياري)، و`health-endpoint.py` (`/health` على 127.0.0.1:9180)، و`status.sh` (لوحة عربية للمشرف). السجلات: Caddy يرشّح سجلي الوصول والأخطاء معًا، والدخان يبحث عن وسم مزروع في كل السجلات.
- المراقبة ذاتية الاستضافة (ADR 0027، `infra/observability/compose.monitoring.yml`، مشروع مستقل): Prometheus وGrafana وLoki ومجمّع OpenTelemetry وnode-exporter على شبكة داخلية، وGrafana وحده على 127.0.0.1:3300. المجمّع يقرأ ملفات json-file لـ Docker (الوسم `tag`) وينقّي الرموز والعناوين ومعرّفات الرفع والإحداثيات ومعرّفات الأجهزة قبل Loki، ويحوّل التتبّع إلى مقاييس طلبات. `healthcheck.sh --prom` يكتب الفحوص مقاييس. كل خدمة محدودة الذاكرة بلا swap (المجموع 1072 MB). الدخان `smoke-monitoring.sh` في وظيفة compose.
- تتبّع الأخطاء (ADR 0029، `infra/observability/compose.errors.yml`، مشروع مستقل): GlitchTip المتوافق مع حزم Sentry، عملية واحدة مع Postgres وRedis خاصين، على 127.0.0.1:3301 وحده. `errors-init.sh` ينشئ المشرف فورًا (التسجيل مفتوح ما دام لا مستخدم) ومشروعي api وweb ويطبع DSN كل منهما. الدخان `smoke-errors.sh` في وظيفة compose.
- المشروعان على المضيف: `infra/observability/stack.sh monitoring|errors <أمر compose>` بأسرار التجربة المفكوكة (`GRAFANA_ADMIN_PASSWORD` و`GLITCHTIP_*` يولّدها `bootstrap.sh`). `bootstrap.sh` يشغّلهما بعد التجربة وتبقيهما وحدة `post-history-observability`، و`update.sh` يعيدهما بعد التحديث خارج التراجع. `daemon.json` يسم السجلات باسم الحاوية، ومؤقّت الفحوص يكتب `--prom` في `/var/lib/post-history/textfile`. `errors-init.sh` يدوي مرة (بريد المشرف).
- البوابة أمام النطاقين: `/files/` على النطاق الرئيسي يمر بها أيضًا (`Caddyfile.main` إلى `INGEST_PORT`)، فلا رفع بلا رمز ingest على أي منهما؛ و`preflight.sh` يرسب إن رُفع فحص الجلسة.
- ingest مطلوب افتراضيًا في التجربة (`INGEST_REQUIRED=true` في `docker-compose.trial.yml` و`bootstrap.sh`، و`ATTESTATION_MODE=production`)، ولا يُطفأ إلا بقرار مكتوب. الدخان يثبت أن الخادم يعلن نطاق ingest، وأن PATCH برمز مفتاح مُبطَل أو غريب أو منتهٍ أو لجلسة أخرى يُرفض عند البوابة والإزاحة لا تتغير. والبوابة تسأل الخادم عن حالة كل جلسة (`/internal/ingest/session-status?sid=&ses=` بسر `INGEST_GATE_TOKEN` من 172.30.250.3 على hooks، مخبأ ثانيتين، ومغلقة عند العطل)، فرمز صالح لجلسة أُبطلت يُرفض خلال ثوانٍ (SEC-01، يقيسه الدخان مقابل 5 ث). وعنوان البوابة لا يصل إلا إلى `/internal/ingest/` (`INTERNAL_SOURCE_PATHS`، ثابت في compose التجربة ويفحصه preflight)، والدخان يثبت 403 منه على مسارات عامل الوسائط وخطّاف tusd.
- نافذة مفتاح الاختبار qa- (ADR 0022) لحزمة القبول عبر الحافة: `infra/field-trial/qa-window.sh open --email <حساب القبول>` يولّد مفتاحًا جديدًا لكل نافذة (≤ 72 ساعة، الخاص في tmpfs ولا يدخل المستودع)، ويكتب `INGEST_QA_PUBLIC_KEY` و`INGEST_QA_KEY_EXPIRES` و`ACCEPTANCE_UPLOADER_USER_ID` في ملف الأسرار المفكوك، و`close` يزيلها. البوابة تقبل معرّف `qa-` من الخانة وحدها حتى انتهائها، وتشتق `key_class` من الخانة التي تحققت بها وترسله مع كل فحص، والخادم يقبل بـ qa جلسات حساب القبول وحده. الخانة في ملف التجربة وحده؛ `preflight.sh` يرسب إن كانت مضبوطة بلا `--qa-window`، و`healthcheck.sh` ينبّه بعد انتهائها.
- حزمة تسليم المشتري مطفأة في التجربة حتى يمر شراء sandbox كاملًا: `MEDIA_ENABLE_DELIVERY: "false"` ثابت لعامل الوسائط في `docker-compose.trial.yml` لا من الأسرار، و`preflight.sh` يرسب إن ضُبط في `trial.env` ويفحص العامل الجاري (التسليم مطفأ والمحاذاة مفعّلة)، والدخان يثبت الشيء نفسه.
- مزوّد الدفع التجريبي (ADR 0032): التجربة تبقى `NODE_ENV=production`، و`DEPLOY_STAGE=trial` و`PAYMENT_SANDBOX_ALLOWED=1` ثابتان للخادم في `docker-compose.trial.yml` لا من الأسرار، و`PAYMENT_PROVIDER` (none أو sandbox) و`SANDBOX_WEBHOOK_SECRET` من الأسرار (`bootstrap.sh` يضع sandbox ويولّد السر). `Caddyfile.main` يمرر `/sandbox/checkout/*` وحده خارج `/v1` (الإشعار داخل الخادم)، و`preflight.sh` يرسب على مزوّد غير none/sandbox أو على العلمين في الأسرار، والدخان يثبت الإقلاع بالمزوّد التجريبي والتوجيه.
- النسخ بحجم مقيس: `BACKUP_MEASURE_MIB=N smoke-trial.sh` يضع N ميغابايت كائنات اصطناعية غير قابلة للضغط، ويقيس النسخ الكامل والتزايدي والسحب من المزوّد الثاني مع تمريني الاستعادة، ويكتب النتيجة في `BACKUP_MEASURE_OUT` بمخطط القياس. الفاصل يومي، فالفقد حتى 24 ساعة مقابل 15 دقيقة في الخطة (أرشفة WAL المستمرة غير مبنية).
- أرشفة WAL (ADR 0051): Postgres التجربة مبنية من `infra/postgres` (الأساس بالبصمة وWAL-G من وسم مثبّت بالتزامه)، و`archive_command` بـ WAL-G إلى حاوية مقفلة لدى المزوّد الثاني بمفتاح كتابة فقط، مشفّرة بمفتاح PGP عام (الخاص عند المالك). `walg-base` نسخة أساسية يومية بدور `walg_backup` (بدء النسخة وإنهاؤها وقراءة الإعدادات) ومجلد البيانات للقراءة فقط. مطفأة ما لم يُضبط `WALG_ARCHIVE_MODE=on`. التمرين `infra/backup/pitr-drill.sh`، والدخان يثبت: الأرشفة، والقفل، وأن مفتاح الكتابة لا يقرأ ولا يحذف، وأن المفتاح العام لا يفك، وألا مفتاح خاص في بيئة أي حاوية أو ملف مركّب، والاستعادة لأي لحظة. `check-no-private-keys.sh` مع فحص الأسرار في كل PR، و`healthcheck.sh` (`wal:archive`) ينبّه بعد 10 دقائق انتظار.
- الفحص: `smoke-trial.sh` (CI، على 127.0.0.1 و127.0.0.2 بشهادات محلية، ومعه حزمة القبول عبر الحافة، وفي آخره تمرين التوفر `availability` (يقتل عملية الحاوية من المضيف كالانهيار، لا `docker kill` الذي لا تعيده سياسة restart))، و`preflight.sh` على المضيف. ما يوفّره المالك في `docs/ops/field-trial-hosting.md`.

## المعاينة الخفيفة (`infra/preview/`، ADR 0023)

- معاينة على خادم مشترك ذاكرته شبه ممتلئة. معاينة فقط، لا تُنقل إلى التجربة.
- **الصورتان تُبنيان في CI وحده** (`api.Dockerfile`، `web.Dockerfile`؛ إنتاج، ومستخدم node، وبلا أسرار).
  - على main ويدويًا، ترفعهما `preview-images.yml` tar مضغوطًا مع `SHA256SUMS` إلى الإصدار التمهيدي `preview-latest`.
  - الخادم ينزّلهما بـ `fetch-images.sh`، يتحقق من البصمة ثم `docker load`. لا بناء على الخادم.
- **`docker-compose.preview.yml`:** Postgres وRedis وMinIO والخادم والويب، وtusd ووكيله وبوابة ingest للرفع من الحاسوب.
  - لكل خدمة `mem_limit` و`memswap_limit` مساوٍ له، والمجموع 928 MB تحت سقف 960 MB.
  - لا منفذ على المضيف.
  - `web` (nginx) وحده على الشبكة الخارجية `deploy_default` باسم `lib-web:8080`. يصل إلى منبعيه باسمين فريدين على الشبكة الداخلية (`ph-preview-api`، `ph-preview-web-app`)، لأن الاسم القصير قد يُحل على الشبكة المشتركة إلى حاوية أخرى. يضع `X-Robots-Tag: noindex` وشريط «معاينة»، ويُنهي TLS داخليًا للخادم على عنوانه الداخلي وحده، لأن الـBFF يشترط https.
  - الرفع من الحاسوب وحده: الحافة تمرر `/files/` على أصل المعاينة إلى البوابة (`ph-preview-ingest`) ثم `tusd-proxy` ثم tusd، بعناوين ثابتة يقبلها الخادم في `/internal` (البوابة إلى `/internal/ingest/` وحده). رمز الويب للـBFF وحده (`BFF_SOURCE_ADDRESSES` = الحافة). شهادة الجهاز مغلقة (معرّف تطبيق لا يحمله جهاز)، ولا عامل وسائط ولا تفريغ: المادة تبقى «بانتظار المعالجة».
  - `.env` قائم قبل الرفع: `./gen-env.sh --add-upload` يضيف مفاتيح الرفع وحدها.
  - حدود التخزين: الملف ≤ 2 GiB (`tusd -max-size`)، و10 GiB للكل (حصتان صلبتان في MinIO و64 MiB لأجزاء tusd)، والرفع المتعدد المتروك يُحذف بعد 24 ساعة.
- **`.env` يولّده `gen-env.sh` مرة على الخادم،** بأسرار عشوائية وبالنطاق؛ لا نطاق ولا عنوان في المستودع.
- **`seed-preview.sh`** ينشئ مشرفًا ورئيس تحرير ومراسلًا تجريبيين وثلاث مواد اصطناعية.
  - كلمات السر في `.env` لا في المخرج.
  - بلا مدير نظام.
- **الدخان:** `smoke-preview.sh` في CI يثبت بالصور المبنية:
  - `/health`؛
  - الدخول عبر الويب؛
  - رفع tus صغير عبر الـBFF والحافة والبوابة، يُقطع ويُستأنف، والجلسة `completed` أو `verified`؛
  - عزل الخادم عن الشبكة المشتركة؛
  - مجموع الحدود والاستهلاك الفعلي.

## tusd (`infra/tusd/`)

- R2 يشترط تساوي كل الأجزاء عدا الأخير وحدًا أدنى 5 MiB: `-s3-min-part-size` = `-s3-part-size`.
- `.part` المؤقت يحفظ ما دون الحد الأدنى؛ القرص المؤقت لخادم الرفع = الرفعات المتزامنة × حجم الجزء، ويُقاس في اختبار الحمل.
- خطّافات tusd (`pre-create`، `post-finish`) إلى `TUSD_HOOK_URL/TUSD_HOOK_SECRET` (ADR `SEC-06`). `infra/tusd/entrypoint.sh` يحجب الرمز من سجل tusd، والوكيل يحجب أجسام `500` لأن tusd يضع فيها عنوان الخطّاف.
- علم المسودة التجريبي (`EnableExperimentalProtocol`) خلف متغير بيئة لتجربة iOS فقط.
- نطاق الرفع: خلف وكيل Cloudflare افتراضيًا (الأجزاء 1–10 ميغابايت تحت حد جسم الطلب). خيار `ingest.` غير المُوكَّل نموذج أولي في `infra/ingest/` (ADR 0011): بوابة nginx+njs تتحقق في `auth_request` من رمز ES256 قصير (≤ 15 دقيقة) يصدره الخادم بعد شهادة الجهاز، ومربوط بجلسة الرفع. البوابة تحمل المفاتيح العامة وحدها بمعرّفاتها (`INGEST_TOKEN_PUBLIC_KEYS="kid:spki,..."`؛ مفتاحان أثناء التدوير). الاختبار `infra/ingest/test-gate.sh`، ومع الخادم (ATTESTATION_MODE=test) `infra/ingest/e2e-attested.sh`، ومحاكاة الحجب `tools/netlab/blocking.py`.

## الاستقلال عن المزوّد

- الحسابات والنطاقات ومفاتيح التشفير باسم الشبكة. نسخة احتياطية بقفل كائنات لدى مزوّد ثانٍ، ونسخة باردة لدى مزوّد ثالث. DNS ثانوي وشبكة توصيل احتياطية جاهزة. تجربة استعادة وخروج قبل الإطلاق.

## CI

- `contracts`: redocly lint + ajv compile. `secrets`: gitleaks. `compose`: config + pull + `infra/compose/smoke.sh` + `infra/compose/e2e-hooks.sh` (مسار الخطّاف مع الخادم) + `infra/compose/smoke-media.sh` (تحصين العامل وعزله) + `infra/ingest/test-gate.sh` (بوابة ingest) + `infra/ingest/e2e-attested.sh` (الخادم والبوابة معًا). `api`: يشغّل MinIO المثبّت لاختبار محوّل S3، و`npm audit --audit-level=high` (وكذلك `acceptance`).
- `field-trial` (`.github/workflows/field-trial.yml`): `infra/field-trial/smoke-trial.sh` على كل PR يمس `infra/**` أو `apps/api/src/db/**`.
- `preview-images` (`.github/workflows/preview-images.yml`): صورتا المعاينة و`smoke-preview.sh` على كل PR يمس التطبيقين أو العقد أو `infra/preview`، والنشر إلى `preview-latest` على main.
- `netlab` (`.github/workflows/netlab.yml`): فحص قصير لـ field-weak بوضع netem ومحاكاة الحجب (`blocking.py`) على كل PR يمس netlab أو compose أو ingest، وقياس كامل يدويًا.
- Dependabot (`.github/dependabot.yml`): طلب أسبوعي لـ minor+patch لكل مجلد، والإصدارات الرئيسية مُتجاهلة حتى ما بعد التجربة الميدانية. لذلك يحرس `npm audit` الثغرات العالية، وتُراجَع تنبيهات Dependabot أسبوعيًا ويُبلَّغ المنسّق بما يستدعي ترقية رئيسية.
- كل حزمة تضيف وظيفتها الخاصة حين يوجد كود.
