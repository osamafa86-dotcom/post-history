# netlab

محاكي شبكة متقطعة وأداة قياس. يملكه وكيل الرفع والبنية. القرار: ADR 0005 (toxiproxy).

## المكوّنات

| الملف | الغرض |
| --- | --- |
| `scenarios/*.yaml` | السيناريوهات الثلاثة (`office`، `field-weak`، `field-switch`) |
| `compose.netlab.yml` | طبقة فوق compose الأساسي: toxiproxy أمام `tusd-proxy`، وبديل خطّاف `api` على شبكة `hooks` |
| `hook_stub.py` | بديل نقطة الخطّاف (SEC-06) إلى أن يوجد الخادم: يقارن الرمز ويقبل كل رفع |
| `netlab.py` | عميل tus يرفع عبر السيناريو ويكتب النتيجة بمخطط `contracts/schemas/measurement.json` |

## التشغيل

```bash
cd infra/compose && cp .env.example .env
sed -i "s/^TUSD_HOOK_SECRET=.*/TUSD_HOOK_SECRET=$(openssl rand -hex 32)/" .env
docker compose -f docker-compose.yml -f ../../tools/netlab/compose.netlab.yml up -d --wait
cd ../..
python3 tools/netlab/netlab.py run --scenario office --size-mb 500 \
  --out docs/measurements/netlab/$(date +%F)-tusd-office-500mb.json
```

الخيارات: `--chunk-mb` (حجم طلب PATCH، 4 افتراضيًا)، `--max-seconds` (حد زمني؛ إن انتهى قبل الاكتمال فالنتيجة `partial`)، `--file` (ملف اصطناعي موجود). الملف الاصطناعي يُولَّد عشوائيًا في `--workdir` ولا يُرفع إلى المستودع.

## ما يُقاس (`metrics`)

- `longest_connected_window_s`: أطول مدة من أول طلب ناجح إلى الفشل التالي، كما يراها العميل.
- `part_time_s_p50/p90/max` و`part_times_s`: زمن كل PATCH ناجح؛ `parts_failed` للمحاولات المقطوعة (tusd يحفظ ما وصل منها).
- `resumes`: مرات الاستئناف عبر `HEAD` بعد فشل؛ `connection_failures`.
- `checksum_match`: SHA-256 للأصل مقابل ما يعيده tusd (عبر `tusd-proxy` بلا محاكاة).

## حدود معروفة

- toxiproxy لا يحاكي فقد الحزم: `field-weak` يُسجَّل بـ `loss_pct: 0` والهدف 30% في `notes`.
- القياس من عميل اصطناعي على الخادم نفسه، لا من هاتف.

## هاتف فعلي

منافذ compose مربوطة بـ `127.0.0.1`. لاختبار الرفع من هاتف على الشبكة المحلية استخدم `docker-compose.override.yml` (غير مرفوع) يفتح منفذ `tusd-proxy` (أو منفذ سيناريو في toxiproxy) وحده على واجهة الشبكة، ولا تعدّل الملف الأساسي إلى `0.0.0.0`. tusd نفسه بلا منفذ منشور.
