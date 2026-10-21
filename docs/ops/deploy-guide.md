# دليل النشر الكامل على خادم مخصص: خطوة بخطوة للمالك

المالك: وكيل الرفع والبنية. لمن يجهّز خادم التجربة الميدانية المخصص (16 GB). ما يوفّره المالك وتقدير الأحجام في
`docs/ops/field-trial-hosting.md` §1، والطوارئ والتدوير في `docs/ops/runbook.md`. هذا الدليل الترتيب الذي يُنفَّذ به ذلك كله
مرة واحدة، ولكل خطوة ما يثبت نجاحها.

**ما ثُبت قبل المضيف:** كل خطوة من `bootstrap.sh` إلى `update.sh` تمر في الفحص الجاف `infra/deploy/test-dry-run.sh`
(Ubuntu 24.04 بلا شبكة، في CI)، والبيئة كاملة بحافتيها تمر في `infra/field-trial/smoke-trial.sh`. **لم يُشغَّل على مضيف
حقيقي بعد**، فأول تشغيل يكتب نتيجته في `docs/measurements/ops/`.

الرموز بين `<>` قيم يملؤها المالك. لا يُكتب في المستودع اسم نطاق ولا عنوان ولا مفتاح.

## الخطوة 0 — على جهاز المالك غير المتصل: المفتاحان

مرة واحدة، وتُحفظ النتيجة في خزنة المالك لا على الخادم.

1. **مفتاح age للمالك** (يفك الأسرار المختومة إن ضاع المضيف):
   ```bash
   age-keygen -o owner.agekey          # المفتاح الخاص: الخزنة وحدها
   age-keygen -y owner.agekey          # المفتاح العام age1…: يُعطى لـ bootstrap
   ```
2. **زوج النسخ الاحتياطي** (الخادم يشفّر ولا يفك، ADR 0013):
   ```bash
   openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:secp384r1 -nodes -days 730 \
     -subj /CN=post-history-backup -keyout backup-recipient.key -out backup-recipient.crt
   ```
   - `backup-recipient.crt` وحده يُنقل إلى الخادم.
   - `backup-recipient.key` يبقى في الخزنة، ولا يصل إلى الخادم إلا وقت تمرين الاستعادة ثم يُحذف.

**التحقق:** `bootstrap.sh` يرفض شهادة ملفها يحمل مفتاحًا خاصًا، ومفتاح مالك لا يبدأ بـ `age1`. يثبت ذلك `test-dry-run.sh` (refusals).

## الخطوة 1 — الخادم والشبكة وDNS

1. Ubuntu 24.04 LTS بمفاتيح SSH وحدها، والجدار عند المزوّد يسمح بـ 22 من عناوين الإدارة فقط.
2. العنوان الثاني (B) على واجهة الخادم (netplan حسب المزوّد)، ثم: `hostname -I` يذكر A وB.
3. DNS:
   - الرئيسي `A → A` خلف Cloudflare (السحابة البرتقالية)، بوضع SSL **Full (strict)**، و«Always Use HTTPS» مطفأ.
   - ingest `A → B` بلا وكيل (السحابة الرمادية)، باسم لا يُشتق من الرئيسي.
4. قرص النسخ مركّب في `/srv/post-history/backups` على جهاز غير قرص Docker.

**التحقق:** `preflight.sh` (الخطوة 4) يرسب إن:
- غاب أحد العنوانين عن المضيف؛
- أو حُل ingest إلى غير B؛
- أو حُل الرئيسي إلى B؛
- أو كان قرص النسخ على جهاز Docker نفسه؛
- أو استمع شيء عام غير 22/80/443.

## الخطوة 2 — المستودع وملف المضيف

```bash
sudo git clone https://github.com/osamafa86-dotcom/post-history /srv/post-history/app
sudo install -m 0600 /dev/null /root/host.env
sudo install -m 0644 backup-recipient.crt /root/backup-recipient.crt
```

`/root/host.env` بلا أسرار:

