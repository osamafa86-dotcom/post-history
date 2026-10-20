# مضيف التجربة الميدانية: ما يلزم وكيف يُجهَّز

المالك: وكيل الرفع والبنية. القرار: ADR 0013 (وADR 0011 للنطاقين، وSEC-05 للأسرار). هذه قائمة ما يوفّره مالك المشروع، ثم خطوات التجهيز والتحقق. الأرقام أدناه **تقدير** بفرضيات مكتوبة، لا قياس؛ تُصحَّح بعد أول أسبوع.

## 1. ما يوفّره المالك

| البند | الحد الأدنى | لماذا |
| --- | --- | --- |
| خادم واحد (VPS أو مخصص) | 4 أنوية، 16 GiB ذاكرة | عامل الوسائط محدود بنواتين و2 GiB (FFmpeg للنسخة الخفيفة)، والخادم وPostgres وMinIO وRedis والوكيلان بما بقي، مع هامش للنظام |
| قرص البيانات | 500 GiB فارغة على قرص Docker (يُفضَّل 1 TiB) | الأصول كاملة في MinIO. الفرضية: 10 مراسلين × 5 مقاطع يوميًا × نحو 1 GiB × 14 يومًا ≈ 700 GiB |
| قرص النسخ | 500 GiB على **جهاز آخر** غير قرص البيانات | نسخة على القرص نفسه تضيع معه. preflight يتحقق من اختلاف الجهاز |
| عنوانان IPv4 عامان على الخادم نفسه | عنوان للرئيسي (A) وآخر لـ ingest (B) | ADR 0011: ما يميّز ingest اسم آخر وعنوان آخر؛ اسم ingest على عنوان الرئيسي يسقط مع حجب العنوان. يُفضَّل ألا يكون العنوانان من الكتلة نفسها (/24) إن أتاح المزوّد |
| نطاق رئيسي | خلف Cloudflare (السحابة البرتقالية) | الحماية من حجب الخدمة (الخطة)، وعنوان A مخفي خلفه |
| نطاق ingest | اسم مستقل لا يُشتق من الرئيسي (يُفضَّل نطاق آخر)، DNS فقط (السحابة الرمادية) إلى B | لا وكيل أمامه بقصد (ADR 0011). اسم مشتق يكشف صلته بالرئيسي |
| حاوية لدى مزوّد ثانٍ | S3 متوافق، بقفل كائنات (Object Lock)، ومفتاح وصول مقيّد بها | النسخة خارج المزوّد الأول (مبدأ الاستقلال). اختيارية في التجربة، إلزامية قبل الإطلاق |
| زوج مفاتيح النسخ | المالك يولّده على جهاز غير متصل، ويعطي **الشهادة وحدها** للخادم | الخادم يشفّر النسخ ولا يستطيع فكها (ADR 0013) |
| بريد لإشعارات ACME | عنوان بريد للشبكة | انتهاء الشهادات وتنبيهات Let's Encrypt |
| مراقبة التوفر | قرار المالك: فحص من المضيف نفسه (`curl http://127.0.0.1:<API_PORT>/health`) أو فحص Cloudflare على مسار `/v1/*` | `/health` لا يُنشر على الحافة (ترويساته تكشف حالة حد المعدل)، فلا يُراقَب من الخارج بذلك المسار |
| نطاقات Cloudflare (`CLOUDFLARE_CIDRS`) | قرار المالك: من يحدّثها ومتى (https://www.cloudflare.com/ips/) | نطاق ناقص يجعل عملاء ذلك النطاق سلة حد معدل واحدة؛ نطاق زائد يقبل `CF-Connecting-IP` من غير Cloudflare |

**نظام التشغيل والحزم:** Ubuntu 24.04 LTS، وDocker Engine ≥ 24 مع إضافة compose ≥ 2.24، وsops وage وpython3 وcurl وopenssl وgit.

## 2. الشبكة والمنافذ

| الاتجاه | المنفذ | العنوان | الغرض |
| --- | --- | --- | --- |
| وارد | 22/tcp | من عناوين الإدارة فقط (جدار المزوّد) | SSH بمفاتيح، بلا كلمة مرور |
| وارد | 80/tcp و443/tcp | A | Caddy للرئيسي (80 لتحدي ACME والتحويل إلى https) |
| وارد | 80/tcp و443/tcp | B | Caddy لـ ingest |
| صادر | 443/tcp | — | ACME، وسحب الصور (Docker Hub وghcr)، وnpm عند بناء الخادم، ومزوّد النسخ الثاني |
| صادر | 53 | — | DNS |

لا منفذ آخر على عنوان عام. Postgres وRedis وMinIO والخادم وtusd-proxy مربوطة بـ `127.0.0.1`، وpreflight يفشل إن وجد مستمعًا عامًا غير 22/80/443.

**Cloudflare للنطاق الرئيسي:**

- وضع SSL **Full (strict)**.
- «Always Use HTTPS» **مطفأ**: Caddy يحوّل بنفسه، والتحويل في Cloudflare يكسر تحدي ACME عبر HTTP.

## 3. خطوات التجهيز

1. **العنوانان:** يُضاف B على واجهة الخادم إن لم يكن (حسب المزوّد، عبر netplan)، ثم يُتحقق أن `hostname -I` يذكر A وB.
2. **DNS:** الرئيسي `A → A` بالسحابة البرتقالية، وingest `A → B` بالسحابة الرمادية.
3. **المستودع:** `git clone` في `/srv/post-history/app`.
4. **قرص النسخ:** يُركَّب في `/srv/post-history/backups`، ثم `chown 70:70` (مستخدم صورة النسخ).
5. **شهادة مستلم النسخ:** يولّد المالك الزوج على جهازه غير المتصل:
   ```bash
   openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:secp384r1 -nodes -days 730 \
     -subj /CN=post-history-backup -keyout backup-recipient.key -out backup-recipient.crt
   ```
   - `backup-recipient.crt` وحده إلى `/etc/post-history/backup-recipient.crt` على الخادم.
   - المفتاح يُحفظ مع مفتاح استرداد SOPS، ولا يوضع على الخادم إلا وقت التمرين ثم يُزال.
6. **الأسرار:** ملف `secrets/trial.enc.env` في مستودع التشغيل بأسماء `infra/field-trial/trial.env.example` وقيم حقيقية. يُفك على الخادم:
   ```bash
   install -d -m 700 /run/post-history
   sops -d --input-type dotenv --output-type dotenv secrets/trial.enc.env > /run/post-history/trial.env
   chmod 400 /run/post-history/trial.env
   ```
   `/run` على tmpfs. بعد إعادة الإقلاع يُعاد الفك قبل التشغيل.
   الأسرار تشمل `BACKUP_PG_PASSWORD`: كلمة مرور دور `backup_reader` في Postgres (قراءة فقط)، تنشئه خدمة `backup-db-role` عند التشغيل. حاوية النسخ لا تحمل كلمة مرور مالك القاعدة.
7. **الفحص قبل التشغيل:** `sudo infra/field-trial/preflight.sh`. يجب ألا يبقى FAIL.
8. **التشغيل:** `sudo infra/field-trial/trial.sh up -d --wait`.
9. **الفحص بعد التشغيل:** `sudo infra/field-trial/preflight.sh --running --json docs/measurements/ops/$(date +%F)-field-trial-preflight.json`.
10. **أول نسخة وتمرين الاستعادة** (يُحضَر المفتاح الخاص ثم يُزال):
    ```bash
    sudo infra/field-trial/trial.sh run --rm backup once
    sudo COMPOSE=infra/field-trial/trial.sh BACKUP_DIR=/srv/post-history/backups DRILL_ENV=trial-host \
      infra/backup/restore-drill.sh --key /path/to/backup-recipient.key \
      --out docs/measurements/ops/$(date +%F)-restore-drill-trial-host.json
    ```
    النتيجة تُرفع إلى المستودع. **لا تجربة قبل تمرين ناجح على المضيف نفسه.**

## 4. ما لا يُدّعى بعد

- الأرقام في §1 تقدير. الحجم الفعلي يُقاس بعد الأسبوع الأول من `last-success.json` وحجم MinIO.
- تمرين الاستعادة الأول (`docs/measurements/ops/2026-10-20-restore-drill-local.json`) **فشل** بعطل في ترحيل قيد الـ outbox. بعد إصلاحه (#73) نجح التمرين في CI (`2026-10-20-restore-drill-ci.json`): 20 جدولًا بلا نقص، و4 من 4 كائنات. النتيجتان `partial`، لأنهما ليستا على المضيف نفسه.
- الخادم يُبنى من المصدر عند البدء. أول تشغيل يستغرق دقائق ويحتاج npm.