```bash
MAIN_DOMAIN=<النطاق الرئيسي>
INGEST_DOMAIN=<نطاق ingest>
MAIN_IP=<A>
INGEST_IP=<B>
ACME_EMAIL=<بريد الشبكة>
CLOUDFLARE_CIDRS=<نطاقات Cloudflare من https://www.cloudflare.com/ips/ مفصولة بمسافة>
# معرّف تطبيق واحد على الأقل لشهادة الجهاز (بدونه لا يحصل جهاز على رمز رفع):
APP_ATTEST_APP_ID=<TeamID>.<BundleID>
# أو: PLAY_INTEGRITY_PACKAGE_NAME=<package> و PLAY_INTEGRITY_CERT_SHA256=<sha256>
```

**التحقق:** `bootstrap.sh` يرفض قبل أن يكتب شيئًا:
- ملفًا ينقصه مفتاح؛
- أو عنوانًا واحدًا للاسمين.

يثبت ذلك `test-dry-run.sh`.

## الخطوة 3 — التجهيز بأمر واحد

```bash
cd /srv/post-history/app
sudo infra/deploy/bootstrap.sh --host-config /root/host.env \
  --backup-cert /root/backup-recipient.crt --owner-age-recipient <age1… من الخطوة 0>
```

إحدى عشرة خطوة تُطبع `== step N/11`، وكلها تُعاد بأمان:

1. `os`، ثم `packages` (Docker بإصدار مثبّت)، ثم `user`، ثم `firewall`، ثم `dirs`.
2. `secrets`: تُولَّد مرة وتُختم لمفتاح المضيف ومفتاح المالك، ولا تُطبع.
3. `images`، ثم `preflight`، ثم `start`، ثم `systemd`، ثم `verify`.

ingest مطلوب (`INGEST_REQUIRED=true`) وشهادة الجهاز بوضع الإنتاج.

**التحقق:**
- آخر سطر من `verify` هو `preflight: N ok, 0 FAIL`.
- `sudo infra/observability/status.sh` يعرض الخدمات سليمة.

## الخطوة 4 — حفظ الأسرار المختومة والفحص

1. ينسخ المالك `/etc/post-history/trial.env.age` و`/etc/post-history/break-glass.age` إلى مستودع التشغيل الخاص.
   - الأول يفكه مفتاح المالك إن ضاع المضيف.
   - الثاني رمز الاستعادة الطارئة للمالك وحده (`docs/ops/runbook.md` §1).
2. نتيجة الفحص تُرفع إلى المستودع:
   ```bash
   sudo infra/field-trial/preflight.sh --running \
     --json docs/measurements/ops/$(date +%F)-field-trial-preflight.json
   ```

**التحقق:** لا FAIL. الملف لا يحمل نطاقًا ولا عنوانًا (يُستبدلان بأسمائهما الرمزية).

## الخطوة 5 — أول نسخة وتمرين الاستعادة على المضيف

```bash
sudo infra/field-trial/trial.sh run --rm backup once
# المفتاح الخاص للنسخ يُحضَر من الخزنة لهذا الأمر وحده ثم يُحذف
sudo COMPOSE=infra/field-trial/trial.sh BACKUP_DIR=/srv/post-history/backups DRILL_ENV=trial-host \
  infra/backup/restore-drill.sh --key /root/backup-recipient.key \
  --out docs/measurements/ops/$(date +%F)-restore-drill-trial-host.json
sudo shred -u /root/backup-recipient.key
```

**التحقق:** `restore drill: pass` (يُسجَّل `partial`: المرآة وفاصل النسخ غير مقيسة). **لا تجربة قبل تمرين ناجح على المضيف نفسه.**

## الخطوة 6 — الحسابات الأولى

بأمر `cli:create-user` في الخادم (ADR 0030، #199). يُشغَّل داخل حاوية `api` ببيئتها، والطرفية تفاعلية لأن رموز TOTP ورمز الخزنة تُقرأ منها:

```bash
C="sudo infra/field-trial/trial.sh exec api npm run cli:create-user --"
# 1) أول مديرَي نظام: رمز الخزنة وحده، ويُغلق هذا الطريق بعد المدير الثاني
$C --mode bootstrap --email <بريد> --role system_admin
# 2) مدير نظام بعدهما: مديران فاعلان برمزي TOTP، أو رمز الخزنة + مدير أو رئيس تحرير
$C --mode two-admins --approver <adminId> --approver <adminId> --email <بريد> --role system_admin
# 3) بقية الأدوار: مدير نظام فاعل واحد برمز TOTP
$C --mode one-admin --approver <adminId> --email <بريد> --role <دور> [--scope-kind office|governorate --scope-id <id>] [--office <officeId>]
```

- طريق `bootstrap` و`vault` يحتاجان `BREAK_GLASS_TOKEN_SHA256` في `trial.env`، والرمز نفسه من `break-glass.age` (الخطوة 4) يُكتب عند السؤال.
- الأمر يطبع مرة **رمز تعيين لمرة واحدة صالحًا 24 ساعة**، لا كلمة سر. يُسلَّم لصاحب الحساب بقناة آمنة ولا يُنسخ إلى ملف.
- لا يدخل الحساب دخولًا عاديًا قبل أن يعيّن صاحبه كلمته:
  1. `POST /v1/auth/recovery/complete` بـ `{reset_token, new_password}`؛
  2. ثم `POST /v1/auth/totp/confirm` بـ `{totp_code}` بالجلسة المقيّدة التي يعيدها الأول؛
  3. ثم دخول عادي.
- ثم حسابات العمل، وحسابات القبول التي تحتاجها الحزمة (`reporter` و`reporter_b` و`supervisor_b` على الأقل).
- لا يُكتب في القاعدة يدويًا.

**التحقق:** مديرا نظام فاعلان (قاعدة الإطلاق في `runbook.md` §1)، وكل إنشاء له سطر `user.created` في التدقيق، وكل صاحب حساب دخل دخولًا عاديًا بعد تعيين كلمته.

## الخطوة 7 — أول نافذة قبول (ADR 0022)

على المضيف:

```bash
sudo infra/field-trial/qa-window.sh open --email <بريد حساب reporter للقبول> --hours 24
```

- يطبع `FT_INGEST_KID` ومسار المفتاح الخاص للنافذة.
- ينقل المختبِر المفتاح عبر ssh إلى جهازه، ولا يضعه في المستودع.
- ثم يتحقق الفحص:
  ```bash
  sudo infra/field-trial/preflight.sh --running --qa-window
  ```

على جهاز المختبِر، من نسخة المستودع (`tools/acceptance`، بعد `npm ci`):

```bash
FT_ACCOUNTS='<JSON الحسابات>' FT_TUS_URL=https://<نطاق ingest>/files/ \
FT_INGEST_KID=<qa-…> FT_INGEST_SIGNING_KEY=<مسار المفتاح المنقول> \
  node run.mjs --target https://<النطاق الرئيسي> --confirm --out-dir=<مجلد النتائج>
```

ثم على المضيف، ولو فشلت الحزمة:

```bash
sudo infra/field-trial/qa-window.sh close
```

ويحذف المختبِر نسخته من المفتاح.

**التحقق:**
- `preflight.sh` بلا `--qa-window` يعود بلا FAIL، فالخانة أُغلقت.
- `healthcheck.sh` ينبّه إن بقيت بعد انتهائها.
- نتائج الحزمة تُرفع إلى `docs/measurements/acceptance/`.

## الخطوة 8 — التحديث والتراجع

```bash
sudo infra/deploy/update.sh                 # آخر main
sudo infra/deploy/update.sh --ref <tag>     # إصدار محدد، أو العودة إلى إصدار سابق
```

1. نسخة مشفّرة أولًا.
2. ثم سحب الكود والصور.
3. ثم إعادة تشغيل متدرجة بفحص صحة بعد كل مرحلة.
4. وعند الفشل عودة آلية إلى الإيداع السابق.

التراجع يعيد الكود لا المخطط. إن لزم المخطط، فالاستعادة من نسخة الخطوة الأولى (الخطوة 5).

**التحقق:** `update.sh` ينتهي بـ `preflight.sh --running` بلا FAIL. خطته مثبتة في `test-dry-run.sh` (update plan).

## بعد إعادة الإقلاع

وحدة `post-history-trial` تفك الأسرار إلى tmpfs وتشغّل البيئة. نافذة القبول المفتوحة تُغلق بإعادة الإقلاع، لأن الملف المختوم لا يحملها.

**التحقق:** `systemctl status post-history-trial`، ثم `curl -s http://127.0.0.1:9180/health` يعيد 200.
